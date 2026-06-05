import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, IN8nHttpFullResponse } from 'n8n-workflow';

// Make the internal poll loop instant — replace the real (timer-backed)
// sleepWithAbort with a no-op, keep everything else (NodeApiError, etc.) real.
vi.mock('n8n-workflow', async (importOriginal) => {
	const actual = await importOriginal<typeof import('n8n-workflow')>();
	return { ...actual, sleepWithAbort: vi.fn(async () => {}) };
});

import { EXECUTE_TIMEOUT_MESSAGE, FORBIDDEN_MESSAGE } from '../nodes/Pipelex/GenericFunctions';
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

const COMPLETED_RESULT = {
	pipeline_run_id: 'run-1',
	main_stuff: { answer: 42 },
	graph_spec: { nodes: [] },
};

afterEach(() => vi.restoreAllMocks());

describe('Pipelex node — Execute (one-shot)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the runner response body verbatim', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'execute',
			params: { pipeCode: 'my-pipe', inputs: '{"a":1}' },
			httpImpl: () => fullResponse(200, { pipe_output: { result: 'ok' } }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.pipe_output).toEqual({ result: 'ok' });
		expect(httpFn.mock.calls[0][1].url).toBe('https://api.test/runner/v1/pipeline/execute');
	});

	it('translates a ~30s gateway timeout into an actionable message', async () => {
		// startedAt = 0, elapsed = 30s → past the gateway threshold.
		vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(30_000);
		const { ctx } = makeContext({
			operation: 'execute',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(504, { detail: 'gateway timeout' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(EXECUTE_TIMEOUT_MESSAGE);
	});

	it('surfaces a non-timeout error with its server detail', async () => {
		const { ctx } = makeContext({
			operation: 'execute',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(400, { detail: 'bad pipe' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow('bad pipe');
	});
});

describe('Pipelex node — Start', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the pipeline_run_id without polling', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(201, { pipeline_run_id: 'run-1', status: 'RUNNING' }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.pipeline_run_id).toBe('run-1');
		expect(httpFn).toHaveBeenCalledTimes(1);
		expect(httpFn.mock.calls[0][1].url).toBe('https://api.test/platform/v1/runs');
		expect(httpFn.mock.calls[0][1].headers['Idempotency-Key']).toBe('exec-1:node-1:0');
	});

	it('raises an actionable NodeApiError on a 403 start', async () => {
		const { ctx } = makeContext({
			operation: 'start',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(FORBIDDEN_MESSAGE);
	});
});

describe('Pipelex node — Poll for Result', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the completed result for a run id', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'poll',
			params: { runId: 'run-1', maxWaitSeconds: 0 },
			httpImpl: () => fullResponse(200, COMPLETED_RESULT),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.done).toBe(true);
		expect(json.status).toBe('COMPLETED');
		expect(json.main_stuff).toEqual({ answer: 42 });
		expect(httpFn.mock.calls[0][1].url).toBe(
			'https://api.test/platform/v1/runs/by-id/run-1/result',
		);
	});

	it('keeps polling while running, then returns when completed (unbounded)', async () => {
		let calls = 0;
		const { ctx } = makeContext({
			operation: 'poll',
			params: { runId: 'run-1', maxWaitSeconds: 0, pollIntervalSeconds: 1 },
			httpImpl: () => {
				calls += 1;
				return calls < 3 ? fullResponse(202, {}, { 'retry-after': '1' }) : fullResponse(200, COMPLETED_RESULT);
			},
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(calls).toBe(3);
		expect(result[0][0].json.status).toBe('COMPLETED');
	});

	it('raises on a failed (409) run', async () => {
		const { ctx } = makeContext({
			operation: 'poll',
			params: { runId: 'run-1', maxWaitSeconds: 0 },
			httpImpl: () => fullResponse(409, { detail: 'Run finished with status FAILED' }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			'Run finished with status FAILED',
		);
	});

	it('requires a run id', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'poll',
			params: { runId: '' },
			continueOnFail: true,
			httpImpl: () => fullResponse(200, COMPLETED_RESULT),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Run ID is required');
		expect(httpFn).not.toHaveBeenCalled();
	});
});

describe('Pipelex node — Get Result (single-shot)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the completed result in one call', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(200, COMPLETED_RESULT),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.status).toBe('COMPLETED');
		expect(httpFn).toHaveBeenCalledTimes(1);
		expect(httpFn.mock.calls[0][1].url).toBe(
			'https://api.test/platform/v1/runs/by-id/run-1/result',
		);
	});

	it('reports still-running without looping', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(202, {}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.done).toBe(false);
		expect(json.status).toBe('RUNNING');
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

describe('Pipelex node — Start & Poll', () => {
	beforeEach(() => vi.clearAllMocks());

	it('starts a run (with idempotency key) then polls to completion', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}', maxWaitSeconds: 0 },
			httpImpl: (options) =>
				options.method === 'POST'
					? fullResponse(201, { pipeline_run_id: 'run-1' })
					: fullResponse(200, COMPLETED_RESULT),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.status).toBe('COMPLETED');
		const startCall = httpFn.mock.calls.find((call) => call[1].method === 'POST');
		expect(startCall?.[1].headers['Idempotency-Key']).toBe('exec-1:node-1:0');
	});

	it('returns the run id with a "still running" message when Max Wait is exceeded', async () => {
		// deadline = 0 + 1*1000; remaining check sees now = 100_000 → exceeded.
		vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(100_000);
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}', maxWaitSeconds: 1 },
			httpImpl: (options) =>
				options.method === 'POST'
					? fullResponse(201, { pipeline_run_id: 'run-1' })
					: fullResponse(202, {}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.done).toBe(false);
		expect(json.status).toBe('RUNNING');
		expect(json.pipeline_run_id).toBe('run-1');
		expect(String(json.message)).toContain('Poll for Result');
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

	it('fails fast (no run) when neither pipe code nor bundles are provided', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: '', mthdsContents: [], inputs: '{}' },
			continueOnFail: true,
			httpImpl: () => fullResponse(201, { pipeline_run_id: 'run-1' }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Pipe Code');
		expect(httpFn).not.toHaveBeenCalled();
	});
});

describe('Pipelex node — outage (5xx) handling', () => {
	beforeEach(() => vi.clearAllMocks());

	it('Poll tolerates a few transient 503s, then completes when the backend recovers', async () => {
		let calls = 0;
		const { ctx } = makeContext({
			operation: 'poll',
			params: { runId: 'run-1', maxWaitSeconds: 0, pollIntervalSeconds: 1 },
			httpImpl: () => {
				calls += 1;
				return calls < 3 ? fullResponse(503, {}) : fullResponse(200, COMPLETED_RESULT);
			},
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(calls).toBe(3);
		expect(result[0][0].json.status).toBe('COMPLETED');
	});

	it('Poll fails (does not hang) after too many consecutive 503s', async () => {
		let calls = 0;
		const { ctx } = makeContext({
			operation: 'poll',
			params: { runId: 'run-1', maxWaitSeconds: 0, pollIntervalSeconds: 1 },
			httpImpl: () => {
				calls += 1;
				return fullResponse(503, {});
			},
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/repeatedly unavailable/i);
		// bounded: MAX_CONSECUTIVE_TRANSIENT (5) tolerated, then the 6th fails.
		expect(calls).toBe(6);
	});

	it('Get Result surfaces a 503 as an error, not "still running"', async () => {
		const { ctx } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(503, {}),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/repeatedly unavailable/i);
	});
});

describe('Pipelex node — inputs validation', () => {
	beforeEach(() => vi.clearAllMocks());

	it('rejects non-object inputs (array / null / scalar) before any call', async () => {
		for (const badInputs of ['[]', 'null', '"text"', '42']) {
			const { ctx, httpFn } = makeContext({
				operation: 'start',
				params: { pipeCode: 'p', inputs: badInputs },
				continueOnFail: true,
				httpImpl: () => fullResponse(201, { pipeline_run_id: 'run-1' }),
			});
			const result = await Pipelex.prototype.execute.call(ctx);
			expect(String(result[0][0].json.error)).toContain('must be a JSON object');
			expect(httpFn).not.toHaveBeenCalled();
		}
	});

	it('treats a whitespace-only bundle as empty (guard fires, no call)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: { pipeCode: '', mthdsContents: ['   \n  '], inputs: '{}' },
			continueOnFail: true,
			httpImpl: () => fullResponse(201, { pipeline_run_id: 'run-1' }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Pipe Code');
		expect(httpFn).not.toHaveBeenCalled();
	});
});
