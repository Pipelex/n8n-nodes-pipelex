import { createHash } from 'crypto';

import {
	NodeApiError,
	NodeOperationError,
	sleep,
	type IBinaryData,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type IN8nHttpFullResponse,
	type JsonObject,
} from 'n8n-workflow';

import {
	DEFAULT_CONTENT_TYPE,
	DEFAULT_DEGRADED_RETRY_SECONDS,
	MAX_UPLOAD_BYTES,
	PIPELEX_STORAGE_SCHEME,
	extensionForContentType,
	guessContentType,
	parseRetryAfter,
	uploadTimeoutMs,
	type HostedStartBody,
	type StartAck,
	type StoredFileInput,
	type UploadGrant,
	type UploadGrantRequest,
} from './PipelexApiShapes';
import { USER_AGENT } from './UserAgent';

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

/**
 * Sleep `ms`, rejecting if `signal` aborts (an n8n execution cancelled mid-poll).
 *
 * Built on n8n-workflow's `sleep`, NOT its `sleepWithAbort`. Both exist in
 * n8n-workflow 1.x, but `sleepWithAbort` was **removed in 2.x** while `sleep`
 * survived. `n8n-workflow` is a `peerDependency` (`"*"`) satisfied by whatever
 * version the host n8n ships, so importing the abortable one compiled fine
 * against the 1.x in this repo's dev tree and then threw
 * `sleepWithAbort is not a function` at runtime on any n8n carrying
 * n8n-workflow 2 — i.e. on every poll of a current n8n. See
 * `test/WireContract.test.ts` for the allowlist that now guards this.
 *
 * The abort half is layered here rather than owned outright because a community
 * node may not use a timer at all: `@n8n/community-nodes/no-restricted-globals`
 * bans `setTimeout` (along with `process`, `__dirname`, and friends) and
 * `no-restricted-imports` bans `node:timers/promises`, since n8n Cloud runs
 * community nodes without dependencies. Racing the host's `sleep` against the
 * signal needs no timer of our own.
 */
export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortReason(signal);
	if (ms <= 0) return;
	if (!signal) {
		await sleep(ms);
		return;
	}
	// The losing `sleep` stays pending until its own delay elapses; it holds no
	// resource beyond that one timer, which the host owns.
	await Promise.race([
		sleep(ms),
		new Promise<never>((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
		}),
	]);
}

/**
 * The error a cancelled sleep rejects with: the signal's own reason when it is an
 * Error (so a cancelled execution reports why), else a readable fallback.
 */
function abortReason(signal?: AbortSignal): Error {
	const reason: unknown = signal?.reason;
	return reason instanceof Error ? reason : new Error('The Pipelex run poll was cancelled.');
}

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

/**
 * The headers every request to the Pipelex API carries: the manual
 * `Authorization` and the client-identifying `User-Agent` (see `UserAgent.ts`).
 * Every request builds its headers here, so no request path can miss one;
 * request-specific headers (such as `Idempotency-Key`) are layered on top.
 */
export function apiHeaders(conn: ApiConnection, extra: IDataObject = {}): IDataObject {
	return { ...extra, Authorization: conn.authorization, 'User-Agent': USER_AGENT };
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
 *
 * **Binary inputs extend the rule.** When the body carries uploaded files, the
 * key also covers their references (`storedFiles`, one `input=reference` entry
 * each). A retry in the same execution reuses the references the first attempt
 * stored (`StoredUploads.ts`), so its key is the same and the platform replays
 * the first run. When a retry has to upload afresh instead — the file changed,
 * or this process no longer remembers the first upload — its references, and so
 * its body, differ, and the platform refuses a reused key whose body differs
 * with a `409` ("already used with a different request body",
 * `middleware/idempotency.py`). Folding the references into the key turns that
 * case into a new run rather than a failed item.
 */
export function idempotencyKey(
	executionId: string,
	nodeId: string,
	itemIndex: number,
	storedFiles: string[] = [],
): string {
	const key = `${executionId}:${nodeId}:${itemIndex}`;
	if (storedFiles.length === 0) return key;
	const digest = createHash('sha256')
		.update([...storedFiles].sort().join('\n'))
		.digest('hex')
		.slice(0, 32);
	return `${key}:files-${digest}`;
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
	| { kind: 'failed'; message: string; description?: string; data?: string; body: IDataObject }
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
		headers: apiHeaders(conn, { 'Idempotency-Key': idempotency }),
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
 * `GET /v1/runs/{pipeline_run_id}/status` — the light run read
 * (`RunPublic` + `degraded`), used to recover WHY a run failed.
 *
 * Deliberately the `/status` route and not `/runs/{id}`: both carry the stored
 * `error` report, but the latter also drags `mthds_contents` + `inputs` — the
 * run's whole source, tens of KB — which is pure waste when all we want is a
 * message.
 */
export async function requestRunStatus(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	runId: string,
): Promise<IN8nHttpFullResponse> {
	return (await ctx.helpers.httpRequest({
		method: 'GET' as IHttpRequestMethods,
		url: `${conn.baseUrl}/v1/runs/${encodeURIComponent(runId)}/status`,
		headers: apiHeaders(conn),
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;
}

/**
 * Turn a run read into the reason the run failed.
 *
 * The results route's 409 says only *"Run finished with status FAILED; no result
 * available"* — true, and useless. The actual cause (`PipeRunInputsError:
 * missing required inputs: illustrations`, and the like) is a separate stored
 * artifact: the runner posts it on the completion callback and the platform keeps
 * it as `error` on the run row (`RunPublic.error`, "surfaced so the webapp can
 * tell the user WHY a run failed instead of a generic message").
 *
 * So a failure needs a second read to be explicable, exactly as `pipelex-app`
 * does it (`use-method-runs.ts`: the terminal signal "carries only the terminal
 * status, not the reason", so it fetches the run and shows `error.message`).
 *
 * Pure and total: returns `undefined` when the read carries no report, so the
 * caller keeps its generic fallback rather than inventing one.
 */
export function runFailureMessage(runBody: IDataObject): string | undefined {
	const report = runBody.error;
	if (report === null || typeof report !== 'object' || Array.isArray(report)) return undefined;
	const { message, error_type: errorType } = report as { message?: unknown; error_type?: unknown };
	if (typeof message !== 'string' || message.length === 0) return undefined;

	const status = typeof runBody.status === 'string' ? runBody.status : 'FAILED';
	// Lead with the terminal status (the 409 said it and it is worth keeping — a
	// TIMED_OUT run reads very differently from a FAILED one), then the real
	// reason, then the error type when it adds a name the message does not.
	const named = typeof errorType === 'string' && errorType.length > 0 && !message.includes(errorType)
		? `${message} [${errorType}]`
		: message;
	return `Run ${status}: ${named}`;
}

/**
 * Build the `description` n8n shows under the headline in the "From Pipelex"
 * error panel, out of the run's stored failure report.
 *
 * `NodeApiError` renders exactly three things — `message`, `description`, and
 * `httpCode` — and does NOT dump the attached body. So everything the report
 * knows beyond the one-line reason has to be folded into `description` or it is
 * invisible. Left to itself, n8n picks `error.message` out of the body and repeats
 * it as the description (`node-api.error.js`: `description = data.error.message`),
 * which is why a failure used to say the same sentence twice.
 *
 * The report is the runner's `ErrorReport.to_dict()`, so the fields worth
 * surfacing are the ones a workflow author can act on:
 * - `title` — the human name of the failure class
 * - `user_action` — literally what to do about it (`change_input`,
 *   `check_billing`, `wait_and_retry`, …) plus its free-form `detail`
 * - `retryable` — whether n8n's own "Retry On Fail" could ever help
 * - `error_type` / `error_domain` — for branching and for reporting upstream
 * - `type_uri` — the docs page for this error
 * - `validation_errors` — how many structured items came with it
 *
 * Every field is optional (older reports carry fewer), so this emits only what is
 * present and returns `undefined` when there is nothing to add — never an empty
 * or skeleton block.
 */
export function runFailureDescription(runBody: IDataObject): string | undefined {
	const report = runBody.error;
	if (report === null || typeof report !== 'object' || Array.isArray(report)) return undefined;
	const fields = report as Record<string, unknown>;

	const text = (value: unknown): string | undefined =>
		typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

	// ONE line, joined by " | ". n8n renders this description as plain text inside
	// HTML, so newlines collapse into spaces — a `\n`-joined block came out as a
	// run-on sentence where the title ran straight into the next label ("Pipe run
	// inputs Error: ..." reading as one phrase). Every fact therefore carries its
	// own label and the separators are visible after collapsing. Nested lists use
	// " · " so they can never be confused with the top-level separator.
	const facts: string[] = [];
	const add = (label: string, value: string | undefined): void => {
		if (value) facts.push(`${label}: ${value}`);
	};

	const title = text(fields.title);
	if (title) facts.push(title);

	// The action first — the only fact that says what to DO rather than what happened.
	const action = fields.user_action;
	if (action !== null && typeof action === 'object' && !Array.isArray(action)) {
		const { kind, detail } = action as { kind?: unknown; detail?: unknown };
		add(
			'What to do',
			[text(kind)?.replace(/_/g, ' '), text(detail)].filter(Boolean).join(' — ') || undefined,
		);
	}

	if (typeof fields.retryable === 'boolean') {
		add(
			'Retryable',
			fields.retryable ? 'yes (re-running may succeed)' : 'no (re-running will fail identically)',
		);
	}

	add(
		'Error',
		[text(fields.error_type), text(fields.error_domain), text(fields.error_category)]
			.filter(Boolean)
			.join(' · ') || undefined,
	);
	add('Model', [text(fields.provider), text(fields.model)].filter(Boolean).join(' / ') || undefined);

	const validationErrors = fields.validation_errors;
	if (Array.isArray(validationErrors) && validationErrors.length > 0) {
		add('Validation errors', String(validationErrors.length));
	}

	add('Run', text(runBody.pipeline_run_id));
	add('Pipe', text(runBody.pipe_code));
	add('Finished', text(runBody.finished_at));
	add('Docs', text(fields.type_uri));

	return facts.length > 0 ? facts.join(' | ') : undefined;
}

/**
 * The failure report as an aligned key/value block, for n8n's **Error data** row.
 *
 * Why this exists alongside {@link runFailureDescription}: the two surfaces have
 * different rules. The description is plain text in an HTML context, so it must
 * be one collapsed line. The "Error data" row is rendered inside `<pre><code>`
 * (`error.context.data` in n8n's node-error view), so it preserves newlines and
 * alignment — which makes it the right place for the WHOLE report rather than a
 * curated summary.
 *
 * Everything the runner sent is emitted, nested values as JSON, so nothing is
 * hidden from someone debugging. Keys are printed in a stable, useful order
 * (identity → what → why → where) rather than object order, then any field the
 * report carries that this node does not know about — a new `ErrorReport` field
 * ships without a node release and still shows up here.
 */
export function runFailureData(runBody: IDataObject): string | undefined {
	const report = runBody.error;
	if (report === null || typeof report !== 'object' || Array.isArray(report)) return undefined;
	const fields = { ...(report as Record<string, unknown>) };

	const rows: Array<[string, unknown]> = [];
	const take = (key: string): void => {
		if (key in fields) {
			const value = fields[key];
			delete fields[key];
			if (value !== null && value !== undefined && value !== '') rows.push([key, value]);
		}
	};

	// Curated order first: the fields a human reads in this sequence.
	for (const key of [
		'title',
		'message',
		'error_type',
		'error_domain',
		'error_category',
		'user_action',
		'retryable',
		'provider',
		'model',
		'validation_errors',
		'type_uri',
	]) {
		take(key);
	}
	// Then whatever else the report carried — unknown fields must not vanish.
	for (const key of Object.keys(fields)) take(key);

	// Run identity last: it frames the report without competing with it.
	for (const [key, value] of [
		['pipeline_run_id', runBody.pipeline_run_id],
		['pipe_code', runBody.pipe_code],
		['status', runBody.status],
		['finished_at', runBody.finished_at],
	] as Array<[string, unknown]>) {
		if (value !== null && value !== undefined && value !== '') rows.push([key, value]);
	}

	if (rows.length === 0) return undefined;

	const width = Math.max(...rows.map(([key]) => key.length));
	return rows
		.map(([key, value]) => {
			const rendered =
				typeof value === 'string' ? value : JSON.stringify(value, null, 2)?.replace(/\n/g, '\n' + ' '.repeat(width + 2));
			return `${key.padEnd(width)}  ${rendered}`;
		})
		.join('\n');
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
		headers: apiHeaders(conn),
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;
}

// ── Binary inputs: an n8n file becomes a method input ───────────────────────
//
// Files move through n8n as binary data on the item. A method input whose
// concept is a Document or an Image takes a file reference, so the node stores
// each mapped binary in Pipelex storage and puts the returned
// `pipelex-storage://` reference into the start body's inputs.
//
// The upload is the SDK's upload grant (`requestUploadGrant` + `uploadWithGrant`
// in `pipelex-sdk-js`), replicated: `POST /v1/upload/grant` describes the file,
// then the raw bytes go to storage in one `PUT` with the grant's signed headers.
// Why the grant rather than the SDK's base64 `uploadFile` is in the header of
// `PipelexApiShapes.ts`. Everything here runs before `POST /v1/start`, so a
// failed upload fails the item with no run created.

/** One row of the `Binary Inputs` collection: a method input and the n8n binary field that fills it. */
export interface BinaryInputMapping {
	inputName: string;
	binaryPropertyName: string;
}

/** The binary field n8n names a single file by default, and the row's prefilled value. */
export const DEFAULT_BINARY_PROPERTY = 'data';

/** A string, a number or a boolean as trimmed text; anything else as empty. */
function scalarText(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

/**
 * Read the `Binary Inputs` fixedCollection (`{ input: [{ name, binaryPropertyName }] }`)
 * into mappings. Pure — the node turns the returned error into an item-scoped one.
 *
 * - A row with a blank input name is dropped: the editor persists a row as soon
 *   as its add button is clicked, with the binary field prefilled, so a blank
 *   name is an unused row.
 * - An input named twice is refused. One input takes one file, and keeping the
 *   last row would silently drop a file the author mapped.
 * - A binary field left out of the stored row falls back to `data` (n8n may
 *   store a row without its default values); one explicitly cleared is refused,
 *   since guessing which field the author meant would upload the wrong file.
 */
export function readBinaryInputMappings(raw: unknown): {
	mappings: BinaryInputMapping[];
	error?: string;
} {
	const rows = (raw as { input?: unknown } | undefined)?.input;
	const mappings: BinaryInputMapping[] = [];
	if (!Array.isArray(rows)) return { mappings };
	const seen = new Set<string>();
	for (const row of rows) {
		const { name, binaryPropertyName } = (row ?? {}) as {
			name?: unknown;
			binaryPropertyName?: unknown;
		};
		const inputName = scalarText(name);
		if (!inputName) continue;
		if (seen.has(inputName)) {
			return {
				mappings,
				error: `Binary input "${inputName}" is listed more than once — each method input takes one file. Remove the duplicate row.`,
			};
		}
		seen.add(inputName);
		const property =
			binaryPropertyName === undefined ? DEFAULT_BINARY_PROPERTY : scalarText(binaryPropertyName);
		if (!property) {
			return {
				mappings,
				error: `Binary input "${inputName}" names no binary field. Set "Input Binary Field" to the field that holds the file (n8n's default is "${DEFAULT_BINARY_PROPERTY}").`,
			};
		}
		mappings.push({ inputName, binaryPropertyName: property });
	}
	return { mappings };
}

/**
 * The precedence rule between the two ways to give an input: there is none.
 * An input set both in the JSON `Inputs` and in `Binary Inputs` is refused,
 * because either winner would silently discard a value the author typed — the
 * same "refuse rather than guess" rule the node applies to a Method ID beside
 * an inline method. Returns the message, or `null` when the two are disjoint.
 */
export function binaryInputConflictError(
	mappings: BinaryInputMapping[],
	inputs: Record<string, unknown>,
): string | null {
	const clash = mappings.find((mapping) =>
		Object.prototype.hasOwnProperty.call(inputs, mapping.inputName),
	);
	if (!clash) return null;
	return `Input "${clash.inputName}" is set twice: in Inputs and in Binary Inputs. Remove it from one of them — the node does not guess which value you meant.`;
}

/**
 * The message for a mapped binary field the item does not carry, naming the
 * fields it does carry — a Gmail trigger names attachments `attachment_0`,
 * `attachment_1`, …, so "no field data" alone sends the author hunting.
 */
export function missingBinaryMessage(mapping: BinaryInputMapping, available: string[]): string {
	const lead = `Binary input "${mapping.inputName}" reads the binary field "${mapping.binaryPropertyName}", but this item has no such field.`;
	return available.length > 0
		? `${lead} Its binary fields are: ${available.join(', ')}.`
		: `${lead} It carries no binary data at all — check that the node before this one outputs a file.`;
}

/** n8n's own test for a binary value (`isBinaryValue`), owned here: it is not in every n8n-workflow the node runs on. */
function isBinaryShaped(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		'mimeType' in value &&
		('data' in value || 'id' in value)
	);
}

/**
 * The binary fields an item carries, for {@link missingBinaryMessage}. A workflow
 * whose binary mode is `separate` (the default) keeps files under `item.binary`;
 * one whose mode is `combined` keeps them in the item's JSON, where n8n's
 * `assertBinaryData` looks the field up as a path. Both places are listed, the
 * JSON side at its top level, so the message names what the item really holds
 * whichever mode the workflow runs in.
 */
export function binaryFieldNames(
	item: { json?: unknown; binary?: Record<string, unknown> } | undefined,
): string[] {
	const names = Object.keys(item?.binary ?? {});
	const json = item?.json;
	if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
		for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
			if (isBinaryShaped(value) && !names.includes(key)) names.push(key);
		}
	}
	return names;
}

/**
 * How many bytes n8n says a binary holds, read from its metadata without loading
 * the file: the `bytes` n8n records when it stores a binary, else the metadata
 * of a binary kept outside memory (`id`, through `getBinaryMetadata`), else the
 * length of the base64 `data` of one kept in memory. `undefined` when none of
 * them answers; the loaded file is then measured instead.
 */
export async function binaryByteSize(
	binaryData: IBinaryData,
	getMetadata: ((binaryDataId: string) => Promise<{ fileSize: number }>) | undefined,
): Promise<number | undefined> {
	const isSize = (value: unknown): value is number =>
		typeof value === 'number' && Number.isFinite(value) && value >= 0;
	if (isSize(binaryData.bytes)) return binaryData.bytes;
	if (typeof binaryData.id === 'string' && binaryData.id.length > 0) {
		if (!getMetadata) return undefined;
		try {
			const { fileSize } = await getMetadata(binaryData.id);
			return isSize(fileSize) ? fileSize : undefined;
		} catch {
			return undefined;
		}
	}
	return typeof binaryData.data === 'string' ? Buffer.byteLength(binaryData.data, 'base64') : undefined;
}

/**
 * The refusal for a file of `size` bytes, or `null` when the size is one the
 * node sends: an empty file gives the method nothing, and one over
 * {@link MAX_UPLOAD_BYTES} would only be refused by the upload grant.
 */
export function binarySizeError(
	subject: { inputName: string; binaryPropertyName: string; filename: string },
	size: number,
): string | null {
	const where = `The file "${subject.filename}" in binary field "${subject.binaryPropertyName}" for input "${subject.inputName}"`;
	if (size === 0) {
		return `${where} is empty (0 bytes), so there is nothing to give the method. Check the node that produced it.`;
	}
	if (size > MAX_UPLOAD_BYTES) {
		return `${where} is ${size} bytes, over the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB Pipelex accepts for one file, so it was not uploaded. Pass a smaller file.`;
	}
	return null;
}

/** Whether a file name ends in an extension: a dot that neither starts nor ends it (`.env` has none). */
function hasExtension(filename: string): boolean {
	const dot = filename.lastIndexOf('.');
	return dot > 0 && dot < filename.length - 1;
}

/**
 * The file name and MIME type to store a binary under, from what n8n carries.
 *
 * The stored object keeps the extension of the name, so a name without one is
 * given n8n's `fileExtension`, or failing that the extension of n8n's MIME type
 * (`application/pdf` → `.pdf`): a Drive export named `Invoice` with
 * `fileExtension: "pdf"` is stored as `Invoice.pdf`, not as an extensionless
 * object. Nameless bytes are named as the SDK's `uploadFile` names them
 * (`upload.<extension>`, else `upload.bin`).
 *
 * The type is n8n's `mimeType` unless that is empty or the generic
 * `application/octet-stream`, in which case the extension is asked — the SDK's
 * `asset.type || guessContentType(filename)`, where an unknown n8n type plays
 * the part of a browser's empty `File.type`. The extension asked is the one the
 * name ends up with, so `fileExtension` counts there too.
 */
export function describeBinaryFile(binaryData: IBinaryData): {
	filename: string;
	contentType: string;
} {
	const declared = scalarText(binaryData.mimeType);
	const knownType = declared && declared.toLowerCase() !== DEFAULT_CONTENT_TYPE ? declared : '';
	const extension =
		scalarText(binaryData.fileExtension).replace(/^\./, '') ||
		(knownType ? (extensionForContentType(knownType) ?? '') : '');
	const name = scalarText(binaryData.fileName);
	let filename: string;
	if (!name) filename = extension ? `upload.${extension}` : 'upload.bin';
	else filename = !hasExtension(name) && extension ? `${name}.${extension}` : name;
	return { filename, contentType: knownType || guessContentType(filename) };
}

/** The input value for a stored file — see {@link StoredFileInput}. */
export function storedFileInput(
	uri: string,
	filename: string,
	contentType: string,
): StoredFileInput {
	const value: StoredFileInput = { url: uri, filename };
	if (contentType !== DEFAULT_CONTENT_TYPE) value.mime_type = contentType;
	return value;
}

/** The `input=reference` entries {@link idempotencyKey} folds in, one per stored file. */
export function storedFileReferences(stored: Record<string, StoredFileInput>): string[] {
	return Object.entries(stored).map(([inputName, value]) => `${inputName}=${value.url}`);
}

/** A binary loaded off the item, ready to upload. */
export interface BinaryFile {
	inputName: string;
	bytes: Buffer;
	filename: string;
	contentType: string;
}

/** How a file is named in upload messages: its name, and the input it fills. */
function fileSubject(file: { inputName: string; filename: string }): string {
	return `"${file.filename}" for input "${file.inputName}"`;
}

export const UPLOAD_UNAVAILABLE_MESSAGE =
	'The credential\'s Base URL offers no file upload (it has no /v1/upload/grant route), so a binary input cannot be stored. Point the Base URL at the hosted Pipelex API, or pass the file as an http(s) URL in Inputs instead.';

/**
 * Read the answer of `POST /v1/upload/grant` into an {@link UploadGrant}, or
 * `undefined` when it is not one. The `url` must be an absolute `http(s)` URL
 * with no user info — the SDK's `storageTarget` rule: a relative URL would be
 * resolved against something else, and user info would ride into an error.
 */
export function readUploadGrant(body: unknown): UploadGrant | undefined {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
	const { uri, url, headers, expires_at: expiresAt, max_bytes: maxBytes } = body as Record<
		string,
		unknown
	>;
	if (typeof uri !== 'string' || !uri.startsWith(PIPELEX_STORAGE_SCHEME)) return undefined;
	if (typeof url !== 'string' || storageOrigin(url) === undefined) return undefined;
	if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
	const signed: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
		if (typeof value !== 'string') return undefined;
		signed[name] = value;
	}
	return {
		uri,
		url,
		headers: signed,
		expires_at: typeof expiresAt === 'string' ? expiresAt : '',
		max_bytes: typeof maxBytes === 'number' ? maxBytes : 0,
	};
}

/** The origin of a grant URL, or `undefined` when it is not one the node will send a file to. */
function storageOrigin(url: string): string | undefined {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return undefined;
	}
	if (target.protocol !== 'https:' && target.protocol !== 'http:') return undefined;
	if (target.username !== '' || target.password !== '') return undefined;
	return target.origin;
}

/**
 * The message for a refused `POST /v1/upload/grant`, after the SDK's
 * `mapUploadError`: a `413` is a file over the service's limit, a `401` or `403`
 * an authorization failure, a `404` a deployment without the route, anything
 * else a failure worth retrying when it is a `5xx`. The platform's
 * `problem+json` detail is appended, as on the run routes.
 */
export function uploadGrantRefusalMessage(
	statusCode: number,
	body: IDataObject,
	file: { inputName: string; filename: string; size: number },
): string {
	const subject = fileSubject(file);
	switch (statusCode) {
		case 413:
			return withServerDetail(
				`The file ${subject} is too large for Pipelex (${file.size} bytes).`,
				body,
			);
		case 401:
			return withServerDetail(
				`Pipelex did not accept the credential's Bearer Token when asked to store ${subject} (HTTP 401). Check the token in the Pipelex credential.`,
				body,
			);
		// The storage routes are gated by identity alone on the platform (an
		// org-less caller is a 400), so a 403 comes from the gateway's access rules,
		// not from the per-account run gate FORBIDDEN_MESSAGE describes.
		case 403:
			return withServerDetail(
				`Pipelex refused to store ${subject} (HTTP 403): the credential's token is not allowed to upload files. Ask Pipelex to check your account's API access (https://go.pipelex.com/discord).`,
				body,
			);
		case 404:
			return UPLOAD_UNAVAILABLE_MESSAGE;
		default: {
			const retry = statusCode >= 500 ? ' Retry the item.' : '';
			return withServerDetail(
				`Pipelex could not prepare the upload of ${subject} (HTTP ${statusCode}).${retry}`,
				body,
			);
		}
	}
}

/**
 * `POST /v1/upload/grant` — ask for a presigned `PUT` for one file. Sent with
 * the API headers and **without** an `Idempotency-Key`: the route never replays
 * a grant (a repeated key is a `409` "already executed"), and asking again is
 * free, so a retry simply asks for a new one.
 *
 * A refusal surfaces as a `NodeApiError` carrying the platform's problem body.
 * A `2xx` that is not a usable grant surfaces WITHOUT its body, which may hold
 * the grant's URL — a bearer capability that must stay out of error panels.
 */
export async function requestUploadGrant(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	file: BinaryFile,
	itemIndex: number,
): Promise<UploadGrant> {
	const request: UploadGrantRequest = {
		filename: file.filename,
		content_type: file.contentType,
		size: file.bytes.length,
	};
	const response = (await ctx.helpers.httpRequest({
		method: 'POST' as IHttpRequestMethods,
		url: `${conn.baseUrl}/v1/upload/grant`,
		headers: apiHeaders(conn),
		body: request as unknown as IDataObject,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;

	const statusCode = response.statusCode;
	if (statusCode >= 200 && statusCode < 300) {
		const grant = readUploadGrant(response.body);
		if (grant) return grant;
		throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
			message: `Pipelex answered the upload request for ${fileSubject(file)} without a usable upload grant, so the file was not sent. This is a server-side problem — report it to Pipelex support.`,
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	const body =
		response.body !== null && typeof response.body === 'object' && !Array.isArray(response.body)
			? (response.body as IDataObject)
			: {};
	throw new NodeApiError(ctx.getNode(), body as JsonObject, {
		message: uploadGrantRefusalMessage(statusCode, body, { ...file, size: request.size }),
		httpCode: String(statusCode),
		itemIndex,
	});
}

/** How much of storage's error body is read — where S3 writes its `<Code>` and `<Message>`. */
const STORAGE_ERROR_BODY_MAX_CHARS = 16 * 1024;

/** Storage's own error, read off an S3 XML body. Either field is absent on another body. */
export interface StorageRefusal {
	code?: string;
	message?: string;
}

/**
 * Read `<Code>` and `<Message>` off an S3 error document — the SDK's
 * `parseStorageError`. Only these two are ever kept: the rest of the body can
 * echo the signed request, and with it the grant's credential.
 */
export function parseStorageError(body: unknown): StorageRefusal {
	const text = typeof body === 'string' ? body.slice(0, STORAGE_ERROR_BODY_MAX_CHARS) : '';
	const refusal: StorageRefusal = {};
	const code = xmlElementText(text, 'Code');
	const message = xmlElementText(text, 'Message');
	if (code !== undefined) refusal.code = code;
	if (message !== undefined) refusal.message = message;
	return refusal;
}

function xmlElementText(body: string, element: string): string | undefined {
	const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(body);
	if (!match?.[1]) return undefined;
	return match[1]
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/** A message whose own final period would double the one the sentence adds after it. */
function withoutFinalPeriod(message: string): string {
	return message.replace(/\.\s*$/, '');
}

/**
 * The message for storage's answer to the `PUT` when it is not a `2xx` — the
 * SDK's `uploadWithGrant` classification, with its advice rewritten for a
 * workflow: the SDK offers a retry with the same grant, while the node never
 * keeps one, so the advice is always "retry the item", which asks for a new
 * grant. A signature mismatch or an unsigned header cannot come from the
 * author's file — the node sends the grant's headers unchanged — so those say
 * where to look instead.
 */
export function storageRefusalMessage(
	statusCode: number,
	refusal: StorageRefusal,
	file: { inputName: string; filename: string },
): string {
	const subject = fileSubject(file);
	const status = refusal.code ? `${statusCode} ${refusal.code}` : String(statusCode);
	if (statusCode >= 300 && statusCode < 400) {
		return `Storage redirected the upload of ${subject} (${status}), and the redirect was refused: a presigned upload is valid only at the address it was signed for.`;
	}
	if (statusCode === 400 && refusal.code === 'RequestTimeout') {
		return `Storage stopped waiting for the bytes of ${subject} (${status}) and stored nothing. Retry the item.`;
	}
	if (statusCode === 409 && refusal.code === 'ConditionalRequestConflict') {
		return `Storage met another upload with the same grant for ${subject} (${status}), so whether the file was stored is unknown. Retry the item: it asks for a new grant.`;
	}
	if (statusCode >= 400 && statusCode < 500) {
		const lead = `Storage refused the upload of ${subject} (${status})`;
		if (statusCode === 412) {
			return `${lead}: the upload grant was already used. Retry the item: every attempt asks for a new grant.`;
		}
		if (refusal.code === 'SignatureDoesNotMatch') {
			return `${lead}: the request differs from what the upload grant signed. Something between n8n and storage changed it (a proxy rewriting headers), or this is a bug in the node — please report it.`;
		}
		if (refusal.message && /expired/i.test(refusal.message)) {
			return `${lead}: the upload grant expired before the upload started. Retry the item.`;
		}
		if (refusal.message && /not signed/i.test(refusal.message)) {
			return `${lead}: the request carried a storage header the upload grant did not sign. A proxy between n8n and storage may be adding one; otherwise this is a bug in the node — please report it.`;
		}
		return refusal.message
			? `${lead}: ${withoutFinalPeriod(refusal.message)}. Retry the item.`
			: `${lead}. Retry the item.`;
	}
	const detail = refusal.message ? `: ${withoutFinalPeriod(refusal.message)}` : '';
	return `Storage failed to store ${subject} (${status})${detail}. Whether the file was stored is unknown; retry the item.`;
}

/**
 * A network failure described by the names and codes along its cause chain —
 * "AxiosError ENOTFOUND" — the SDK's `describeNetworkFailure`. Each is kept only
 * when it is a bare identifier, which cannot hold the grant's URL; the runtime's
 * own message is never relayed, because it can.
 */
export function describeNetworkFailure(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		const name = isIdentifier(current.name) ? current.name : 'Error';
		const code = (current as { code?: unknown }).code;
		parts.push(isIdentifier(code) ? `${name} ${code}` : name);
		current = (current as { cause?: unknown }).cause;
	}
	return parts.length > 0 ? parts.join(', caused by ') : 'a non-Error rejection';
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
}

/**
 * Whether a request that got no answer ran out of time once storage could have
 * been receiving it. axios reports its own timeout as `ECONNABORTED` (or
 * `ETIMEDOUT` under `clarifyTimeoutError`), but the operating system also says
 * `ETIMEDOUT` when a TCP connection never opens — and then storage received
 * nothing. That one is told apart by its `syscall`, `connect`. axios 1.15 and
 * 1.18 both keep it on the error's `cause` (checked against a failed connect),
 * and a wrapper may lift it onto the error itself, so the whole chain is read.
 */
export function isTimeoutFailure(error: unknown): boolean {
	const code = (error as { code?: unknown } | undefined)?.code;
	if (code !== 'ECONNABORTED' && code !== 'ETIMEDOUT') return false;
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
		if ((current as { syscall?: unknown }).syscall === 'connect') return false;
		current = (current as { cause?: unknown }).cause;
	}
	return true;
}

/**
 * One signal that aborts when either of two does — `AbortSignal.any`, which
 * releases its links by itself, else a controller linked by hand on a Node too
 * old to have it, whose links `unlink` removes so a long execution's cancel
 * signal does not collect one listener per upload.
 */
export function eitherSignal(
	first: AbortSignal,
	second: AbortSignal,
): { signal: AbortSignal; unlink: () => void } {
	const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
	if (typeof any === 'function') return { signal: any.call(AbortSignal, [first, second]), unlink: () => {} };
	const controller = new AbortController();
	const unlinks: Array<() => void> = [];
	for (const source of [first, second]) {
		if (source.aborted) {
			controller.abort(source.reason);
			break;
		}
		const onAbort = (): void => controller.abort(source.reason);
		source.addEventListener('abort', onAbort, { once: true });
		unlinks.push(() => source.removeEventListener('abort', onAbort));
	}
	return { signal: controller.signal, unlink: () => unlinks.forEach((unlink) => unlink()) };
}

/**
 * `PUT` the file to storage with the grant: the raw bytes as the body, the
 * grant's signed headers unchanged, and nothing else of the node's own — no
 * `Authorization` (the signature in the URL is the credential, and a second one
 * makes S3 refuse the request) and no `User-Agent` (the client-identification
 * spec leaves the user agent of a request to a presigned object-store URL
 * alone, so n8n's default applies).
 *
 * Redirects are refused (a presigned URL is valid only where it was signed), and
 * cancelling the n8n execution cancels the upload. The SDK's default time limit
 * is a deadline the node owns, an `AbortSignal.timeout` linked with the cancel
 * signal, rather than axios's `timeout`: on the axios of n8n 2.16 and older
 * (1.15) that option is `ClientRequest#setTimeout`, a socket-inactivity timer
 * armed only once the socket has connected, so the name lookup and the TCP
 * connect ran unbounded and a response that keeps trickling never trips it. The
 * signal bounds the whole exchange on every axios. Which signal fired decides the
 * message — cancelled, out of time, or never reached. Every failure is described
 * without the grant's URL, storage's error body or the runtime error that could
 * carry either — which is why a failed request is caught here and classified
 * OUTSIDE the `catch` rather than wrapped.
 */
export async function putToStorage(
	ctx: IExecuteFunctions,
	grant: UploadGrant,
	file: BinaryFile,
	itemIndex: number,
): Promise<void> {
	const origin = storageOrigin(grant.url) ?? 'storage';
	const cancelSignal = ctx.getExecutionCancelSignal();
	const limitMs = uploadTimeoutMs(file.bytes.length);
	const deadline = AbortSignal.timeout(limitMs);
	const linked = cancelSignal ? eitherSignal(cancelSignal, deadline) : undefined;

	let response: IN8nHttpFullResponse | undefined;
	let failure: unknown;
	try {
		response = (await ctx.helpers.httpRequest({
			method: 'PUT' as IHttpRequestMethods,
			url: grant.url,
			headers: { ...grant.headers },
			body: file.bytes,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			encoding: 'text',
			abortSignal: linked?.signal ?? deadline,
		})) as IN8nHttpFullResponse;
	} catch (error) {
		failure = error;
	} finally {
		linked?.unlink();
	}

	const subject = fileSubject(file);
	if (response === undefined) {
		if (cancelSignal?.aborted) {
			throw new NodeOperationError(
				ctx.getNode(),
				`The upload of ${subject} was cancelled with the execution.`,
				{ itemIndex },
			);
		}
		// The failure's names and codes go in the description, never the message:
		// n8n replaces any message containing a Node error code (`ENOTFOUND`,
		// `ETIMEDOUT`, …) with a generic sentence that names neither the file nor
		// the storage host (`setDescriptiveErrorMessage` in n8n-workflow).
		const description = `Network failure: ${describeNetworkFailure(failure)}.`;
		const message = deadline.aborted || isTimeoutFailure(failure)
			? `The upload of ${subject} to storage did not finish within ${Math.round(limitMs / 1000)} s, so whether storage stored it is unknown. Retry the item: it uploads the file again under a new reference.`
			: `The upload of ${subject} could not reach storage at ${origin}. A binary input goes to storage directly, not through the Pipelex API, so this n8n instance must be able to reach ${origin}.`;
		throw new NodeOperationError(ctx.getNode(), message, { itemIndex, description });
	}

	const statusCode = response.statusCode;
	if (statusCode >= 200 && statusCode < 300) return;
	const refusal = parseStorageError(response.body);
	throw new NodeApiError(
		ctx.getNode(),
		{ storage_status: statusCode, storage_error: refusal.code ?? null } as JsonObject,
		{
			message: storageRefusalMessage(statusCode, refusal, file),
			httpCode: String(statusCode),
			itemIndex,
		},
	);
}

/**
 * Store one binary and return the input value that names it: ask for a grant,
 * `PUT` the bytes, and only then use the grant's reference — it names nothing
 * until storage has answered the `PUT` with a `2xx`.
 */
export async function uploadBinaryFile(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	file: BinaryFile,
	itemIndex: number,
): Promise<StoredFileInput> {
	const grant = await requestUploadGrant(ctx, conn, file, itemIndex);
	await putToStorage(ctx, grant, file, itemIndex);
	return storedFileInput(grant.uri, file.filename, file.contentType);
}
