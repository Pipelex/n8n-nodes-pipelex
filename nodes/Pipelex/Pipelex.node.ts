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
	buildStartBody,
	idempotencyKey,
	mapResultResponse,
	requestExecute,
	requestResult,
	requestStart,
	SERVICE_UNAVAILABLE_MESSAGE,
	type PipelexStartBody,
} from './GenericFunctions';

// Polling defaults. Max Wait is UNBOUNDED by default (0) — the node keeps polling
// until the run reaches a terminal state. Set it above 0 to cap the wait; on
// exceed the node returns the run_id + a "still running" message so the run can
// be fetched later with "Poll for Result".
const DEFAULT_MAX_WAIT_SECONDS = 0;
const DEFAULT_POLL_INTERVAL_SECONDS = 2;
// Floor on the sleep between polls — guards against a hot loop if the user sets
// poll interval to 0 and the server sends no Retry-After.
const MIN_POLL_SLEEP_MS = 250;
// How many CONSECUTIVE gateway 5xx (transient) responses the poll loop tolerates
// before failing. Bounds an outage so an unbounded (Max Wait = 0) poll can't hang
// forever on a dead backend; a recovered backend resets the counter.
const MAX_CONSECUTIVE_TRANSIENT = 5;

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
 * Collect + validate the pipeline-definition fields shared by Execute, Start,
 * and Start & Poll, and map them to the snake_case request body. `methodId` is
 * a platform-only concept, so it is read only when `includeMethodId` is set
 * (the blocking runner execute has no `method_id`).
 */
function readRunDefinition(
	ctx: IExecuteFunctions,
	itemIndex: number,
	includeMethodId: boolean,
): PipelexStartBody {
	const pipeCode = ctx.getNodeParameter('pipeCode', itemIndex, '') as string;
	const mthdsContentsRaw = ctx.getNodeParameter('mthdsContents', itemIndex, []) as unknown;
	const inputsString = ctx.getNodeParameter('inputs', itemIndex, '{}') as string;
	const outputName = ctx.getNodeParameter('outputName', itemIndex, '') as string;
	const outputMultiplicity = ctx.getNodeParameter('outputMultiplicity', itemIndex, '') as string;
	const dynamicOutputConceptRef = ctx.getNodeParameter(
		'dynamicOutputConceptRef',
		itemIndex,
		'',
	) as string;
	const methodId = includeMethodId
		? (ctx.getNodeParameter('methodId', itemIndex, '') as string)
		: '';

	// `multipleValues: true` on a string field yields a `string[]`; drop the empty
	// (and whitespace-only) entries the UI persists when "Add Bundle" is clicked
	// without typing — a blank bundle must not slip past the guard below.
	const mthdsContents: string[] = Array.isArray(mthdsContentsRaw)
		? (mthdsContentsRaw as string[]).filter(
				(entry) => typeof entry === 'string' && entry.trim().length > 0,
			)
		: [];

	if (!pipeCode && mthdsContents.length === 0) {
		throw new NodeOperationError(
			ctx.getNode(),
			'At least one of "Pipe Code" or "MTHDS Bundles" must be provided',
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

function readPollParams(
	ctx: IExecuteFunctions,
	itemIndex: number,
): { maxWaitSeconds: number; pollIntervalSeconds: number } {
	const maxWaitSeconds = ctx.getNodeParameter(
		'maxWaitSeconds',
		itemIndex,
		DEFAULT_MAX_WAIT_SECONDS,
	) as number;
	const pollIntervalSeconds = ctx.getNodeParameter(
		'pollIntervalSeconds',
		itemIndex,
		DEFAULT_POLL_INTERVAL_SECONDS,
	) as number;
	return { maxWaitSeconds, pollIntervalSeconds };
}

/**
 * Poll a run's result endpoint until it reaches a terminal state. With
 * `maxWaitSeconds <= 0` this polls indefinitely (the n8n execution's own timeout
 * is the only ceiling); with a positive cap it returns the run_id + a "still
 * running" payload on exceed so the run isn't lost.
 */
async function pollForResultLoop(
	ctx: IExecuteFunctions,
	baseUrl: string,
	runId: string,
	maxWaitSeconds: number,
	pollIntervalSeconds: number,
	itemIndex: number,
): Promise<IDataObject> {
	const abortSignal = ctx.getExecutionCancelSignal();
	const unbounded = !maxWaitSeconds || maxWaitSeconds <= 0;
	const deadline = unbounded ? Number.POSITIVE_INFINITY : Date.now() + maxWaitSeconds * 1000;
	let consecutiveTransient = 0;

	for (;;) {
		const response = await requestResult(ctx, baseUrl, runId);
		const outcome = mapResultResponse(
			response.statusCode,
			(response.body ?? {}) as IDataObject,
			response.headers ?? {},
		);

		// Only a 202 is an in-flight signal; reset the outage counter on anything else.
		if (outcome.kind !== 'transient') {
			consecutiveTransient = 0;
		}

		switch (outcome.kind) {
			case 'completed':
				return { done: true, status: 'COMPLETED', ...outcome.body };
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
			case 'unexpected':
				throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
					message: outcome.message,
					httpCode: String(outcome.statusCode),
					itemIndex,
				});
			case 'transient': {
				// Gateway/backend outage — tolerate a few in a row (a blip shouldn't
				// lose the run), but fail rather than hang an unbounded poll forever.
				consecutiveTransient += 1;
				if (consecutiveTransient > MAX_CONSECUTIVE_TRANSIENT) {
					throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
						message: SERVICE_UNAVAILABLE_MESSAGE,
						httpCode: String(outcome.statusCode),
						itemIndex,
					});
				}
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					return runStillRunning(runId);
				}
				const requestedMs =
					Math.max(pollIntervalSeconds, outcome.retryAfterSeconds ?? 0) * 1000;
				const sleepMs = Math.max(Math.min(requestedMs, remainingMs), MIN_POLL_SLEEP_MS);
				await sleepWithAbort(sleepMs, abortSignal);
				break;
			}
			case 'running': {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					// Graceful degrade — don't lose the run. Fetch it later via the
					// "Poll for Result" operation with this run ID.
					return runStillRunning(runId);
				}
				// Honor the server's Retry-After when it asks for a longer wait, but
				// never sleep past the deadline (which is Infinity when unbounded).
				const requestedMs =
					Math.max(pollIntervalSeconds, outcome.retryAfterSeconds ?? 0) * 1000;
				const sleepMs = Math.max(Math.min(requestedMs, remainingMs), MIN_POLL_SLEEP_MS);
				await sleepWithAbort(sleepMs, abortSignal);
				break;
			}
		}
	}
}

/** The graceful-degrade payload when a bounded poll exceeds its Max Wait. */
function runStillRunning(runId: string): IDataObject {
	return {
		done: false,
		status: 'RUNNING',
		pipeline_run_id: runId,
		message:
			'Still running after Max Wait. Fetch it later with the "Poll for Result" operation and this run ID.',
	};
}

/** Execute op: blocking, one-shot runner call. */
async function executeOneShot(
	ctx: IExecuteFunctions,
	baseUrl: string,
	itemIndex: number,
): Promise<IDataObject> {
	const body = readRunDefinition(ctx, itemIndex, false);
	return requestExecute(ctx, baseUrl, body, itemIndex);
}

/** Start op: start a durable run and return its pipeline_run_id immediately. */
async function startRun(
	ctx: IExecuteFunctions,
	baseUrl: string,
	itemIndex: number,
): Promise<IDataObject> {
	const body = readRunDefinition(ctx, itemIndex, true);
	const idempotency = idempotencyKey(ctx.getExecutionId(), ctx.getNode().id, itemIndex);
	return requestStart(ctx, baseUrl, body, idempotency, itemIndex);
}

/** Poll op: poll an existing run (by id) until it finishes, then return it. */
async function pollForResult(
	ctx: IExecuteFunctions,
	baseUrl: string,
	itemIndex: number,
): Promise<IDataObject> {
	const runId = ctx.getNodeParameter('runId', itemIndex, '') as string;
	if (!runId) {
		throw new NodeOperationError(ctx.getNode(), 'Pipeline Run ID is required', { itemIndex });
	}
	const { maxWaitSeconds, pollIntervalSeconds } = readPollParams(ctx, itemIndex);
	return pollForResultLoop(ctx, baseUrl, runId, maxWaitSeconds, pollIntervalSeconds, itemIndex);
}

/**
 * Get Result op: single-shot result fetch by id — NO polling. Maps the one
 * response: COMPLETED → result, in-flight → a not-done payload, terminal-failure
 * → error. Use when you just want the current state in one call (Poll for Result
 * is the waiting variant).
 */
async function getResultOnce(
	ctx: IExecuteFunctions,
	baseUrl: string,
	itemIndex: number,
): Promise<IDataObject> {
	const runId = ctx.getNodeParameter('runId', itemIndex, '') as string;
	if (!runId) {
		throw new NodeOperationError(ctx.getNode(), 'Pipeline Run ID is required', { itemIndex });
	}
	const response = await requestResult(ctx, baseUrl, runId);
	const outcome = mapResultResponse(
		response.statusCode,
		(response.body ?? {}) as IDataObject,
		response.headers ?? {},
	);
	switch (outcome.kind) {
		case 'completed':
			return { done: true, status: 'COMPLETED', ...outcome.body };
		case 'running':
			return {
				done: false,
				status: 'RUNNING',
				pipeline_run_id: runId,
				message: 'Still running — fetch again later, or use "Poll for Result" to wait for it.',
			};
		case 'transient':
			// A single-shot fetch must not report an outage as "still running".
			throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
				message: SERVICE_UNAVAILABLE_MESSAGE,
				httpCode: String(outcome.statusCode),
				itemIndex,
			});
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
		case 'unexpected':
			throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
				message: outcome.message,
				httpCode: String(outcome.statusCode),
				itemIndex,
			});
	}
}

/** Start & Poll op: start a durable run, then poll it to completion. */
async function startAndPoll(
	ctx: IExecuteFunctions,
	baseUrl: string,
	itemIndex: number,
): Promise<IDataObject> {
	const body = readRunDefinition(ctx, itemIndex, true);
	const idempotency = idempotencyKey(ctx.getExecutionId(), ctx.getNode().id, itemIndex);
	const startResponse = await requestStart(ctx, baseUrl, body, idempotency, itemIndex);
	const runId = startResponse.pipeline_run_id as string | undefined;
	if (!runId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Run started but the platform returned no pipeline_run_id',
			{ itemIndex },
		);
	}
	const { maxWaitSeconds, pollIntervalSeconds } = readPollParams(ctx, itemIndex);
	return pollForResultLoop(ctx, baseUrl, runId, maxWaitSeconds, pollIntervalSeconds, itemIndex);
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
			'={{ ({ execute: "Execute (One-Shot)", getResult: "Get Result", start: "Start Run", poll: "Poll for Result", startAndPoll: "Start & Poll" })[$parameter["operation"]] }}',
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
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Execute (One-Shot)',
						value: 'execute',
						action: 'Execute a pipeline and wait',
						description:
							'Blocking call that returns the result in a single request. Times out at ~30s on the public Pipelex API.',
					},
					{
						name: 'Get Result',
						value: 'getResult',
						action: 'Get a run result',
						description: 'Fetch a run result once by its pipeline_run_id, without polling',
					},
					{
						name: 'Poll for Result',
						value: 'poll',
						action: 'Poll a run for its result',
						description: 'Poll a run by its pipeline_run_id until it finishes, then return the result',
					},
					{
						name: 'Start & Poll',
						value: 'startAndPoll',
						action: 'Start a run and poll for its result',
						description: 'Start a durable run and poll internally until it finishes, then return the result',
					},
					{
						name: 'Start Run',
						value: 'start',
						action: 'Start a pipeline run',
						description: 'Start a durable run and return its pipeline_run_id immediately (no waiting)',
					},
				],
				default: 'startAndPoll',
			},

			{
				displayName:
					'Blocking call — the public Pipelex API closes synchronous requests at ~30s. For longer pipelines use "Start & Poll" (or "Start" then "Poll for Result").',
				name: 'executeTimeoutNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						operation: ['execute'],
					},
				},
			},

			// ── Pipeline definition (Execute / Start / Start & Poll) ──────────────
			// Field order: MTHDS Bundles (the big payload) → Inputs → Pipe Code →
			// optional overrides. Pipe Code and MTHDS Bundles are mutually-exclusive
			// but one is REQUIRED; XOR enforced at runtime.
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
					'One or more MTHDS bundle contents (sent as mthds_contents). Provide at least one OR a Pipe Code.',
				displayOptions: {
					show: {
						operation: ['execute', 'start', 'startAndPoll'],
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
						operation: ['execute', 'start', 'startAndPoll'],
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
					'The code of the pipe to execute. Provide this OR MTHDS Bundles (one is required).',
				displayOptions: {
					show: {
						operation: ['execute', 'start', 'startAndPoll'],
					},
				},
			},
			{
				displayName: 'Method ID',
				name: 'methodId',
				type: 'string',
				default: '',
				placeholder: 'e.g., my-stored-method-reference',
				description:
					'Optional ID of a stored method to associate this run with (sent as method_id)',
				displayOptions: {
					show: {
						operation: ['start', 'startAndPoll'],
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
						operation: ['execute', 'start', 'startAndPoll'],
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
						operation: ['execute', 'start', 'startAndPoll'],
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
						operation: ['execute', 'start', 'startAndPoll'],
					},
				},
			},

			// ── Poll target (Poll for Result) ────────────────────────────────────
			{
				displayName: 'Pipeline Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g., f56566eb-1b60-4e5b-834e-0cdcf3bf1374',
				description:
					'The pipeline_run_id returned by a Start or Start & Poll operation. Map the upstream pipeline_run_id field here.',
				displayOptions: {
					show: {
						operation: ['getResult', 'poll'],
					},
				},
			},

			// ── Polling controls (Poll for Result / Start & Poll) ─────────────────
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWaitSeconds',
				type: 'number',
				default: DEFAULT_MAX_WAIT_SECONDS,
				typeOptions: {
					minValue: 0,
				},
				description:
					'Maximum seconds to wait for the run to finish. 0 (default) waits indefinitely. If set above 0 and exceeded, the node returns the run ID with a "still running" message so you can fetch it later with "Poll for Result".',
				displayOptions: {
					show: {
						operation: ['poll', 'startAndPoll'],
					},
				},
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollIntervalSeconds',
				type: 'number',
				default: DEFAULT_POLL_INTERVAL_SECONDS,
				typeOptions: {
					minValue: 0,
				},
				description:
					'How often to check whether the run has finished. The server may request a longer interval, which is honored.',
				displayOptions: {
					show: {
						operation: ['poll', 'startAndPoll'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('piplexApi');
		const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let json: IDataObject;
				switch (operation) {
					case 'execute':
						json = await executeOneShot(this, baseUrl, i);
						break;
					case 'start':
						json = await startRun(this, baseUrl, i);
						break;
					case 'getResult':
						json = await getResultOnce(this, baseUrl, i);
						break;
					case 'poll':
						json = await pollForResult(this, baseUrl, i);
						break;
					case 'startAndPoll':
						json = await startAndPoll(this, baseUrl, i);
						break;
					default:
						throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
							itemIndex: i,
						});
				}
				returnData.push({ json, pairedItem: { item: i } });
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
