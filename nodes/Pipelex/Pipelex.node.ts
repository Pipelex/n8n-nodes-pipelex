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
	requestResult,
	requestStart,
	type ResultOutcome,
} from './GenericFunctions';
import type { HostedStartBody } from './MthdsShapes';

// Polling defaults. Max Wait caps how long Execute Pipeline blocks the n8n
// execution — 300s covers the overwhelming majority of runs while staying
// safely under typical n8n Cloud execution caps. On exceed the node returns
// the pipeline_run_id + a "still running" payload (NOT an error) so the run
// can be fetched later with Get Run Result. 0 = wait indefinitely (self-hosted
// n8n with no execution timeout).
const DEFAULT_MAX_WAIT_SECONDS = 300;
// Floor on the sleep between polls — guards against a hot loop if the server
// ever sends `Retry-After: 0`. (When the header is absent, the mapper already
// defaults to 5s.)
const MIN_POLL_SLEEP_MS = 250;

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
 * Collect + validate the pipeline-definition fields of Execute Pipeline and
 * map them to the snake_case `POST /v1/start` body. Mirrors the server's
 * run-source rules client-side so the errors are immediate and item-scoped:
 * at least one of pipe_code / mthds_contents / method_id, and method_id is
 * mutually exclusive with mthds_contents (a stored method IS the bundle).
 */
function readRunDefinition(ctx: IExecuteFunctions, itemIndex: number): HostedStartBody {
	const pipeCode = ctx.getNodeParameter('pipeCode', itemIndex, '') as string;
	const methodId = ctx.getNodeParameter('methodId', itemIndex, '') as string;
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

	if (methodId && mthdsContents.length > 0) {
		throw new NodeOperationError(
			ctx.getNode(),
			'"Method ID" and "MTHDS Bundles" are mutually exclusive — a stored method already supplies the bundle. Provide one or the other.',
			{ itemIndex },
		);
	}
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
		case 'unexpected':
			throw new NodeApiError(ctx.getNode(), outcome.body as JsonObject, {
				message: outcome.message,
				httpCode: String(outcome.statusCode),
				itemIndex,
			});
	}
}

/**
 * Poll a run's results endpoint until it reaches a terminal state. Honors the
 * server's `Retry-After` (default 5s when absent; a 503 mid-poll also reads as
 * "keep polling", mirroring mthds-js — never fail a poller on a blip). With
 * `maxWaitSeconds <= 0` this polls indefinitely (the n8n execution's own
 * timeout is the only ceiling); with a positive cap it returns the
 * pipeline_run_id + a "still running" payload on exceed so the run isn't lost.
 */
async function pollForResultLoop(
	ctx: IExecuteFunctions,
	baseUrl: string,
	runId: string,
	maxWaitSeconds: number,
	itemIndex: number,
): Promise<IDataObject> {
	const abortSignal = ctx.getExecutionCancelSignal();
	const unbounded = !maxWaitSeconds || maxWaitSeconds <= 0;
	const deadline = unbounded ? Number.POSITIVE_INFINITY : Date.now() + maxWaitSeconds * 1000;

	for (;;) {
		const response = await requestResult(ctx, baseUrl, runId);
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

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			// Graceful degrade — don't lose the run. The output is a usable item
			// (NOT an error): feed the pipeline_run_id to Get Run Result later.
			return runStillRunning(runId);
		}
		// Honor the server's Retry-After (the mapper defaults it to 5s when
		// absent), but never sleep past the deadline (Infinity when unbounded).
		const requestedMs = outcome.retryAfterSeconds * 1000;
		const sleepMs = Math.max(Math.min(requestedMs, remainingMs), MIN_POLL_SLEEP_MS);
		await sleepWithAbort(sleepMs, abortSignal);
	}
}

/** The graceful-degrade payload when a bounded poll exceeds its Max Wait. */
function runStillRunning(runId: string): IDataObject {
	return {
		status: 'RUNNING',
		pipeline_run_id: runId,
		message:
			'Still running after Max Wait. Fetch it later with the "Get Run Result" operation and this pipeline_run_id.',
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
 * Execute Pipeline op (default): `POST /v1/start` (with an idempotency key,
 * 202 StartAck), then poll `GET /v1/runs/{pipeline_run_id}/results` internally
 * until the run finishes or Max Wait is exceeded. One node, no Wait-loop to
 * assemble — the polling is invisible to the user.
 */
async function executePipeline(
	ctx: IExecuteFunctions,
	baseUrl: string,
	itemIndex: number,
): Promise<IDataObject> {
	const body = readRunDefinition(ctx, itemIndex);
	const idempotency = idempotencyKey(ctx.getExecutionId(), ctx.getNode().id, itemIndex);
	const startAck = await requestStart(ctx, baseUrl, body, idempotency, itemIndex);
	const runId = startAck.pipeline_run_id;
	if (!runId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Run started but the server returned no pipeline_run_id',
			{ itemIndex },
		);
	}
	const maxWaitSeconds = ctx.getNodeParameter(
		'maxWaitSeconds',
		itemIndex,
		DEFAULT_MAX_WAIT_SECONDS,
	) as number;
	return pollForResultLoop(ctx, baseUrl, runId, maxWaitSeconds, itemIndex);
}

/**
 * Get Run Result op (the escape hatch): single-shot result fetch by
 * pipeline_run_id — NO polling. Use it to collect a run that outlived Max Wait
 * on Execute Pipeline. Maps the one response: completed → result, in-flight
 * (incl. a transient 503) → a still-running payload, terminal failure → error.
 */
async function getRunResult(
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
			'={{ ({ execute: "Execute Pipeline", getResult: "Get Run Result" })[$parameter["operation"]] }}',
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
						name: 'Execute Pipeline',
						value: 'execute',
						action: 'Execute a pipeline and wait for its result',
						description:
							'Start a durable run and poll internally until it finishes — paste your method + inputs, run, get the result. If Max Wait is exceeded, returns the pipeline_run_id to fetch later with Get Run Result.',
					},
					{
						name: 'Get Run Result',
						value: 'getResult',
						action: 'Get a run result',
						description:
							'Fetch a run result once by its pipeline_run_id (no polling) — the follow-up for a run that outlived Max Wait',
					},
				],
				default: 'execute',
			},

			// ── Pipeline definition (Execute Pipeline) ────────────────────────────
			// Field order: MTHDS Bundles (the big payload) → Inputs → Pipe Code →
			// Method ID → optional overrides. Run source rules (enforced at
			// runtime, mirroring the server): at least one of Pipe Code / MTHDS
			// Bundles / Method ID; Method ID and MTHDS Bundles are mutually
			// exclusive.
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
					'One or more inline MTHDS bundle contents (sent as mthds_contents). Mutually exclusive with Method ID.',
				displayOptions: {
					show: {
						operation: ['execute'],
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
						operation: ['execute'],
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
						operation: ['execute'],
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
					'ID of a stored method whose MTHDS source supplies the bundle (sent as method_id; hosted API only). Mutually exclusive with MTHDS Bundles — an alternative to pasting them inline.',
				displayOptions: {
					show: {
						operation: ['execute'],
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
						operation: ['execute'],
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
						operation: ['execute'],
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
						operation: ['execute'],
					},
				},
			},
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWaitSeconds',
				type: 'number',
				default: DEFAULT_MAX_WAIT_SECONDS,
				typeOptions: {
					minValue: 0,
				},
				description:
					'Maximum seconds to wait for the run to finish (default 300). If exceeded, the node returns the pipeline_run_id with a "still running" message so you can fetch the result later with "Get Run Result". 0 waits indefinitely (only sensible on self-hosted n8n without execution timeouts).',
				displayOptions: {
					show: {
						operation: ['execute'],
					},
				},
			},

			// ── Run target (Get Run Result) ───────────────────────────────────────
			{
				displayName: 'Pipeline Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g., f56566eb-1b60-4e5b-834e-0cdcf3bf1374',
				description:
					'The pipeline_run_id returned by Execute Pipeline (in its "still running" output). Map the upstream pipeline_run_id field here.',
				displayOptions: {
					show: {
						operation: ['getResult'],
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
						json = await executePipeline(this, baseUrl, i);
						break;
					case 'getResult':
						json = await getRunResult(this, baseUrl, i);
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
