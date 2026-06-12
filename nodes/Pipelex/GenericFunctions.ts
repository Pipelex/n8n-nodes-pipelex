import {
	NodeApiError,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type IN8nHttpFullResponse,
	type JsonObject,
} from 'n8n-workflow';

import {
	DEFAULT_DEGRADED_RETRY_SECONDS,
	parseRetryAfter,
	type HostedStartBody,
	type StartAck,
} from './MthdsShapes';

// A non-scoped key passes the credential test (`/v1/auth/verify` accepts any
// valid token) but 403s on a real run. Turn that dead-end into an actionable
// message.
export const FORBIDDEN_MESSAGE =
	'This API key lacks runs access. Running a pipeline needs an admin / `runs:execute`-scoped key — the credential test only checks that the token is valid, not that it can start runs.';

// A 404 on the results endpoint is overloaded: either the pipeline_run_id is
// wrong/expired (the common case), or the credential Base URL points at a
// runner that has no durable run lifecycle (e.g. a bare/self-hosted
// pipelex-api) — the contract's RunLifecycleUnavailableError case. The node is
// hosted-only by design and deliberately skips the /v1/version handshake, so a
// single message naming both real causes is the actionable middle ground.
export const NOT_FOUND_MESSAGE =
	'Run not found. Check the pipeline_run_id is correct and not expired — or, if you changed the credential Base URL, it may point at a runner that does not expose the durable run lifecycle (point it at the hosted Pipelex API).';

// A 503 mid-poll is treated as "still running" (a transient gateway/backend blip
// must not lose a poller — mirrors mthds-js). But a backend that is genuinely
// down returns 503 indefinitely; without a ceiling, an unbounded poll
// (maxWaitSeconds: 0) would spin until the n8n execution itself times out. The
// poll loop counts CONSECUTIVE 503s (a healthy run polls with 202s, which reset
// the counter) and surfaces this message once the ceiling trips, so an outage
// becomes an actionable failure instead of a silent hang.
export const SERVICE_UNAVAILABLE_MESSAGE =
	'The Pipelex API was unavailable (HTTP 503) for several consecutive polls — the backend appears down. The run may still finish later.';

/**
 * Resolved connection to the Pipelex API — the credential, read once per
 * execution and turned into ready-to-send request pieces.
 *
 * Auth is a manually-built `Authorization` header (NOT n8n's
 * `httpRequestWithAuthentication`), on purpose: a credential with a generic
 * `authenticate` block makes n8n inject a "Custom API Call" entry into the
 * node's Operation dropdown (core `injectCustomApiCallOptions` /
 * `supportsProxyAuth`), which is unwanted for this node's curated operations.
 * The credential therefore declares no `authenticate`, and every request here
 * carries the header explicitly.
 */
export interface ApiConnection {
	/** Credential Base URL, trailing slash stripped. */
	baseUrl: string;
	/** Full `Authorization` header value (`Bearer <token>`). */
	authorization: string;
}

/** Build the {@link ApiConnection} from the decrypted `piplexApi` credential. */
export function buildApiConnection(credentials: ICredentialDataDecryptedObject): ApiConnection {
	return {
		baseUrl: String(credentials.baseUrl ?? '').replace(/\/$/, ''),
		authorization: `Bearer ${String(credentials.apiKey ?? '')}`,
	};
}

/** User-facing params collected by the node, before snake_case mapping. */
export interface BuildStartParams {
	pipeCode?: string;
	methodId?: string;
	mthdsContents?: string[];
	inputs?: Record<string, unknown>;
	outputName?: string;
	outputMultiplicity?: string;
	dynamicOutputConceptRef?: string;
}

/**
 * Map the node's params to the `POST /v1/start` body, omitting empties.
 * Pure — unit-testable without the execute harness. Does NOT enforce the
 * run-source rules (one of pipe_code/mthds_contents/method_id; method_id and
 * mthds_contents combinable — inline wins); run-source validation lives in the node so the
 * error carries an `itemIndex`.
 */
export function buildStartBody(params: BuildStartParams): HostedStartBody {
	const body: HostedStartBody = {};
	if (params.inputs !== undefined) body.inputs = params.inputs;
	if (params.methodId) body.method_id = params.methodId;
	if (params.pipeCode) body.pipe_code = params.pipeCode;
	if (params.mthdsContents && params.mthdsContents.length > 0) {
		body.mthds_contents = params.mthdsContents;
	}
	if (params.outputName) body.output_name = params.outputName;
	if (params.outputMultiplicity) body.output_multiplicity = params.outputMultiplicity;
	if (params.dynamicOutputConceptRef) {
		body.dynamic_output_concept_ref = params.dynamicOutputConceptRef;
	}
	return body;
}

/**
 * Stable idempotency key for a single run. n8n's "Retry On Fail" replays the
 * whole item; a lost response on a created run would otherwise spawn a
 * duplicate paid run. The platform honors `Idempotency-Key` (opt-in via header,
 * `middleware/idempotency.py`) and replays the original run for a repeat key.
 *
 * The key is scoped by `nodeId` as well as the execution + item index: two
 * different Pipelex nodes in the SAME execution processing the same item would
 * otherwise share a key and the platform would replay the first node's run for
 * the second (wrong `pipeline_run_id`, second pipeline never starts). `nodeId`
 * is unique per node within a workflow and stable across a retry of the same
 * execution, so it keeps replays correct without causing cross-node collisions.
 */
export function idempotencyKey(executionId: string, nodeId: string, itemIndex: number): string {
	return `${executionId}:${nodeId}:${itemIndex}`;
}

/** Outcome of mapping a `GET /v1/runs/{pipeline_run_id}/results` response. The
 * node turns these into output items or `NodeApiError`s — keeping this a pure
 * value makes the status→meaning logic testable in isolation. */
export type ResultOutcome =
	| { kind: 'completed'; body: IDataObject }
	// `degraded` is true when the running signal came from a 503 (transient
	// outage) rather than a 202 (normal in-flight). The poll loop keeps polling
	// either way, but only counts `degraded` responses toward the
	// consecutive-503 ceiling (see SERVICE_UNAVAILABLE_MESSAGE).
	| { kind: 'running'; retryAfterSeconds: number; degraded: boolean }
	| { kind: 'failed'; message: string; body: IDataObject }
	| { kind: 'forbidden'; message: string; body: IDataObject }
	| { kind: 'notFound'; message: string; body: IDataObject }
	| { kind: 'unexpected'; statusCode: number; message: string; body: IDataObject };

function extractProblemDetail(body: IDataObject): string | undefined {
	// Platform errors are RFC 9457 problem+json: prefer `detail`, then `title`.
	const detail = body.detail;
	if (typeof detail === 'string' && detail.length > 0) return detail;
	const title = body.title;
	if (typeof title === 'string' && title.length > 0) return title;
	return undefined;
}

/**
 * Map a `GET /v1/runs/{pipeline_run_id}/results` response to a meaning.
 * Pure function — the core of the poll loop and the Get Run Result op.
 *
 * Mirrors mthds-js `client.ts` `getRunResult` (the SDK shipping the same
 * lifecycle), verified against `pipelex-platform/.../routers/v1/runs.py`:
 *   200 → completed (body has main_stuff + graph_spec)
 *   202 → running (+ `Retry-After`, default 5s when absent); the server signals
 *         in-flight — including degraded Temporal reads — only via 202
 *   503 → running too, but flagged `degraded` (transient gateway/backend blip
 *         mid-poll — retry, never fail a poller; the loop bounds CONSECUTIVE
 *         503s via SERVICE_UNAVAILABLE_MESSAGE on top of the caller's Max Wait)
 *   409 → failed: terminal non-COMPLETED (FAILED / CANCELLED / TERMINATED /
 *         TIMED_OUT), with the status in the problem detail
 *   404 → not found: bad/expired pipeline_run_id, or a Base URL with no run
 *         lifecycle (actionable; see NOT_FOUND_MESSAGE)
 *   403 → unscoped key (actionable; see FORBIDDEN_MESSAGE)
 *   other → unexpected (→ NodeApiError)
 */
export function mapResultResponse(
	statusCode: number,
	body: IDataObject,
	headers: IDataObject,
): ResultOutcome {
	if (statusCode === 202 || statusCode === 503) {
		return {
			kind: 'running',
			retryAfterSeconds: parseRetryAfter(headers) ?? DEFAULT_DEGRADED_RETRY_SECONDS,
			degraded: statusCode === 503,
		};
	}
	switch (statusCode) {
		case 200:
			return { kind: 'completed', body };
		case 403:
			return { kind: 'forbidden', message: FORBIDDEN_MESSAGE, body };
		case 404:
			return { kind: 'notFound', message: NOT_FOUND_MESSAGE, body };
		case 409:
			return {
				kind: 'failed',
				message: extractProblemDetail(body) ?? 'Run finished with a non-completed status',
				body,
			};
		default:
			return {
				kind: 'unexpected',
				statusCode,
				message: extractProblemDetail(body) ?? `Unexpected response status ${statusCode}`,
				body,
			};
	}
}

/**
 * `POST /v1/start` with an `Idempotency-Key` — answers `202 StartAck`
 * (`{ pipeline_run_id, state, created_at }`; the id is server-generated and
 * authoritative). A 403 is translated to an actionable error; a non-2xx
 * otherwise surfaces as a `NodeApiError` with the problem detail.
 */
export async function requestStart(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	body: HostedStartBody,
	idempotency: string,
	itemIndex: number,
): Promise<StartAck> {
	const response = (await ctx.helpers.httpRequest({
		method: 'POST' as IHttpRequestMethods,
		url: `${conn.baseUrl}/v1/start`,
		headers: { Authorization: conn.authorization, 'Idempotency-Key': idempotency },
		body,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;

	const responseBody = (response.body ?? {}) as IDataObject;
	if (response.statusCode === 403) {
		throw new NodeApiError(ctx.getNode(), responseBody as JsonObject, {
			message: FORBIDDEN_MESSAGE,
			httpCode: '403',
			itemIndex,
		});
	}
	if (response.statusCode < 200 || response.statusCode >= 300) {
		const detail = extractProblemDetail(responseBody) ?? 'Failed to start run';
		throw new NodeApiError(ctx.getNode(), responseBody as JsonObject, {
			message: detail,
			httpCode: String(response.statusCode),
			itemIndex,
		});
	}
	return responseBody as unknown as StartAck;
}

/**
 * `GET /v1/runs/{pipeline_run_id}/results`. Returns the full response
 * (status + headers + body) so the caller maps it via `mapResultResponse`.
 */
export async function requestResult(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	runId: string,
): Promise<IN8nHttpFullResponse> {
	return (await ctx.helpers.httpRequest({
		method: 'GET' as IHttpRequestMethods,
		url: `${conn.baseUrl}/v1/runs/${encodeURIComponent(runId)}/results`,
		headers: { Authorization: conn.authorization },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;
}
