import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import {
	MISSING_MAIN_STUFF_MESSAGE,
	RESULT_MID_WRITE_MESSAGE,
	SERVICE_UNAVAILABLE_MESSAGE,
	abortableSleep,
	assembleRunSources,
	buildApiConnection,
	buildStartBody,
	idempotencyKey,
	mapResultResponse,
	requestResult,
	requestRunStatus,
	requestStart,
	runFailureMessage,
	runSourceError,
	withRunId,
	type ApiConnection,
	type ResultOutcome,
} from './GenericFunctions';
import type { HostedStartBody, StartAck } from './PipelexApiShapes';

// Polling defaults. Max Wait caps how long a polling operation blocks the n8n
// execution — 300s covers the overwhelming majority of runs while staying
// safely under typical n8n Cloud execution caps. On exceed the node returns
// the pipeline_run_id + a "still running" payload (NOT an error) so the run
// can be fetched later with Get Run Result / Poll & Get Result. 0 = wait
// indefinitely (self-hosted n8n with no execution timeout).
const DEFAULT_MAX_WAIT_SECONDS = 300;
// Floor on the sleep between polls — guards against a hot loop if the server
// ever sends `Retry-After: 0`. (When the header is absent, the mapper already
// defaults to 5s.)
const MIN_POLL_SLEEP_MS = 250;
// How many CONSECUTIVE 503 (degraded) responses the poll loop tolerates before
// surfacing the run as unavailable. A healthy run polls with 202s, which reset
// the counter — so this only trips on a sustained backend outage, independent
// of Max Wait (it bounds the otherwise-infinite poll when maxWaitSeconds is 0).
const MAX_CONSECUTIVE_DEGRADED = 5;
// How many CONSECUTIVE "completed but no main_stuff yet" responses to tolerate.
// The platform flips a run to COMPLETED and then relays whatever is in S3, so a
// poll can land mid-write and legitimately see a null main_stuff. Retrying is
// correct; retrying forever is not — past this ceiling the completed-run
// invariant really is broken and the run is reported as failed.
const MAX_CONSECUTIVE_MID_WRITE = 5;

// Operations that submit a run (and therefore show the pipeline-definition
// fields). `execute` is the published 0.0.x legacy value — see the execute()
// switch — kept in the displayOptions lists so old saved workflows still
// render their fields.
const START_OPERATIONS = ['startAndPoll', 'start', 'execute'];
// Operations that take an existing pipeline_run_id as input.
const RUN_ID_OPERATIONS = ['poll', 'getResult'];
// Operations that poll internally (and therefore expose Max Wait).
const POLLING_OPERATIONS = ['startAndPoll', 'poll', 'execute'];

/**
 * Re-throw an error from an op helper. The helpers already raise
 * `NodeApiError` / `NodeOperationError` with the response body, HTTP code, and
 * item context — re-throw those UNCHANGED so n8n keeps the full metadata. Only a
 * genuinely-unknown error is wrapped. (Lives outside the `catch` so it doesn't
 * trip the `require-node-api-error` lint rule, which only inspects throws made
 * directly inside a catch clause.)
 */
function rethrowOpError(ctx: IExecuteFunctions, error: unknown, itemIndex: number): never {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		throw error;
	}
	throw new NodeApiError(ctx.getNode(), error as JsonObject, {
		message: (error as Error).message,
		itemIndex,
	});
}

/**
 * Read the `MTHDS Bundles` collection into the `mthds_contents` array.
 *
 * Accepts BOTH shapes on purpose. The field is a `fixedCollection` (so it matches
 * `Python Files` visually), which stores `{ bundle: [{ content }] }` — but a
 * workflow saved before that change holds a bare `string[]` from the old
 * multi-value string field. Reading both means an upgraded workflow keeps running
 * instead of silently losing the pasted method; the field itself only ever writes
 * the new shape.
 *
 * Blank and whitespace-only entries are dropped (the UI persists a row as soon as
 * the add-button is clicked), so an empty row cannot pass as a run source.
 */
function readMthdsContents(raw: unknown): string[] {
	const entries: unknown[] = Array.isArray(raw)
		? raw
		: ((raw as { bundle?: unknown[] } | undefined)?.bundle ?? []).map(
				(row) => (row as { content?: unknown } | undefined)?.content,
			);
	const contents: string[] = [];
	for (const entry of entries) {
		const text =
			typeof entry === 'string'
				? entry
				: typeof entry === 'number' || typeof entry === 'boolean'
					? String(entry)
					: '';
		if (text.trim().length > 0) contents.push(text);
	}
	return contents;
}

/**
 * Read a file fixedCollection into the `{ relativePath: text }` map the `files`
 * run source takes. Entries with a blank path are dropped (the UI
 * persists a row as soon as the add button is clicked); a blank CONTENT is kept —
 * an empty `requirements.txt` or `__init__.py` is a legitimate bundle member.
 *
 * Contents are coerced to text rather than forwarded verbatim: `getNodeParameter`
 * is `unknown` because an expression can resolve to anything, and a non-string
 * would leave the node and come back as an opaque server 422 instead of a local,
 * item-scoped error.
 */
function readFileCollection(
	ctx: IExecuteFunctions,
	paramName: string,
	itemIndex: number,
): Record<string, string> {
	const collection = ctx.getNodeParameter(paramName, itemIndex, {}) as {
		file?: Array<{ path?: unknown; content?: unknown }>;
	};
	const files: Record<string, string> = {};
	for (const entry of collection.file ?? []) {
		const path = typeof entry.path === 'string' ? entry.path.trim() : '';
		if (!path) continue;
		const content = entry.content;
		if (content === undefined || content === null) {
			files[path] = '';
		} else if (typeof content === 'string') {
			files[path] = content;
		} else if (typeof content === 'number' || typeof content === 'boolean') {
			files[path] = String(content);
		} else {
			throw new NodeOperationError(
				ctx.getNode(),
				`The content of bundle file "${path}" must be text, but the expression resolved to ${Array.isArray(content) ? 'an array' : typeof content}. Convert it to a string first.`,
				{ itemIndex },
			);
		}
	}
	return files;
}

/**
 * Collect + validate the pipeline-definition fields of the start operations
 * and map them to the snake_case `POST /v1/start` body. Run-source rules are
 * checked client-side so the errors are immediate and item-scoped rather than an
 * opaque server 422.
 */
function readRunDefinition(ctx: IExecuteFunctions, itemIndex: number): HostedStartBody {
	// Trimmed so whitespace-only values fail the local required-source check
	// instead of turning into a server-side 422 (and so stray whitespace in
	// Method ID never reaches the server as a phantom run source).
	const pipeCode = (ctx.getNodeParameter('pipeCode', itemIndex, '') as string).trim();
	const methodId = (ctx.getNodeParameter('methodId', itemIndex, '') as string).trim();
	const mthdsContentsRaw = ctx.getNodeParameter('mthdsContents', itemIndex, []) as unknown;
	const inputsString = ctx.getNodeParameter('inputs', itemIndex, '{}') as string;
	const outputName = ctx.getNodeParameter('outputName', itemIndex, '') as string;
	const outputMultiplicity = ctx.getNodeParameter('outputMultiplicity', itemIndex, '') as string;
	const dynamicOutputConceptRef = ctx.getNodeParameter(
		'dynamicOutputConceptRef',
		itemIndex,
		'',
	) as string;

	// Read the inline pair ONLY when the toggle is on. n8n keeps the stored value
	// of a hidden field, so a user who fills the bundle, then switches back to a
	// stored method, would otherwise still send it — and hit the either/or error
	// pointing at fields they cannot see. What is visible is what is sent.
	const inlineMethod = ctx.getNodeParameter('inlineMethod', itemIndex, false) === true;

	const mthdsContents: string[] = inlineMethod ? readMthdsContents(mthdsContentsRaw) : [];
	const pythonFiles = inlineMethod ? readFileCollection(ctx, 'pythonFiles', itemIndex) : {};

	// Either/or, enforced before anything else so the message is about the choice
	// the user made rather than about wire fields. NOTE: the hosted API would
	// ACCEPT both (it runs the inline method and records method_id as run-history
	// linkage) — the node refuses it on purpose, so there is exactly one answer to
	// "what is this node running?".
	if (methodId && (mthdsContents.length > 0 || Object.keys(pythonFiles).length > 0)) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Choose one: a stored method or an inline one. Either clear "Method ID", or turn off "Define Method Inline" (which also clears what it holds from the request).',
			{ itemIndex },
		);
	}

	let parsedInputs: unknown;
	try {
		parsedInputs = JSON.parse(inputsString);
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Invalid JSON in inputs field: ${(error as Error).message}`,
			{ itemIndex },
		);
	}
	// The API contract expects `inputs` to be a JSON object. `JSON.parse` also
	// accepts null / arrays / scalars — reject those locally with a clear,
	// item-scoped error instead of letting the runner fail opaquely later.
	if (parsedInputs === null || typeof parsedInputs !== 'object' || Array.isArray(parsedInputs)) {
		throw new NodeOperationError(
			ctx.getNode(),
			'The "Inputs" field must be a JSON object, e.g. {"key": "value"}',
			{ itemIndex },
		);
	}
	const inputs = parsedInputs as Record<string, unknown>;

	// With Python attached, the pasted method and its Python become one bundle —
	// so "paste the method, attach the Python" works.
	const assembled = assembleRunSources({
		mthdsContents,
		pythonFiles,
	});
	if (assembled.error) {
		throw new NodeOperationError(ctx.getNode(), assembled.error, { itemIndex });
	}

	const body = buildStartBody({
		pipeCode,
		methodId,
		mthdsContents: assembled.mthdsContents,
		inputs,
		outputName,
		outputMultiplicity,
		dynamicOutputConceptRef,
		files: assembled.files,
	});

	// Validate the BUILT body: `buildStartBody` has already dropped empty
	// encodings, so exclusivity is judged on what would actually be sent.
	const sourceError = runSourceError(body);
	if (sourceError) {
		throw new NodeOperationError(ctx.getNode(), sourceError, { itemIndex });
	}
	return body;
}

/** Read + require the `runId` field (Poll & Get Result / Get Run Result). */
function readRunId(ctx: IExecuteFunctions, itemIndex: number): string {
	const runId = (ctx.getNodeParameter('runId', itemIndex, '') as string).trim();
	if (!runId) {
		throw new NodeOperationError(ctx.getNode(), 'Pipeline Run ID is required', { itemIndex });
	}
	return runId;
}

/** Translate a terminal/abnormal poll outcome into a `NodeApiError`. */
function throwResultError(
	ctx: IExecuteFunctions,
	outcome: Exclude<ResultOutcome, { kind: 'completed' } | { kind: 'running' }>,
	itemIndex: number,
): never {
	switch (outcome.kind) {
		case 'failed':
			throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
				message: outcome.message,
				httpCode: '409',
				itemIndex,
			});
		// Reached only after the poll loop's mid-write ceiling: the transport said
		// 200 but the body never delivered an output. Keep the 200 so the error
		// reports what actually happened on the wire.
		case 'missingMainStuff':
			throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
				message: withRunId(MISSING_MAIN_STUFF_MESSAGE, outcome.body),
				httpCode: '200',
				itemIndex,
			});
		case 'forbidden':
			throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
				message: outcome.message,
				httpCode: '403',
				itemIndex,
			});
		case 'notFound':
			throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
				message: outcome.message,
				httpCode: '404',
				itemIndex,
			});
		case 'unexpected':
			throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
				message: outcome.message,
				httpCode: String(outcome.statusCode),
				itemIndex,
			});
	}
}

/**
 * Enrich a terminal outcome with the reason a run failed, when there is one.
 *
 * The results route's 409 body says only "Run finished with status FAILED; no
 * result available", so the workflow author is told a run failed but never why —
 * while the real cause ("missing required inputs: illustrations") sits on the run
 * row. One extra light read recovers it.
 *
 * Returns a (possibly unchanged) outcome rather than throwing, so the caller's
 * `throwResultError` stays the single `never`-returning exit — `await`ing a
 * throwing helper would not narrow control flow, and the compiler would stop
 * believing the branch ends.
 *
 * Best-effort by construction: any problem fetching or parsing leaves the
 * original 409 message in place. A failure to explain a failure must never
 * replace it.
 */
async function enrichFailureOutcome(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	runId: string,
	outcome: Exclude<ResultOutcome, { kind: 'completed' } | { kind: 'running' }>,
): Promise<Exclude<ResultOutcome, { kind: 'completed' } | { kind: 'running' }>> {
	if (outcome.kind !== 'failed') return outcome;
	try {
		const response = await requestRunStatus(ctx, conn, runId);
		if (response.statusCode < 200 || response.statusCode >= 300) return outcome;
		const body = (response.body ?? {}) as IDataObject;
		const reason = runFailureMessage(body);
		// Attach the run read as the error body too, so n8n's "Error details"
		// exposes error_type / pipe_code / finished_at beside the message.
		return reason ? { ...outcome, message: reason, body } : outcome;
	} catch {
		return outcome;
	}
}

/**
 * Poll a run's results endpoint until it reaches a terminal state — the one
 * loop shared by Start & Wait for Result (fed by its own StartAck) and
 * Poll & Get Result (fed by the user-supplied pipeline_run_id); the n8n
 * equivalent of mthds-js `waitForResult`. Honors the server's `Retry-After`
 * (default 5s when absent; a 503 mid-poll also reads as "keep polling",
 * mirroring mthds-js — never fail a poller on a single blip). A SUSTAINED 503
 * outage trips the consecutive-503 ceiling (MAX_CONSECUTIVE_DEGRADED) so an
 * unbounded poll can't spin forever on a down backend. With `maxWaitSeconds <= 0`
 * this otherwise polls indefinitely (the n8n execution's own timeout is the only
 * ceiling); with a positive cap it returns the pipeline_run_id + a "still
 * running" payload on exceed so the run isn't lost.
 */
async function pollForResultLoop(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	runId: string,
	maxWaitSeconds: number,
	itemIndex: number,
): Promise<IDataObject> {
	const abortSignal = ctx.getExecutionCancelSignal();
	const unbounded = !maxWaitSeconds || maxWaitSeconds <= 0;
	const deadline = unbounded ? Number.POSITIVE_INFINITY : Date.now() + maxWaitSeconds * 1000;
	let consecutiveDegraded = 0;
	let consecutiveMidWrite = 0;

	for (;;) {
		const response = await requestResult(ctx, conn, runId);
		const outcome = mapResultResponse(
			response.statusCode,
			(response.body ?? {}) as IDataObject,
			response.headers ?? {},
		);

		if (outcome.kind === 'completed') {
			return { ...outcome.body, status: 'COMPLETED' };
		}

		// Three non-terminal readings keep the loop going: a normal in-flight 202, a
		// transient 503, and a 200 whose result is still mid-write. Anything else is
		// terminal and raises now.
		const isDegraded = outcome.kind === 'running' && outcome.degraded;
		const isMidWrite = outcome.kind === 'missingMainStuff';
		if (outcome.kind !== 'running' && !isMidWrite) {
			throwResultError(ctx, await enrichFailureOutcome(ctx, conn, runId, outcome), itemIndex);
		}

		// A 200 with no main_stuff is the mid-write window, not a failure: the run
		// row flips to COMPLETED before the runner has finished writing its
		// artifacts to S3, and the results route relays whatever is there. Keep
		// polling — but bounded, since a state that never resolves means the
		// completed-run invariant is genuinely broken.
		if (isMidWrite) {
			consecutiveMidWrite += 1;
			if (consecutiveMidWrite > MAX_CONSECUTIVE_MID_WRITE) {
				throwResultError(ctx, await enrichFailureOutcome(ctx, conn, runId, outcome), itemIndex);
			}
		} else {
			consecutiveMidWrite = 0;
		}

		// A 503 (degraded) is tolerated as "keep polling", but a sustained outage
		// must not spin forever (esp. unbounded). Consecutive 503s trip the ceiling
		// into an actionable error that still hands back the pipeline_run_id for a
		// later Get Run Result. ANY other reading resets the counter — a 202 and a
		// mid-write 200 both prove the backend is reachable, so neither should carry
		// an outage forward. The two ceilings are independent by construction.
		if (isDegraded) {
			consecutiveDegraded += 1;
			if (consecutiveDegraded > MAX_CONSECUTIVE_DEGRADED) {
				throw new NodeApiError(ctx.getNode(), (response.body ?? {}) as JsonObject, {
					message: `${SERVICE_UNAVAILABLE_MESSAGE} Fetch it later with the "Get Run Result" operation and pipeline_run_id "${runId}".`,
					httpCode: '503',
					itemIndex,
				});
			}
		} else {
			consecutiveDegraded = 0;
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			// Graceful degrade — don't lose the run. The output is a usable item
			// (NOT an error): feed the pipeline_run_id to Get Run Result later.
			return runStillRunning(runId);
		}
		// Honor the server's Retry-After (the mapper defaults it to 5s when
		// absent), but never sleep past the deadline (Infinity when unbounded):
		// the anti-busy-loop floor applies only when the deadline allows it.
		const requestedMs = outcome.retryAfterSeconds * 1000;
		const sleepMs = Math.min(Math.max(requestedMs, MIN_POLL_SLEEP_MS), remainingMs);
		await abortableSleep(sleepMs, abortSignal);
	}
}

/** The graceful-degrade payload when a bounded poll exceeds its Max Wait. */
function runStillRunning(runId: string): IDataObject {
	return {
		status: 'RUNNING',
		pipeline_run_id: runId,
		message:
			'Still running after Max Wait. Fetch it later with the "Get Run Result" operation (or keep waiting with "Poll & Get Result") and this pipeline_run_id.',
	};
}

/**
 * Strip the platform's heavy top-level `graph_spec` artifact from a run result
 * before it becomes an n8n item — n8n-only; the platform's results response
 * is unchanged. Also drops the legacy `done` flag (superseded by `status`).
 * Top-level only by design: a `graph_spec`/`done` key nested inside the opaque
 * user output (`main_stuff`) is left untouched.
 */
function sanitizeResult(result: IDataObject): IDataObject {
	const sanitized = { ...result };
	delete sanitized.graph_spec;
	delete sanitized.done;
	return sanitized;
}

/**
 * `POST /v1/start` (with an idempotency key, 202 StartAck) for the run defined
 * by the node's pipeline-definition fields. Shared by Start & Wait for Result
 * and Start Pipeline — the StartAck's server-generated pipeline_run_id is
 * guaranteed present on return.
 */
async function startRun(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	itemIndex: number,
): Promise<StartAck> {
	const body = readRunDefinition(ctx, itemIndex);
	const idempotency = idempotencyKey(ctx.getExecutionId(), ctx.getNode().id, itemIndex);
	const startAck = await requestStart(ctx, conn, body, idempotency, itemIndex);
	if (!startAck.pipeline_run_id) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Run started but the server returned no pipeline_run_id',
			{ itemIndex },
		);
	}
	return startAck;
}

/**
 * Start & Wait for Result op (default): `POST /v1/start`, then poll
 * `GET /v1/runs/{pipeline_run_id}/results` internally until the run finishes
 * or Max Wait is exceeded. One node, no Wait-loop to assemble — the polling is
 * invisible to the user.
 */
async function startAndWaitForResult(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	itemIndex: number,
): Promise<IDataObject> {
	const startAck = await startRun(ctx, conn, itemIndex);
	const maxWaitSeconds = ctx.getNodeParameter(
		'maxWaitSeconds',
		itemIndex,
		DEFAULT_MAX_WAIT_SECONDS,
	) as number;
	return pollForResultLoop(ctx, conn, startAck.pipeline_run_id, maxWaitSeconds, itemIndex);
}

/**
 * Start Pipeline op: `POST /v1/start` only — no polling. Output is the
 * StartAck (`{ pipeline_run_id, state, created_at }`); the pipeline_run_id is
 * the point — feed it to Poll & Get Result or Get Run Result later (possibly
 * from another workflow branch or a scheduled workflow).
 */
async function startPipeline(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	itemIndex: number,
): Promise<IDataObject> {
	const startAck = await startRun(ctx, conn, itemIndex);
	// `state` and `created_at` are HOSTED extension fields, not protocol
	// guarantees (the protocol's RunResultStart promises `pipeline_run_id` only),
	// so emit them only when the server actually sent them rather than planting
	// `undefined` keys in the item.
	const json: IDataObject = { pipeline_run_id: startAck.pipeline_run_id };
	if (startAck.state !== undefined) json.state = startAck.state;
	if (startAck.created_at !== undefined) json.created_at = startAck.created_at;
	return json;
}

/**
 * Poll & Get Result op: mthds-js `waitForResult` by id — poll an existing
 * run's results endpoint (same Retry-After-honoring loop as Start & Wait for
 * Result) until terminal or Max Wait; on exceed, the same graceful
 * still-running output.
 */
async function pollRunResult(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	itemIndex: number,
): Promise<IDataObject> {
	const runId = readRunId(ctx, itemIndex);
	const maxWaitSeconds = ctx.getNodeParameter(
		'maxWaitSeconds',
		itemIndex,
		DEFAULT_MAX_WAIT_SECONDS,
	) as number;
	return pollForResultLoop(ctx, conn, runId, maxWaitSeconds, itemIndex);
}

/**
 * Get Run Result op: single-shot result fetch by pipeline_run_id — NO polling.
 * Use it to collect a run that outlived Max Wait (e.g. on a schedule). Maps
 * the one response: completed → result, in-flight (incl. a transient 503) →
 * a still-running payload, terminal failure → error.
 */
async function getRunResult(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	itemIndex: number,
): Promise<IDataObject> {
	const runId = readRunId(ctx, itemIndex);
	const response = await requestResult(ctx, conn, runId);
	const outcome = mapResultResponse(
		response.statusCode,
		(response.body ?? {}) as IDataObject,
		response.headers ?? {},
	);
	if (outcome.kind === 'completed') {
		return { ...outcome.body, status: 'COMPLETED' };
	}
	if (outcome.kind === 'running') {
		return {
			status: 'RUNNING',
			pipeline_run_id: runId,
			message: 'Still running — fetch again later with this pipeline_run_id.',
		};
	}
	// Single-shot cannot poll through the mid-write window, so report it the same
	// way as in-flight: a usable item telling the caller to fetch again. Erroring
	// here would fail a run that is about to be perfectly retrievable.
	if (outcome.kind === 'missingMainStuff') {
		return {
			status: 'RUNNING',
			pipeline_run_id: runId,
			message: RESULT_MID_WRITE_MESSAGE,
		};
	}
	throwResultError(ctx, await enrichFailureOutcome(ctx, conn, runId, outcome), itemIndex);
}

export class Pipelex implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Pipelex',
		name: 'pipelex',
		icon: 'file:pipelex.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle:
			'={{ ({ startAndPoll: "Start & Wait for Result", start: "Start Pipeline", poll: "Poll & Get Result", getResult: "Get Run Result", execute: "Start & Wait for Result" })[$parameter["operation"]] }}',
		description: 'Execute Pipelex pipelines',
		defaults: {
			name: 'Pipelex',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'piplexApi',
				required: true,
			},
		],
		properties: [
			// Four operations mirroring the mthds-js client surface (start /
			// waitForResult / getRunResult — SDK conveniences over the MTHDS
			// Protocol routes). Ordered by typical usage, not alphabetically
			// (the sort lint is advisory and 4 options is under the
			// n8n-nodes-base alphabetize threshold).
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Start & Wait for Result',
						value: 'startAndPoll',
						action: 'Start a pipeline and wait for its result',
						description:
							'Start a durable run and poll internally until it finishes — paste your method + inputs, run, get the result. If Max Wait is exceeded, returns the pipeline_run_id to fetch later.',
					},
					{
						name: 'Start Pipeline',
						value: 'start',
						action: 'Start a pipeline',
						description:
							'Start a durable run and return immediately with its pipeline_run_id (no waiting) — collect the result later with Poll & Get Result or Get Run Result, even from another workflow',
					},
					{
						name: 'Poll & Get Result',
						value: 'poll',
						action: 'Poll a run until its result is ready',
						description:
							'Wait for an already-started run by its pipeline_run_id: poll until it finishes or Max Wait is exceeded (then returns a "still running" output, not an error)',
					},
					{
						name: 'Get Run Result',
						value: 'getResult',
						action: 'Get a run result',
						description:
							'Fetch a run result once by its pipeline_run_id (no polling) — returns status RUNNING while still in flight, the result when completed',
					},
				],
				default: 'startAndPoll',
			},

			// ── Pipeline definition (Start & Wait for Result / Start Pipeline) ────
			// Field order: MTHDS Bundles (the big payload) → Method ID → Inputs →
			// Pipe Code → optional overrides. Run source rule (enforced at
			// runtime, mirroring the server): at least one of Pipe Code / MTHDS
			// Bundles / Method ID. Method ID combines with MTHDS Bundles —
			// inline bundles run, method_id links the run to the stored method.
			// Custom PipeFunc Python for the pasted method. There are exactly two
			// ways to say what to run: a stored Method ID, or MTHDS Bundles (+ these
			// Python files). The API also accepts a base64-zip bundle and arbitrary
			// bundle files; both are deliberately NOT exposed — they were a third and
			// fourth run source in the editor for no user-visible gain. See
			// `assembleRunSources` for how the two halves are sent as one bundle.
			{
				displayName: 'Method ID',
				name: 'methodId',
				type: 'string',
				default: '',
				placeholder: 'e.g., my-stored-method-ID',
				description:
					'ID of a stored method whose MTHDS source supplies the bundle (sent as method_id; hosted API only). Combinable with MTHDS Bundles, or usable alone instead of pasting them inline.',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},
			// The toggle that reveals the inline pair. Two ways to say what to run,
			// and they are mutually exclusive: a stored Method ID (default), or the
			// method pasted inline together with its Python. Gating the pair behind a
			// boolean keeps the closed state to a single field instead of three, and
			// makes the either/or visible in the UI rather than only in an error.
			{
				displayName: 'Define Method Inline',
				name: 'inlineMethod',
				type: 'boolean',
				default: false,
				description:
					'Whether to paste the method here instead of running a stored one. Turn on to supply the MTHDS bundle and any custom PipeFunc Python; leave off to run the method named by Method ID.',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},
			{
				displayName: 'MTHDS Bundles',
				name: 'mthdsContents',
				type: 'fixedCollection',
				// A fixedCollection, matching Python Files — not a multi-value `string`.
				// Both hold the halves of one inline method, so they must look like one
				// control: a multi-value string renders a wide full-width add-button
				// while a fixedCollection renders the compact `+ Add …` row, and the two
				// side by side read as unrelated widgets.
				placeholder: 'Add Bundle',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				description:
					'Your method, pasted inline (sent as mthds_contents) — one entry per bundle file. If the method uses custom PipeFunc Python, add it under Python Files and the two are shipped together.',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
						inlineMethod: [true],
					},
				},
				options: [
					{
						displayName: 'Bundle',
						name: 'bundle',
						values: [
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: {
									rows: 10,
								},
								default: '',
								placeholder: 'domain = "my_domain"\nmain_pipe = "my_pipe"\n…',
								description: 'The MTHDS bundle content',
							},
						],
					},
				],
			},
			{
				displayName: 'Python Files',
				name: 'pythonFiles',
				type: 'fixedCollection',
				// `placeholder` is what labels a fixedCollection's add-button — NOT
				// `typeOptions.multipleValueButtonText`, which only applies to simple
				// multi-value types (the `MTHDS Bundles` string field above). Without
				// it the button renders unlabelled and an empty collection is
				// effectively invisible in the editor, which is exactly how this field
				// went missing the first time.
				placeholder: 'Add Python File',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				description:
					'Custom PipeFunc Python for the method pasted above — the funcs/*.py and structures/*.py it needs, plus an optional requirements.txt. The node ships the method and its Python together as one bundle. Leave empty unless your method uses PipeFunc. Requires a sandbox-hosted runner (the hosted Pipelex API is; a bare self-hosted pipelex-api refuses custom Python).',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
						inlineMethod: [true],
					},
				},
				options: [
					{
						displayName: 'File',
						name: 'file',
						values: [
							{
								displayName: 'Path',
								name: 'path',
								type: 'string',
								default: '',
								placeholder: 'e.g., funcs/score.py',
								description:
									'Path relative to the bundle root, using forward slashes. Must match what your method references.',
							},
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: {
									rows: 10,
								},
								default: '',
								placeholder: 'def score(text: str) -> float:\n    ...',
								description: 'The Python source',
							},
						],
					},
				],
			},
			{
				displayName: 'Inputs',
				name: 'inputs',
				type: 'json',
				default: '{}',
				description:
					'The inputs for the pipeline. Defaults to {} server-side if omitted. See <a href="https://docs.pipelex.com/pages/api/" target="_blank">Pipelex API docs</a> for the expected format.',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},
			{
				displayName: 'Pipe Code',
				name: 'pipeCode',
				type: 'string',
				default: '',
				placeholder: 'e.g., my-pipeline-code',
				description:
					'The code of the pipe to execute (registered on the server, or defined in the MTHDS Bundles)',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},
			{
				displayName: 'Output Name',
				name: 'outputName',
				type: 'string',
				default: '',
				description: 'Optional name of the output variable',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},
			{
				displayName: 'Output Multiplicity',
				name: 'outputMultiplicity',
				type: 'string',
				default: '',
				description: 'Optional output multiplicity',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},
			{
				displayName: 'Dynamic Output Concept Ref',
				name: 'dynamicOutputConceptRef',
				type: 'string',
				default: '',
				description:
					'Optional override for the dynamic output concept ref (sent as dynamic_output_concept_ref)',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},

			// ── Run target (Poll & Get Result / Get Run Result) ───────────────────
			{
				displayName: 'Pipeline Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g., f56566eb-1b60-4e5b-834e-0cdcf3bf1374',
				description:
					'The pipeline_run_id returned by Start Pipeline (or by a "still running" output). Map the upstream pipeline_run_id field here.',
				displayOptions: {
					show: {
						operation: RUN_ID_OPERATIONS,
					},
				},
			},

			// ── Polling control (Start & Wait for Result / Poll & Get Result) ─────
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWaitSeconds',
				type: 'number',
				default: DEFAULT_MAX_WAIT_SECONDS,
				typeOptions: {
					minValue: 0,
				},
				description:
					'Maximum seconds to wait for the run to finish (default 300). If exceeded, the node returns the pipeline_run_id with a "still running" message so you can fetch the result later with "Get Run Result" or keep waiting with "Poll & Get Result". 0 waits indefinitely (only sensible on self-hosted n8n without execution timeouts).',
				displayOptions: {
					show: {
						operation: POLLING_OPERATIONS,
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// The Authorization header is built manually from the credential (see
		// buildApiConnection) — the credential deliberately has no generic
		// `authenticate` block, so n8n does not inject a "Custom API Call"
		// entry into the Operation dropdown.
		const credentials = await this.getCredentials('piplexApi');
		const conn = buildApiConnection(credentials);
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let json: IDataObject;
				switch (operation) {
					// `execute` is the saved-operation value of the published 0.0.x
					// node (its start+internal-poll "Execute Pipeline" op). It is no
					// longer offered in the dropdown but keeps mapping to the same
					// semantics — Start & Wait for Result — so existing workflows
					// keep running unchanged. (Comment sits above the case pair: a
					// comment-only case would trip `no-fallthrough`.)
					case 'startAndPoll':
					case 'execute':
						json = await startAndWaitForResult(this, conn, i);
						break;
					case 'start':
						json = await startPipeline(this, conn, i);
						break;
					case 'poll':
						json = await pollRunResult(this, conn, i);
						break;
					case 'getResult':
						json = await getRunResult(this, conn, i);
						break;
					default:
						throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
							itemIndex: i,
						});
				}
				returnData.push({ json: sanitizeResult(json), pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				// Re-throw n8n errors unchanged (preserving httpCode / body / context);
				// only genuinely-unknown errors get wrapped. See rethrowOpError.
				rethrowOpError(this, error, i);
			}
		}

		return [returnData];
	}
}
