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
} from './PipelexApiShapes';

// A valid key passes the credential test (`/v1/auth/verify` accepts any valid
// token) but can still 403 on a real run: the run / build / methods surface is
// gated per ACCOUNT, not per key. For an API-key-authenticated request the
// platform requires the account's API access to be enabled
// (`require_surface_access` in `platform/deps.py`, which fails closed), and the
// credential test does not check it. There is deliberately NO per-key scope
// system — an earlier version of this message named a `runs:execute` scope that
// does not exist and sent users hunting for it.
// It is deliberately NOT phrased as a self-service fix: API access is a
// server-side account flag the user cannot toggle in the webapp, so telling them
// to "enable it and retry" would be a dead end. Point them at support instead.
export const FORBIDDEN_MESSAGE =
	'Pipelex refused this run (HTTP 403). Access to the run API is granted per account, not per key, so a valid key can still be refused — the credential test only checks that the token is valid. This is not a setting you can switch on yourself: ask Pipelex to enable API access for your account (https://go.pipelex.com/discord).';

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

// A completed run ALWAYS delivers a main stuff (the pipelex >= 0.37 invariant;
// `@pipelex/sdk` raises `MissingMainStuffError` for the same case). Emitting a
// bare `{ status: "COMPLETED" }` item would push the failure downstream, where a
// later node breaks on a missing field far from the cause.
//
// But a 200 with a null `main_stuff` is NOT necessarily terminal. The platform
// documents it as possibly transient: the results route flips to COMPLETED as
// soon as the run row says so, then relays whatever is in S3 — "missing files
// come back `null`; the run may be partial mid-write"
// (`platform/routers/v1/runs.py`, `_fetch_run_result_artifacts`). So a poll can
// legitimately land in the window between COMPLETED and `main_stuff.json`
// existing.
//
// Hence two messages: the poll loop RETRIES this (bounded), and only a state
// that persists past the ceiling is reported as the broken invariant. A library
// caller can catch-and-retry the SDK's `MissingMainStuffError`; an n8n item
// cannot, so the retry has to live here.
export const MISSING_MAIN_STUFF_MESSAGE =
	'The run completed but never delivered its output (main_stuff), even after waiting for the result to finish being written. A completed run always delivers a main output, so this is a server-side result-assembly problem rather than a workflow error — report this run id to Pipelex support.';

/** The transient reading of the same response, used while the poll loop retries. */
export const RESULT_MID_WRITE_MESSAGE =
	'The run is complete but its result is still being written — fetch it again in a moment with this pipeline_run_id.';

/** Append the run id when the response body carries one, so the message is self-contained. */
export function withRunId(message: string, body: IDataObject): string {
	const runId = body.pipeline_run_id;
	return typeof runId === 'string' && runId.length > 0 ? `${message} (Run: ${runId})` : message;
}

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
	/** Method bundle as `{ relativePath: text }` — carries custom PipeFunc Python. */
	files?: Record<string, string>;
}

/**
 * Map the node's params to the `POST /v1/start` body, omitting empties.
 * Pure — unit-testable without the execute harness. Does NOT enforce the
 * run-source rules; that is {@link runSourceError}, called from the node so the
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
	if (params.files && Object.keys(params.files).length > 0) body.files = params.files;
	if (params.outputName) body.output_name = params.outputName;
	if (params.outputMultiplicity) body.output_multiplicity = params.outputMultiplicity;
	if (params.dynamicOutputConceptRef) {
		body.dynamic_output_concept_ref = params.dynamicOutputConceptRef;
	}
	return body;
}

/**
 * Reject a bundle entry path the runner would reject anyway, but locally and
 * item-scoped. Mirrors `_safe_relpath` in `pipelex-api/api/bundle.py`: no
 * absolute paths, no `..` traversal, no backslashes, no `:` (a Windows
 * drive/stream form). Returns a message, or `null` when the path is fine.
 */
export function bundleEntryPathError(path: string): string | null {
	if (path.includes('\\')) {
		return `Bundle path "${path}" uses backslashes — use forward-slash relative paths (e.g. "funcs/score.py").`;
	}
	if (path.includes(':')) {
		return `Bundle path "${path}" contains ":" — use a plain relative path (e.g. "funcs/score.py").`;
	}
	if (path.startsWith('/')) {
		return `Bundle path "${path}" is absolute — use a path relative to the bundle root (e.g. "funcs/score.py").`;
	}
	if (path.split('/').some((part) => part === '..')) {
		return `Bundle path "${path}" escapes the bundle root via "..".`;
	}
	return null;
}

/** What {@link assembleRunSources} produced: the run sources, or the reason it can't. */
export interface AssembledRunSources {
	/** Inline bundle contents to send as `mthds_contents` — emptied when folded into `files`. */
	mthdsContents: string[];
	/** The assembled method bundle, or undefined when there is none. */
	files?: Record<string, string>;
	/** Set when the combination is unusable; the node turns it into an item-scoped error. */
	error?: string;
}

/** Deterministic names for inline bundle contents folded into a `files` map. */
function inlineBundleName(index: number, taken: Set<string>): string {
	let name = index === 0 ? 'main.mthds' : `bundle-${index + 1}.mthds`;
	let suffix = index + 1;
	while (taken.has(name)) {
		suffix += 1;
		name = `bundle-${suffix}.mthds`;
	}
	return name;
}

/**
 * Turn the pasted method + its Python files into the run source to send.
 *
 * The node offers exactly two ways to say what to run:
 *   1. **Method ID** — a stored method, which already carries its own Python.
 *   2. **MTHDS Bundles + Python Files** — the method pasted inline, plus the
 *      `funcs/*.py` / `structures/*.py` / `requirements.txt` it needs.
 *
 * Without Python, (2) is just `mthds_contents` and nothing happens here. With
 * Python it has to become a `files` bundle, because `files` is the only transport
 * that can carry `.py` — and the protocol makes a bundle mutually exclusive with
 * `mthds_contents`, since a bundle carries its own `.mthds`. Taken literally that
 * would make "paste my method, attach my Python" impossible.
 *
 * So the pasted contents are folded INTO the bundle as generated `.mthds`
 * entries and `files` is sent alone. That is exactly what the server does with
 * any bundle anyway: `pipelex-api`'s run path splits the `.mthds` entries back
 * out into `mthds_contents` and materializes only the rest as a library
 * directory. Same request, same run — the assembly just removes a manual step.
 *
 * Pure, so the whole matrix is unit-testable.
 */
export function assembleRunSources(params: {
	mthdsContents: string[];
	pythonFiles: Record<string, string>;
}): AssembledRunSources {
	const { mthdsContents, pythonFiles } = params;

	const pythonPaths = Object.keys(pythonFiles);
	if (pythonPaths.length === 0) {
		return { mthdsContents };
	}

	for (const path of pythonPaths) {
		const pathError = bundleEntryPathError(path);
		if (pathError) return { mthdsContents, error: pathError };
	}

	// Python is not a method. It can only ride along with a pasted one — a stored
	// method (Method ID) already carries its own Python, and there is no way to
	// graft extra files onto it.
	if (mthdsContents.length === 0) {
		return {
			mthdsContents,
			error:
				'Python Files needs the method it belongs to: paste it into "MTHDS Bundles" and the two are sent together. (A stored method used via "Method ID" already carries its own Python.)',
		};
	}

	const taken = new Set(pythonPaths);
	const files: Record<string, string> = {};
	mthdsContents.forEach((content, index) => {
		const name = inlineBundleName(index, taken);
		taken.add(name);
		files[name] = content;
	});

	// The pasted contents now travel inside the bundle, so they must NOT also be
	// sent as `mthds_contents` — that is exactly what the protocol forbids.
	return { mthdsContents: [], files: { ...files, ...pythonFiles } };
}

/**
 * Last-line check on the BUILT body: it must name something to run, and must
 * never carry a bundle beside `mthds_contents`.
 *
 * The exclusivity half replicates `mthds/protocol`'s `assertExclusiveRunSources`
 * and should be unreachable in practice — `assembleRunSources` folds the pasted
 * contents INTO the bundle precisely so the two never travel together. It stays
 * as a backstop, because getting it wrong means sending the method twice and an
 * opaque server 422.
 *
 * `method_id` is refused alongside a pasted method. The hosted API would accept
 * the combination (it runs the inline method and records `method_id` as the
 * run-history linkage), but two run sources in one node means "what is this
 * running?" has no single answer in the editor, so the node treats it as a
 * mistake. The node-level check fires first with a message about the toggle; this
 * is the backstop.
 *
 * Returned rather than thrown so it stays pure; the node turns it into a
 * `NodeOperationError` with an `itemIndex`.
 */
export function runSourceError(body: HostedStartBody): string | null {
	const hasFiles = body.files !== undefined;
	const hasContents = body.mthds_contents !== undefined && body.mthds_contents.length > 0;

	if (hasFiles && hasContents) {
		return 'Internal: a method bundle cannot be sent together with mthds_contents. This is a bug in the node — please report it.';
	}
	if (body.method_id && (hasFiles || hasContents)) {
		return 'Choose one: a stored method ("Method ID") or an inline one ("Define Method Inline"), not both.';
	}
	if (!hasContents && !hasFiles && !body.method_id && !body.pipe_code) {
		return 'Nothing to run: paste your method into "MTHDS Bundles", or set a "Method ID" to run a stored method.';
	}
	return null;
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
	// A 200 whose `main_stuff` is absent/null. NON-TERMINAL: the result may still
	// be mid-write (see MISSING_MAIN_STUFF_MESSAGE). The poll loop retries this,
	// bounded; only a persisting state is reported as the broken invariant, and a
	// single-shot fetch reports it as "still being written".
	| { kind: 'missingMainStuff'; retryAfterSeconds: number; body: IDataObject }
	// `degraded` is true when the running signal came from a 503 (transient
	// outage) rather than a 202 (normal in-flight). The poll loop keeps polling
	// either way, but only counts `degraded` responses toward the
	// consecutive-503 ceiling (see SERVICE_UNAVAILABLE_MESSAGE).
	| { kind: 'running'; retryAfterSeconds: number; degraded: boolean }
	| { kind: 'failed'; message: string; body: IDataObject }
	| { kind: 'forbidden'; message: string; body: IDataObject }
	| { kind: 'notFound'; message: string; body: IDataObject }
	| { kind: 'unexpected'; statusCode: number; message: string; body: IDataObject };

/**
 * Lead with our actionable guidance, then append what the server actually said.
 * The platform's `problem+json` detail is accurate but written for an API
 * consumer (it names internal feature flags), so it reads as a supporting fact
 * rather than the headline.
 */
function withServerDetail(message: string, body: IDataObject): string {
	const detail = extractProblemDetail(body);
	return detail ? `${message} (Server: ${detail})` : message;
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
 * Map a `GET /v1/runs/{pipeline_run_id}/results` response to a meaning.
 * Pure function — the core of the poll loop and the Get Run Result op.
 *
 * Mirrors `@pipelex/sdk` `client.ts` `getRunResult` (the SDK that owns this
 * lifecycle), verified against `pipelex-platform/.../routers/v1/runs.py`:
 *   200 → completed (body has main_stuff + graph_spec + working_memory +
 *         tokens_usages) — UNLESS `main_stuff` is absent, which breaks the
 *         completed-run invariant and maps to `missingMainStuff` (the SDK's
 *         `MissingMainStuffError`)
 *   202 → running (+ `Retry-After`, default 5s when absent); the server signals
 *         in-flight — including degraded Temporal reads — only via 202
 *   503 → running too, but flagged `degraded` (transient gateway/backend blip
 *         mid-poll — retry, never fail a poller; the loop bounds CONSECUTIVE
 *         503s via SERVICE_UNAVAILABLE_MESSAGE on top of the caller's Max Wait)
 *   409 → failed: terminal non-COMPLETED (FAILED / CANCELLED / TERMINATED /
 *         TIMED_OUT), with the status in the problem detail
 *   404 → not found: bad/expired pipeline_run_id, or a Base URL with no run
 *         lifecycle (actionable; see NOT_FOUND_MESSAGE)
 *   403 → account API access not enabled (actionable; see FORBIDDEN_MESSAGE)
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
			// `main_stuff` may legitimately be falsy (`[]`, `0`, `""`) — test for
			// absence only, never truthiness, or a valid empty-list output would be
			// misreported as a broken run.
			if (body.main_stuff === undefined || body.main_stuff === null) {
				return {
					kind: 'missingMainStuff',
					// A 200 carries no `Retry-After` (the header rides the 202/degraded
					// path), so fall back to the same default backoff.
					retryAfterSeconds: parseRetryAfter(headers) ?? DEFAULT_DEGRADED_RETRY_SECONDS,
					body,
				};
			}
			return { kind: 'completed', body };
		case 403:
			return { kind: 'forbidden', message: withServerDetail(FORBIDDEN_MESSAGE, body), body };
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
			message: withServerDetail(FORBIDDEN_MESSAGE, responseBody),
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
