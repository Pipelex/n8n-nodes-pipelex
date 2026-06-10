import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, IN8nHttpFullResponse } from 'n8n-workflow';

// Make the internal poll loop instant — replace the real (timer-backed)
// sleepWithAbort with a no-op, keep everything else (NodeApiError, etc.) real.
vi.mock('n8n-workflow', async (importOriginal) => {
	const actual = await importOriginal<typeof import('n8n-workflow')>();
	return { ...actual, sleepWithAbort: vi.fn(async () => {}) };
});

import { FORBIDDEN_MESSAGE } from '../nodes/Pipelex/GenericFunctions';
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
	const httpFn = vi.fn(async (_credentialsName: string, options: { url: string }) =>
		opts.httpImpl(options),
	);

	const ctx = {
		getInputData: () => opts.items ?? [{ json: {} }],
		getCredentials: async () => ({ baseUrl: 'https://api.test' }),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'operation') return opts.operation;
			return name in params ? params[name] : fallback;
		},
		getExecutionId: () => 'exec-1',
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => opts.continueOnFail ?? false,
		getNode: () => ({ id: 'node-1', name: 'Pipelex', type: 'pipelex', typeVersion: 1 }),
		helpers: { httpRequestWithAuthentication: httpFn },
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

describe('Pipelex node — Execute Pipeline (start + internal poll)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('starts via POST /v1/start (with idempotency key) then polls /v1/runs/{id}/results to completion', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'execute',
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

		const startCall = httpFn.mock.calls[0][1];
		expect(startCall.url).toBe('https://api.test/v1/start');
		expect(startCall.headers['Idempotency-Key']).toBe('exec-1:node-1:0');
		expect(startCall.body).toEqual({ pipe_code: 'my-pipe', inputs: { a: 1 } });
		expect(httpFn.mock.calls[1][1].url).toBe('https://api.test/v1/runs/run-1/results');
	});

	it('sends method_id in the start body (stored-method alternative to inline bundles)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'execute',
			params: { methodId: 'method-42', inputs: '{}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][1].body).toEqual({ method_id: 'method-42', inputs: {} });
	});

	it('rejects method_id + MTHDS bundles client-side (mutually exclusive), no HTTP call', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'execute',
			params: { methodId: 'method-42', mthdsContents: ['bundle'], inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('mutually exclusive');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('keeps polling while running (202), honoring Retry-After, then returns when completed', async () => {
		let resultCalls = 0;
		const { ctx } = makeContext({
			operation: 'execute',
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
			operation: 'execute',
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
			operation: 'execute',
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
			operation: 'execute',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(FORBIDDEN_MESSAGE);
	});

	it('surfaces a failed start with its problem detail', async () => {
		const { ctx } = makeContext({
			operation: 'execute',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(503, { detail: 'Failed to start pipeline' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow('Failed to start pipeline');
	});

	it('raises on a failed (409) run with the server problem detail', async () => {
		const { ctx } = makeContext({
			operation: 'execute',
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
			operation: 'execute',
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
			operation: 'execute',
			params: { pipeCode: 'p', inputs: '{}' },
			continueOnFail: true,
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.error).toBe(FORBIDDEN_MESSAGE);
	});

	it('fails fast (no run) when no run source is provided', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'execute',
			params: { pipeCode: '', mthdsContents: [], methodId: '', inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Pipe Code');
		expect(httpFn).not.toHaveBeenCalled();
	});
});

describe('Pipelex node — Get Run Result (single-shot escape hatch)', () => {
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
		expect(httpFn.mock.calls[0][1].url).toBe('https://api.test/v1/runs/run-1/results');
	});

	it('URL-encodes the pipeline_run_id', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run/../1' },
			httpImpl: () => fullResponse(200, COMPLETED_RESULT),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][1].url).toBe('https://api.test/v1/runs/run%2F..%2F1/results');
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
				operation: 'execute',
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
			operation: 'execute',
			params: { pipeCode: '', mthdsContents: ['   \n  '], inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Pipe Code');
		expect(httpFn).not.toHaveBeenCalled();
	});
});
