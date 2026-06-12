import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleepWithAbort,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import {
	SERVICE_UNAVAILABLE_MESSAGE,
	buildApiConnection,
	buildStartBody,
	idempotencyKey,
	mapResultResponse,
	requestResult,
	requestStart,
	type ApiConnection,
	type ResultOutcome,
} from './GenericFunctions';
import type { HostedStartBody, StartAck } from './MthdsShapes';

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
 * Collect + validate the pipeline-definition fields of the start operations
 * and map them to the snake_case `POST /v1/start` body. Mirrors the server's
 * run-source rules client-side so the errors are immediate and item-scoped:
 * at least one of pipe_code / mthds_contents / method_id, and method_id is
 * combinable with mthds_contents (inline bundles run; method_id is the
 * run-history linkage on the hosted API).
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

	// `multipleValues: true` on a string field yields a `string[]`; drop the empty
	// (and whitespace-only) entries the UI persists when "Add Bundle" is clicked
	// without typing — a blank bundle must not slip past the guards below.
	const mthdsContents: string[] = Array.isArray(mthdsContentsRaw)
		? (mthdsContentsRaw as string[]).filter(
				(entry) => typeof entry === 'string' && entry.trim().length > 0,
			)
		: [];

	// Method ID and MTHDS Bundles may both be set: the hosted API runs the
	// inline bundles (precedence) and records method_id as the run-history
	// linkage — no client-side exclusion.
	if (!pipeCode && mthdsContents.length === 0 && !methodId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Provide at least one of "Pipe Code", "MTHDS Bundles", or "Method ID"',
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

	return buildStartBody({
		pipeCode,
		methodId,
		mthdsContents,
		inputs,
		outputName,
		outputMultiplicity,
		dynamicOutputConceptRef,
	});
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

	for (;;) {
		const response = await requestResult(ctx, conn, runId);
		const outcome = mapResultResponse(
			response.statusCode,
			(response.body ?? {}) as IDataObject,
			response.headers ?? {},
		);

		if (outcome.kind === 'completed') {
			return { status: 'COMPLETED', ...outcome.body };
		}
		if (outcome.kind !== 'running') {
			throwResultError(ctx, outcome, itemIndex);
		}

		// A 503 (degraded) is tolerated as "keep polling", but a sustained outage
		// must not spin forever (esp. unbounded). A normal in-flight 202 resets
		// the counter; consecutive 503s trip the ceiling into an actionable error
		// that still hands back the pipeline_run_id for a later Get Run Result.
		if (outcome.degraded) {
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
		await sleepWithAbort(sleepMs, abortSignal);
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
	return {
		pipeline_run_id: startAck.pipeline_run_id,
		state: startAck.state,
		created_at: startAck.created_at,
	};
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
		return { status: 'COMPLETED', ...outcome.body };
	}
	if (outcome.kind === 'running') {
		return {
			status: 'RUNNING',
			pipeline_run_id: runId,
			message: 'Still running — fetch again later with this pipeline_run_id.',
		};
	}
	throwResultError(ctx, outcome, itemIndex);
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
			{
				displayName: 'MTHDS Bundles',
				name: 'mthdsContents',
				type: 'string',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Bundle',
					rows: 10,
				},
				default: [],
				placeholder: 'Enter MTHDS bundle content...',
				description:
					'One or more inline MTHDS bundle contents (sent as mthds_contents). Combinable with Method ID — inline bundles run, method_id links the run to the stored method.',
				displayOptions: {
					show: {
						operation: START_OPERATIONS,
					},
				},
			},
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
