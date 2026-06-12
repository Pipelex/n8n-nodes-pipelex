import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, IN8nHttpFullResponse, INodeProperties } from 'n8n-workflow';

// Make the internal poll loop instant — replace the real (timer-backed)
// sleepWithAbort with a no-op, keep everything else (NodeApiError, etc.) real.
vi.mock('n8n-workflow', async (importOriginal) => {
	const actual = await importOriginal<typeof import('n8n-workflow')>();
	return { ...actual, sleepWithAbort: vi.fn(async () => {}) };
});

import { FORBIDDEN_MESSAGE, NOT_FOUND_MESSAGE } from '../nodes/Pipelex/GenericFunctions';
import { Pipelex } from '../nodes/Pipelex/Pipelex.node';

type HttpImpl = (options: {
	method?: string;
	url: string;
	[key: string]: unknown;
}) => IN8nHttpFullResponse | Promise<IN8nHttpFullResponse>;

interface ContextOptions {
	operation: string;
	params?: Record<string, unknown>;
	httpImpl: HttpImpl;
	continueOnFail?: boolean;
	items?: Array<{ json: Record<string, unknown> }>;
}

function makeContext(opts: ContextOptions): {
	ctx: IExecuteFunctions;
	httpFn: ReturnType<typeof vi.fn>;
} {
	const params = opts.params ?? {};
	// The node uses ctx.helpers.httpRequest (manual Authorization header — the
	// credential has no `authenticate` block; see PiplexApi.credentials.ts).
	const httpFn = vi.fn(async (options: { url: string }) => opts.httpImpl(options));

	const ctx = {
		getInputData: () => opts.items ?? [{ json: {} }],
		getCredentials: async () => ({ baseUrl: 'https://api.test', apiKey: 'secret-token' }),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'operation') return opts.operation;
			return name in params ? params[name] : fallback;
		},
		getExecutionId: () => 'exec-1',
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => opts.continueOnFail ?? false,
		getNode: () => ({ id: 'node-1', name: 'Pipelex', type: 'pipelex', typeVersion: 1 }),
		helpers: { httpRequest: httpFn },
	} as unknown as IExecuteFunctions;

	return { ctx, httpFn };
}

function fullResponse(
	statusCode: number,
	body: Record<string, unknown>,
	headers: Record<string, unknown> = {},
): IN8nHttpFullResponse {
	return { statusCode, body, headers } as IN8nHttpFullResponse;
}

const START_ACK = { pipeline_run_id: 'run-1', state: 'STARTED', created_at: '2026-06-10T00:00:00Z' };

const COMPLETED_RESULT = {
	pipeline_run_id: 'run-1',
	main_stuff: { answer: 42 },
	graph_spec: { nodes: [] },
};

/** start → 202 StartAck; results → whatever `resultImpl` says. */
function startThenResults(resultImpl: HttpImpl): HttpImpl {
	return (options) => (options.method === 'POST' ? fullResponse(202, START_ACK) : resultImpl(options));
}

afterEach(() => vi.restoreAllMocks());

describe('Pipelex node — Start & Wait for Result (start + internal poll)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('starts via POST /v1/start (with idempotency key + manual auth header) then polls /v1/runs/{id}/results to completion', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'my-pipe', inputs: '{"a":1}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.status).toBe('COMPLETED');
		expect(json.main_stuff).toEqual({ answer: 42 });
		// n8n output strips the heavy graph_spec artifact and the legacy `done`
		// flag; `status` is the single completion signal.
		expect(json.graph_spec).toBeUndefined();
		expect(json.done).toBeUndefined();

		const startCall = httpFn.mock.calls[0][0];
		expect(startCall.url).toBe('https://api.test/v1/start');
		expect(startCall.headers['Idempotency-Key']).toBe('exec-1:node-1:0');
		expect(startCall.headers.Authorization).toBe('Bearer secret-token');
		expect(startCall.body).toEqual({ pipe_code: 'my-pipe', inputs: { a: 1 } });
		const resultCall = httpFn.mock.calls[1][0];
		expect(resultCall.url).toBe('https://api.test/v1/runs/run-1/results');
		expect(resultCall.headers.Authorization).toBe('Bearer secret-token');
	});

	it('sends method_id in the start body (stored-method alternative to inline bundles)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { methodId: 'method-42', inputs: '{}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({ method_id: 'method-42', inputs: {} });
	});

	it('sends method_id + MTHDS bundles together (inline bundles run; method_id links run history)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { methodId: 'method-42', mthdsContents: ['bundle'], inputs: '{}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({
			method_id: 'method-42',
			mthds_contents: ['bundle'],
			inputs: {},
		});
	});

	it('keeps polling while running (202), honoring Retry-After, then returns when completed', async () => {
		let resultCalls = 0;
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() => {
				resultCalls += 1;
				return resultCalls < 3
					? fullResponse(202, {}, { 'retry-after': '1' })
					: fullResponse(200, COMPLETED_RESULT);
			}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(resultCalls).toBe(3);
		expect(result[0][0].json.status).toBe('COMPLETED');
	});

	it('treats a 503 mid-poll as still running (keeps polling, run is not lost)', async () => {
		let resultCalls = 0;
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() => {
				resultCalls += 1;
				return resultCalls < 3 ? fullResponse(503, {}) : fullResponse(200, COMPLETED_RESULT);
			}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(resultCalls).toBe(3);
		expect(result[0][0].json.status).toBe('COMPLETED');
	});

	it('returns the pipeline_run_id with a "still running" output (not an error) when Max Wait is exceeded', async () => {
		// deadline = 0 + 1*1000; remaining check sees now = 100_000 → exceeded.
		vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(100_000);
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}', maxWaitSeconds: 1 },
			httpImpl: startThenResults(() => fullResponse(202, {})),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.status).toBe('RUNNING');
		expect(json.pipeline_run_id).toBe('run-1');
		expect(String(json.message)).toContain('Get Run Result');
	});

	it('raises an actionable NodeApiError on a 403 start (D3: unscoped key)', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(FORBIDDEN_MESSAGE);
	});

	it('surfaces a failed start with its problem detail', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(503, { detail: 'Failed to start pipeline' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow('Failed to start pipeline');
	});

	it('raises on a failed (409) run with the server problem detail', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() =>
				fullResponse(409, { detail: 'Run finished with status FAILED; no result available' }),
			),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			'Run finished with status FAILED',
		);
	});

	it('passes a completed result without graph_spec/done through unchanged', async () => {
		// sanitizeResult must be strip-only: a body that never had graph_spec/done
		// keeps every field (notably main_stuff). Whole-object equality catches an
		// accidental allowlist refactor that drops kept fields.
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() =>
				fullResponse(200, { pipeline_run_id: 'run-1', main_stuff: { answer: 7 } }),
			),
		});

		const json = (await Pipelex.prototype.execute.call(ctx))[0][0].json;
		expect(json).toEqual({
			status: 'COMPLETED',
			pipeline_run_id: 'run-1',
			main_stuff: { answer: 7 },
		});
	});

	it('captures the error as an item when continueOnFail is on', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			continueOnFail: true,
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.error).toBe(FORBIDDEN_MESSAGE);
	});

	it('fails fast (no run) when no run source is provided', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: '', mthdsContents: [], methodId: '', inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Pipe Code');
		expect(httpFn).not.toHaveBeenCalled();
	});
});

describe('Pipelex node — legacy `execute` operation value (published 0.0.x)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('maps to Start & Wait for Result: starts then polls to completion', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'execute',
			params: { pipeCode: 'my-pipe', inputs: '{"a":1}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.status).toBe('COMPLETED');
		expect(httpFn.mock.calls[0][0].url).toBe('https://api.test/v1/start');
		expect(httpFn.mock.calls[1][0].url).toBe('https://api.test/v1/runs/run-1/results');
	});

	it('is hidden from the Operation dropdown (not offered to new workflows)', () => {
		const operationProperty = new Pipelex().description.properties.find(
			(property) => property.name === 'operation',
		);
		const values = (operationProperty?.options ?? []).map(
			(option) => (option as { value: string }).value,
		);
		expect(values).not.toContain('execute');
	});
});

describe('Pipelex node — Start Pipeline (start only, no polling)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('POSTs /v1/start once and returns the StartAck (pipeline_run_id, state, created_at)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: { pipeCode: 'my-pipe', inputs: '{"a":1}' },
			httpImpl: () => fullResponse(202, START_ACK),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json).toEqual({
			pipeline_run_id: 'run-1',
			state: 'STARTED',
			created_at: '2026-06-10T00:00:00Z',
		});
		// One HTTP call only — no results poll.
		expect(httpFn).toHaveBeenCalledTimes(1);
		const startCall = httpFn.mock.calls[0][0];
		expect(startCall.url).toBe('https://api.test/v1/start');
		expect(startCall.headers['Idempotency-Key']).toBe('exec-1:node-1:0');
		expect(startCall.headers.Authorization).toBe('Bearer secret-token');
		expect(startCall.body).toEqual({ pipe_code: 'my-pipe', inputs: { a: 1 } });
	});

	it('shapes the start body identically to Start & Wait for Result (method_id + bundles)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: { methodId: 'method-42', mthdsContents: ['bundle'], inputs: '{}' },
			httpImpl: () => fullResponse(202, START_ACK),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({
			method_id: 'method-42',
			mthds_contents: ['bundle'],
			inputs: {},
		});
	});

	it('fails fast (no run) when no run source is provided', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: { pipeCode: '', mthdsContents: [], methodId: '', inputs: '{}' },
			continueOnFail: true,
			httpImpl: () => fullResponse(202, START_ACK),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Pipe Code');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('raises the actionable 403 message on an unscoped key', async () => {
		const { ctx } = makeContext({
			operation: 'start',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(FORBIDDEN_MESSAGE);
	});

	it('raises when the server acks without a pipeline_run_id', async () => {
		const { ctx } = makeContext({
			operation: 'start',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(202, { state: 'STARTED' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow('no pipeline_run_id');
	});
});

describe('Pipelex node — Poll & Get Result (waitForResult by id)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('polls /v1/runs/{id}/results, honoring Retry-After, until completed', async () => {
		let resultCalls = 0;
		const { ctx, httpFn } = makeContext({
			operation: 'poll',
			params: { runId: 'run-9' },
			httpImpl: () => {
				resultCalls += 1;
				return resultCalls < 3
					? fullResponse(202, {}, { 'retry-after': '1' })
					: fullResponse(200, { pipeline_run_id: 'run-9', main_stuff: { ok: true } });
			},
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(resultCalls).toBe(3);
		const json = result[0][0].json;
		expect(json.status).toBe('COMPLETED');
		expect(json.main_stuff).toEqual({ ok: true });
		const call = httpFn.mock.calls[0][0];
		expect(call.url).toBe('https://api.test/v1/runs/run-9/results');
		expect(call.headers.Authorization).toBe('Bearer secret-token');
	});

	it('treats a 503 mid-poll as still running (keeps polling)', async () => {
		let resultCalls = 0;
		const { ctx } = makeContext({
			operation: 'poll',
			params: { runId: 'run-9' },
			httpImpl: () => {
				resultCalls += 1;
				return resultCalls < 2
					? fullResponse(503, {})
					: fullResponse(200, { pipeline_run_id: 'run-9', main_stuff: {} });
			},
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(resultCalls).toBe(2);
		expect(result[0][0].json.status).toBe('COMPLETED');
	});

	it('returns the same graceful "still running" output (not an error) when Max Wait is exceeded', async () => {
		vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(100_000);
		const { ctx } = makeContext({
			operation: 'poll',
			params: { runId: 'run-9', maxWaitSeconds: 1 },
			httpImpl: () => fullResponse(202, {}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.status).toBe('RUNNING');
		expect(json.pipeline_run_id).toBe('run-9');
		expect(String(json.message)).toContain('Get Run Result');
	});

	it('raises on a failed (409) run with the server problem detail', async () => {
		const { ctx } = makeContext({
			operation: 'poll',
			params: { runId: 'run-9' },
			httpImpl: () => fullResponse(409, { detail: 'Run finished with status FAILED' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			'Run finished with status FAILED',
		);
	});

	it('requires a run id', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'poll',
			params: { runId: '   ' },
			continueOnFail: true,
			httpImpl: () => fullResponse(202, {}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Run ID is required');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('URL-encodes the pipeline_run_id', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'poll',
			params: { runId: 'run/../9' },
			httpImpl: () => fullResponse(200, { pipeline_run_id: 'run/../9', main_stuff: {} }),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].url).toBe('https://api.test/v1/runs/run%2F..%2F9/results');
	});
});

describe('Pipelex node — Get Run Result (single-shot fetch)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the completed result in one call to /v1/runs/{id}/results', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(200, COMPLETED_RESULT),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.status).toBe('COMPLETED');
		expect(json.main_stuff).toEqual({ answer: 42 });
		expect(json.graph_spec).toBeUndefined();
		expect(httpFn).toHaveBeenCalledTimes(1);
		expect(httpFn.mock.calls[0][0].url).toBe('https://api.test/v1/runs/run-1/results');
	});

	it('URL-encodes the pipeline_run_id', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run/../1' },
			httpImpl: () => fullResponse(200, COMPLETED_RESULT),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].url).toBe('https://api.test/v1/runs/run%2F..%2F1/results');
	});

	it('reports still-running (202) without looping', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(202, {}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.status).toBe('RUNNING');
		expect(json.pipeline_run_id).toBe('run-1');
		expect(httpFn).toHaveBeenCalledTimes(1);
	});

	it('maps a 503 to still-running too (mirrors mthds-js getRunResult)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(503, {}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.status).toBe('RUNNING');
		expect(httpFn).toHaveBeenCalledTimes(1);
	});

	it('raises on a failed (409) run', async () => {
		const { ctx } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(409, { detail: 'Run finished with status FAILED' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			'Run finished with status FAILED',
		);
	});

	it('raises the actionable 403 message on an unscoped key', async () => {
		const { ctx } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(FORBIDDEN_MESSAGE);
	});

	it('raises the actionable 404 message (bad run_id or non-hosted Base URL)', async () => {
		const { ctx } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(404, { detail: 'not found' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(NOT_FOUND_MESSAGE);
	});

	it('requires a run id', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: '' },
			continueOnFail: true,
			httpImpl: () => fullResponse(200, COMPLETED_RESULT),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Run ID is required');
		expect(httpFn).not.toHaveBeenCalled();
	});
});

describe('Pipelex node — inputs validation', () => {
	beforeEach(() => vi.clearAllMocks());

	it('rejects non-object inputs (array / null / scalar) before any call', async () => {
		for (const badInputs of ['[]', 'null', '"text"', '42']) {
			const { ctx, httpFn } = makeContext({
				operation: 'startAndPoll',
				params: { pipeCode: 'p', inputs: badInputs },
				continueOnFail: true,
				httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
			});
			const result = await Pipelex.prototype.execute.call(ctx);
			expect(String(result[0][0].json.error)).toContain('must be a JSON object');
			expect(httpFn).not.toHaveBeenCalled();
		}
	});

	it('treats a whitespace-only bundle as empty (guard fires, no call)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: '', mthdsContents: ['   \n  '], inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Pipe Code');
		expect(httpFn).not.toHaveBeenCalled();
	});
});

describe('Pipelex node — operation surface (description sanity)', () => {
	const description = new Pipelex().description;
	const properties = description.properties;

	const showOperations = (name: string): string[] => {
		const property = properties.find((p: INodeProperties) => p.name === name);
		return (property?.displayOptions?.show?.operation ?? []) as string[];
	};

	it('offers the four operations in usage order, defaulting to Start & Wait for Result', () => {
		const operationProperty = properties.find((p: INodeProperties) => p.name === 'operation');
		expect(operationProperty?.default).toBe('startAndPoll');
		const options = (operationProperty?.options ?? []) as Array<{ name: string; value: string }>;
		expect(options.map((o) => o.value)).toEqual(['startAndPoll', 'start', 'poll', 'getResult']);
		expect(options.map((o) => o.name)).toEqual([
			'Start & Wait for Result',
			'Start Pipeline',
			'Poll & Get Result',
			'Get Run Result',
		]);
	});

	it('shows the run-definition fields on both start operations (and the legacy execute value)', () => {
		for (const field of [
			'mthdsContents',
			'methodId',
			'inputs',
			'pipeCode',
			'outputName',
			'outputMultiplicity',
			'dynamicOutputConceptRef',
		]) {
			const operations = showOperations(field);
			expect(operations, field).toContain('startAndPoll');
			expect(operations, field).toContain('start');
			expect(operations, field).toContain('execute');
			expect(operations, field).not.toContain('poll');
			expect(operations, field).not.toContain('getResult');
		}
	});

	it('shows the run id only on the run-targeting operations', () => {
		expect(showOperations('runId')).toEqual(['poll', 'getResult']);
	});

	it('shows Max Wait only on the polling operations', () => {
		const operations = showOperations('maxWaitSeconds');
		expect(operations).toContain('startAndPoll');
		expect(operations).toContain('poll');
		expect(operations).not.toContain('start');
		expect(operations).not.toContain('getResult');
	});
});
