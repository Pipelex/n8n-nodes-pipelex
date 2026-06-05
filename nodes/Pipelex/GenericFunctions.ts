import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type IN8nHttpFullResponse,
	type JsonObject,
} from 'n8n-workflow';

const CREDENTIALS_NAME = 'piplexApi';

// A non-scoped key passes the credential test (`/auth/verify` accepts any valid
// token) but 403s on a real run. Turn that dead-end into an actionable message.
export const FORBIDDEN_MESSAGE =
	'This API key lacks runs access. Running a pipeline needs an admin / `runs:execute`-scoped key — the credential test only checks that the token is valid, not that it can start runs.';

/**
 * Body of `POST /platform/v1/runs`. Field names match the platform's
 * `CreateRunRequest` (snake_case) and are forwarded verbatim to the runner.
 */
export interface PipelexStartBody {
	inputs?: Record<string, unknown>;
	method_id?: string;
	pipe_code?: string;
	mthds_contents?: string[];
	output_name?: string;
	output_multiplicity?: string;
	dynamic_output_concept_ref?: string;
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
 * Map the node's params to the platform's `POST /runs` body, omitting empties.
 * Pure — unit-testable without the execute harness. Does NOT enforce the
 * pipe_code/mthds_contents XOR; that validation lives in the node so the error
 * carries an `itemIndex`.
 */
export function buildStartBody(params: BuildStartParams): PipelexStartBody {
	const body: PipelexStartBody = {};
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
 * different Start / Start & Poll nodes in the SAME execution processing the same
 * item would otherwise share a key and the platform would replay the first
 * node's run for the second (wrong `pipeline_run_id`, second pipeline never
 * starts). `nodeId` is unique per node within a workflow and stable across a
 * retry of the same execution, so it keeps replays correct without causing
 * cross-node collisions.
 */
export function idempotencyKey(executionId: string, nodeId: string, itemIndex: number): string {
	return `${executionId}:${nodeId}:${itemIndex}`;
}

/** Outcome of mapping a `GET …/result` response. The node turns these into
 * output items or `NodeApiError`s — keeping this a pure value makes the
 * status→meaning logic testable in isolation. */
export type ResultOutcome =
	| { kind: 'completed'; body: IDataObject }
	| { kind: 'running'; retryAfterSeconds?: number }
	// A gateway/backend unavailability (502/503/504) — NOT a documented in-flight
	// signal. The poll loop tolerates a bounded number of these then fails;
	// single-shot Get Result surfaces it as an error rather than "still running".
	| { kind: 'transient'; statusCode: number; retryAfterSeconds?: number }
	| { kind: 'failed'; message: string; body: IDataObject }
	| { kind: 'forbidden'; message: string; body: IDataObject }
	| { kind: 'unexpected'; statusCode: number; message: string; body: IDataObject };

export const SERVICE_UNAVAILABLE_MESSAGE =
	'The Pipelex result endpoint is repeatedly unavailable (gateway 5xx). The run may still be progressing — retry later with "Poll for Result" or "Get Result" using the pipeline_run_id.';

function parseRetryAfter(headers: IDataObject): number | undefined {
	// n8n/axios lowercases header keys, but tolerate either casing.
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (raw === undefined || raw === null) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function extractProblemDetail(body: IDataObject): string | undefined {
	// Platform errors are RFC 9457 problem+json: prefer `detail`, then `title`.
	const detail = body.detail;
	if (typeof detail === 'string' && detail.length > 0) return detail;
	const title = body.title;
	if (typeof title === 'string' && title.length > 0) return title;
	return undefined;
}

/**
 * Map a `GET /platform/v1/runs/by-id/{id}/result` response to a meaning.
 * Pure function — the core of the poll loop and the Get Run Result op.
 *
 * Contract (verified against `pipelex-platform/.../routers/v1/runs.py`):
 *   200 → COMPLETED (body has main_stuff + graph_spec)
 *   202 → still running (+ optional Retry-After); the result endpoint also
 *         returns 202 — not 503 — for degraded Temporal reads
 *   403 → unscoped key (actionable; see FORBIDDEN_MESSAGE)
 *   409 → terminal non-COMPLETED (FAILED / CANCELLED / TERMINATED / TIMED_OUT)
 *   502/503/504 → `transient` (gateway/backend unavailable). The result contract
 *         signals in-flight ONLY via 202 (degraded Temporal reads included), so a
 *         5xx is a real outage, never "still running". The poll loop retries a
 *         bounded number of these before failing (so an outage can't hang an
 *         unbounded poll forever); Get Result surfaces it as an error.
 *   other → unexpected (→ NodeApiError)
 */
export function mapResultResponse(
	statusCode: number,
	body: IDataObject,
	headers: IDataObject,
): ResultOutcome {
	switch (statusCode) {
		case 200:
			return { kind: 'completed', body };
		case 202:
			return { kind: 'running', retryAfterSeconds: parseRetryAfter(headers) };
		case 502:
		case 503:
		case 504:
			return { kind: 'transient', statusCode, retryAfterSeconds: parseRetryAfter(headers) };
		case 403:
			return { kind: 'forbidden', message: FORBIDDEN_MESSAGE, body };
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
 * `POST /platform/v1/runs` with an `Idempotency-Key`. Returns the full response
 * so the caller can read the status code. A 403 is translated to an actionable
 * error; a non-2xx otherwise surfaces as a `NodeApiError`.
 */
export async function requestStart(
	ctx: IExecuteFunctions,
	baseUrl: string,
	body: PipelexStartBody,
	idempotency: string,
	itemIndex: number,
): Promise<IDataObject> {
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS_NAME, {
		method: 'POST' as IHttpRequestMethods,
		url: `${baseUrl}/platform/v1/runs`,
		headers: { 'Idempotency-Key': idempotency },
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
	return responseBody;
}

/**
 * `GET /platform/v1/runs/by-id/{run_id}/result`. Returns the full response
 * (status + headers + body) so the caller maps it via `mapResultResponse`.
 */
export async function requestResult(
	ctx: IExecuteFunctions,
	baseUrl: string,
	runId: string,
): Promise<IN8nHttpFullResponse> {
	return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS_NAME, {
		method: 'GET' as IHttpRequestMethods,
		url: `${baseUrl}/platform/v1/runs/by-id/${encodeURIComponent(runId)}/result`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;
}

// The Pipelex public API gateway closes synchronous requests at ~30s. A failure
// at/after this threshold on the blocking execute IS that timeout — not a
// transient outage — so we translate it into an actionable message rather than a
// raw 5xx. (Self-hosted servers without that cap simply never hit this branch.)
export const GATEWAY_TIMEOUT_THRESHOLD_MS = 28_000;
export const EXECUTE_TIMEOUT_MESSAGE =
	'The blocking Execute call exceeded the Pipelex public API’s ~30s limit. For long-running pipelines, use the "Start & Poll" operation (or "Start" then "Poll for Result"), which polls a durable run instead of holding one request open.';

function isGatewayTimeoutStatus(statusCode: number): boolean {
	return statusCode === 408 || statusCode === 503 || statusCode === 504;
}

/**
 * `POST /runner/v1/pipeline/execute` — the **blocking, one-shot** execute. Holds
 * the request open until the runner returns the pipe output, and returns that
 * body verbatim. On the public API a run that outlives the ~30s gateway ceiling
 * surfaces as a gateway 5xx or a socket abort; either is translated to
 * `EXECUTE_TIMEOUT_MESSAGE` pointing at the durable Start/Poll path.
 */
export async function requestExecute(
	ctx: IExecuteFunctions,
	baseUrl: string,
	body: PipelexStartBody,
	itemIndex: number,
): Promise<IDataObject> {
	const startedAt = Date.now();
	let response: IN8nHttpFullResponse;
	try {
		response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS_NAME, {
			method: 'POST' as IHttpRequestMethods,
			url: `${baseUrl}/runner/v1/pipeline/execute`,
			body,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		})) as IN8nHttpFullResponse;
	} catch (error) {
		// A socket-level abort/timeout never carries a status code. If it landed
		// around the gateway ceiling, report it as the execute timeout.
		const elapsedMs = Date.now() - startedAt;
		const message = elapsedMs >= GATEWAY_TIMEOUT_THRESHOLD_MS ? EXECUTE_TIMEOUT_MESSAGE : undefined;
		throw new NodeApiError(ctx.getNode(), error as JsonObject, { message, itemIndex });
	}

	const elapsedMs = Date.now() - startedAt;
	const responseBody = (response.body ?? {}) as IDataObject;
	if (response.statusCode >= 200 && response.statusCode < 300) {
		return responseBody;
	}
	if (isGatewayTimeoutStatus(response.statusCode) && elapsedMs >= GATEWAY_TIMEOUT_THRESHOLD_MS) {
		throw new NodeApiError(ctx.getNode(), responseBody as JsonObject, {
			message: EXECUTE_TIMEOUT_MESSAGE,
			httpCode: String(response.statusCode),
			itemIndex,
		});
	}
	const detail = extractProblemDetail(responseBody) ?? 'Pipeline execution failed';
	throw new NodeApiError(ctx.getNode(), responseBody as JsonObject, {
		message: detail,
		httpCode: String(response.statusCode),
		itemIndex,
	});
}

/**
 * Read an item's binary property and return it as a base64 `data:` URL. Uses the
 * n8n binary helpers (`assertBinaryData` + `getBinaryDataBuffer`), which resolve
 * on-disk (filesystem-mode) binary — something a `{{ }}` expression cannot do.
 * The MIME type comes from the binary metadata.
 */
export async function binaryToDataUrl(
	ctx: IExecuteFunctions,
	itemIndex: number,
	binaryProperty: string,
): Promise<string> {
	const meta = ctx.helpers.assertBinaryData(itemIndex, binaryProperty);
	const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryProperty);
	const mimeType = meta.mimeType || 'application/octet-stream';
	return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Assemble the `inputs` object for a binary-sourced Document/Image input:
 * `{ [inputName]: { concept, content: [{ url }, …] } }`. The platform decodes the
 * data URLs and stores them; a list of URLs is treated as a `Document[]`.
 */
export function buildBinaryInputs(
	inputName: string,
	concept: string,
	urls: string[],
): Record<string, unknown> {
	return {
		[inputName]: {
			concept,
			content: urls.map((url) => ({ url })),
		},
	};
}
