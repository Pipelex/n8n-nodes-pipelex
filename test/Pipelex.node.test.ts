import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, IN8nHttpFullResponse, INodeProperties } from 'n8n-workflow';

// Make the internal poll loop instant — replace the real (timer-backed)
// `abortableSleep` with a no-op, keep every other export real.
//
// This mocks OUR module, not `n8n-workflow`. It used to stub n8n-workflow's
// `sleepWithAbort`, and that is precisely what hid a shipped bug: the helper
// exists in n8n-workflow 1.x (this repo's dev tree) but was removed in 2.x, so
// the mock kept the suite green while every real poll on a current n8n threw
// `sleepWithAbort is not a function`. Mocking a dependency's API asserts that
// the API exists; mocking our own asserts nothing about the host.
vi.mock('../nodes/Pipelex/GenericFunctions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../nodes/Pipelex/GenericFunctions')>();
	return { ...actual, abortableSleep: vi.fn(async () => {}) };
});

import {
	FORBIDDEN_MESSAGE,
	NOT_FOUND_MESSAGE,
	SERVICE_UNAVAILABLE_MESSAGE,
} from '../nodes/Pipelex/GenericFunctions';
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

	it('refuses a stored method AND an inline one (no run, no ambiguity)', async () => {
		// The hosted API would accept both — it runs the inline method and records
		// method_id as run-history linkage. The node refuses, so there is one
		// unambiguous answer to what it is running.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'method-42',
				inlineMethod: true,
				mthdsContents: ['bundle'],
				inputs: '{}',
			},
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toMatch(/Choose one/);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('reads the MTHDS Bundles fixedCollection shape', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inlineMethod: true,
				mthdsContents: {
					bundle: [
						{ content: 'domain = "a"' },
						// The UI persists a row as soon as the add-button is clicked.
						{ content: '   ' },
						{ content: 'domain = "b"' },
					],
				},
				inputs: '{}',
			},
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({
			mthds_contents: ['domain = "a"', 'domain = "b"'],
			inputs: {},
		});
	});

	it('still reads a workflow saved with the old string[] MTHDS Bundles field', async () => {
		// The field changed from a multi-value string to a fixedCollection. An
		// upgraded workflow still holds the bare array — read it rather than silently
		// losing the user's pasted method.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { inlineMethod: true, mthdsContents: ['legacy bundle', '  '], inputs: '{}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({
			mthds_contents: ['legacy bundle'],
			inputs: {},
		});
	});

	it('ignores inline fields left behind when the toggle is off', async () => {
		// n8n keeps a hidden field's stored value. A user who pastes a method, then
		// switches back to a stored one, must not trip the either/or error on fields
		// they can no longer see — nor silently send them.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'method-42',
				inlineMethod: false,
				mthdsContents: ['leftover'],
				pythonFiles: { file: [{ path: 'funcs/old.py', content: 'stale' }] },
				inputs: '{}',
			},
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({ method_id: 'method-42', inputs: {} });
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

	it('trips the consecutive-503 ceiling on a sustained outage (even unbounded), surfacing the run_id', async () => {
		let resultCalls = 0;
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			// maxWaitSeconds: 0 = unbounded; only the consecutive-503 ceiling can stop this.
			params: { pipeCode: 'p', inputs: '{}', maxWaitSeconds: 0 },
			httpImpl: startThenResults(() => {
				resultCalls += 1;
				return fullResponse(503, {});
			}),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(SERVICE_UNAVAILABLE_MESSAGE);
		// 5 tolerated, the 6th consecutive trips the ceiling.
		expect(resultCalls).toBe(6);
	});

	it('resets the 503 counter on a healthy 202 between blips (no false outage trip)', async () => {
		let resultCalls = 0;
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}', maxWaitSeconds: 0 },
			httpImpl: startThenResults(() => {
				resultCalls += 1;
				// 3x503, then a 202 (resets), then 3x503, then completed — never 6 in a row.
				if (resultCalls === 4) return fullResponse(202, {});
				if (resultCalls >= 8) return fullResponse(200, COMPLETED_RESULT);
				return fullResponse(503, {});
			}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.status).toBe('COMPLETED');
		expect(resultCalls).toBe(8);
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

	it('raises an actionable NodeApiError on a 403 start (account API access not enabled)', async () => {
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

	it("normalizes status to 'COMPLETED' even when the server body carries a different status", async () => {
		// Defensive: the typed RunResults body has no top-level `status`, but if the
		// server ever adds one (or relays a stale one), the node's normalized status
		// must win — downstream branches read `status` as the completion signal.
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() =>
				fullResponse(200, {
					pipeline_run_id: 'run-1',
					status: 'running',
					main_stuff: { answer: 7 },
				}),
			),
		});

		const json = (await Pipelex.prototype.execute.call(ctx))[0][0].json;
		expect(json.status).toBe('COMPLETED');
	});

	it('captures the error as an item when continueOnFail is on', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			continueOnFail: true,
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		// The actionable guidance leads; the server's problem detail is appended as
		// a supporting fact (see `withServerDetail`).
		expect(result[0][0].json.error).toBe(`${FORBIDDEN_MESSAGE} (Server: forbidden)`);
	});

	it('403 message names the account-level surface, never a per-key scope', async () => {
		// Regression guard: an earlier message told users their key needed a
		// `runs:execute` scope. No such scope exists — the platform gates the run
		// surface per ACCOUNT (`require_surface_access`), so that wording sent
		// people hunting for a setting that is not there.
		expect(FORBIDDEN_MESSAGE).not.toMatch(/runs:execute|scope/i);
		expect(FORBIDDEN_MESSAGE).toMatch(/account/i);
	});

	it('fails fast (no run) when no run source is provided', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: '', mthdsContents: [], methodId: '', inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Nothing to run');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('sends the pasted method plus its Python as one files bundle', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inputs: '{}',
				inlineMethod: true,
				mthdsContents: ['domain = "d"'],
				pythonFiles: {
					file: [
						{ path: 'funcs/score.py', content: 'def score(): ...' },
						// Blank path — the UI persists a row on "Add" before typing.
						{ path: '   ', content: 'ignored' },
						// Blank CONTENT is kept: an empty requirements.txt is legitimate.
						{ path: 'requirements.txt', content: '' },
					],
				},
			},
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({
			inputs: {},
			files: {
				'main.mthds': 'domain = "d"',
				'funcs/score.py': 'def score(): ...',
				'requirements.txt': '',
			},
		});
	});

	it('ships inline MTHDS Bundles together with Python Files as one bundle', async () => {
		// The headline flow: paste the method, attach its Python, run. The protocol
		// forbids `mthds_contents` beside a bundle, so the node folds the inline
		// contents INTO the bundle rather than rejecting the combination.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inputs: '{}',
				inlineMethod: true,
				mthdsContents: ['domain = "d"'],
				pythonFiles: { file: [{ path: 'funcs/score.py', content: 'def score(): ...' }] },
			},
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({
			inputs: {},
			files: {
				'main.mthds': 'domain = "d"',
				'funcs/score.py': 'def score(): ...',
			},
		});
	});

	it('fails fast (no run) when Python is supplied with no method', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inputs: '{}',
				inlineMethod: true,
				pythonFiles: { file: [{ path: 'funcs/score.py', content: 'def score(): ...' }] },
			},
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toMatch(/needs the method/);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('fails fast (no run) on an unsafe Python path', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inputs: '{}',
				inlineMethod: true,
				mthdsContents: ['m'],
				pythonFiles: { file: [{ path: '../escape.py', content: 'x' }] },
			},
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toMatch(/escapes the bundle root/);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('relays tokens_usages and usage_assembly_error to the item', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() =>
				fullResponse(200, {
					...COMPLETED_RESULT,
					tokens_usages: [{ pipe_code: 'p', cost: 0.0012, model_type: 'llm' }],
					usage_assembly_error: null,
				}),
			),
		});

		const json = (await Pipelex.prototype.execute.call(ctx))[0][0].json;
		expect(json.tokens_usages).toEqual([{ pipe_code: 'p', cost: 0.0012, model_type: 'llm' }]);
		expect(json.usage_assembly_error).toBeNull();
	});

	it('polls through the mid-write window instead of failing a run that completed fine', async () => {
		// The platform flips a run to COMPLETED and then relays whatever is in S3, so
		// a poll can land in the window before main_stuff.json exists ("missing files
		// come back null; the run may be partial mid-write"). Failing there would
		// break a workflow whose run actually succeeded.
		let call = 0;
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() => {
				call += 1;
				// Two mid-write readings, then the artifact lands.
				return call <= 2
					? fullResponse(200, { pipeline_run_id: 'run-1' })
					: fullResponse(200, COMPLETED_RESULT);
			}),
		});

		const json = (await Pipelex.prototype.execute.call(ctx))[0][0].json;
		expect(json.status).toBe('COMPLETED');
		expect(json.main_stuff).toEqual({ answer: 42 });
		expect(call).toBe(3);
	});

	it('errors once the mid-write state persists past the ceiling, naming the run id', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, { pipeline_run_id: 'run-1' })),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const error = String(result[0][0].json.error);
		expect(error).toMatch(/never delivered its output/);
		// The message promises a run id to report — it must actually carry one.
		expect(error).toContain('run-1');
		// No `{status: "COMPLETED"}` item slips through either way.
		expect(result[0][0].json.status).toBeUndefined();
	});

	it('keeps the two ceilings independent — alternating 503s and mid-writes trips neither', async () => {
		// Each ceiling counts CONSECUTIVE readings of its own kind, and any other
		// reading resets it. So a long alternating sequence — far more of each than
		// either ceiling allows — must still reach completion: a mid-write 200 proves
		// the backend is reachable, and a 503 says nothing about the artifact.
		let call = 0;
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			httpImpl: startThenResults(() => {
				call += 1;
				if (call > 30) return fullResponse(200, COMPLETED_RESULT);
				return call % 2 === 1
					? fullResponse(503, {})
					: fullResponse(200, { pipeline_run_id: 'run-1' });
			}),
		});

		const json = (await Pipelex.prototype.execute.call(ctx))[0][0].json;
		expect(json.status).toBe('COMPLETED');
		expect(call).toBe(31);
	});

	it('still trips the 503 ceiling on a genuinely sustained outage', async () => {
		// The counter reset above must not have defanged the outage guard.
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'p', inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(503, {})),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain(SERVICE_UNAVAILABLE_MESSAGE);
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

	it('shapes the start body identically to Start & Wait for Result (inline method)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: { inlineMethod: true, mthdsContents: ['bundle'], inputs: '{}' },
			httpImpl: () => fullResponse(202, START_ACK),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body).toEqual({
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
		expect(String(result[0][0].json.error)).toContain('Nothing to run');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('raises the actionable 403 message (account API access not enabled)', async () => {
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

describe('Pipelex node — expression-fed text fields', () => {
	beforeEach(() => vi.clearAllMocks());

	it('rejects non-text Python file content, naming the offending path', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inputs: '{}',
				inlineMethod: true,
				mthdsContents: ['m'],
				pythonFiles: { file: [{ path: 'funcs/f.py', content: { nested: true } }] },
			},
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const error = String(result[0][0].json.error);
		expect(error).toContain('funcs/f.py');
		expect(error).toContain('must be text');
		expect(httpFn).not.toHaveBeenCalled();
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

	it("normalizes status to 'COMPLETED' even when the server body carries a different status", async () => {
		// Same defensive guarantee as the startAndPoll path: the literal status
		// must win over any status field in the response body.
		const { ctx } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () =>
				fullResponse(200, {
					pipeline_run_id: 'run-1',
					status: 'running',
					main_stuff: { answer: 7 },
				}),
		});

		const json = (await Pipelex.prototype.execute.call(ctx))[0][0].json;
		expect(json.status).toBe('COMPLETED');
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

	it('reports the mid-write window as still-running, not an error', async () => {
		// Single-shot cannot poll through the window, so it hands back a usable item
		// telling the caller to fetch again. Erroring would fail a run that is about
		// to be perfectly retrievable.
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			httpImpl: () => fullResponse(200, { pipeline_run_id: 'run-1', main_stuff: null }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const json = result[0][0].json;
		expect(json.status).toBe('RUNNING');
		expect(json.pipeline_run_id).toBe('run-1');
		expect(String(json.message)).toContain('still being written');
		expect(httpFn).toHaveBeenCalledTimes(1);
	});

	it('maps a 503 to still-running too (mirrors the SDK getRunResult)', async () => {
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

	it('raises the actionable 403 message (account API access not enabled)', async () => {
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
			params: { pipeCode: '', inlineMethod: true, mthdsContents: ['   \n  '], inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Nothing to run');
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

	it('orders the start fields: Method ID → inline toggle → the inline pair → Inputs', () => {
		// Field order IS the explanation of the node: you pick a stored method, or
		// open the toggle to paste one, and only then fill the inputs. Pinned because
		// property order is display order and a careless insert reshuffles the UI.
		const startFields = properties
			.filter((p: INodeProperties) => showOperations(p.name).includes('startAndPoll'))
			.map((p: INodeProperties) => p.name);
		expect(startFields.slice(0, 5)).toEqual([
			'methodId',
			'inlineMethod',
			'mthdsContents',
			'pythonFiles',
			'inputs',
		]);
	});

	it('renders both halves of the inline method as the same kind of control', () => {
		// They hold the two halves of one thing, so they must look like one control.
		// A multi-value `string` renders a wide full-width add-button while a
		// fixedCollection renders the compact `+ Add …` row; side by side those read
		// as unrelated widgets, which is exactly how this looked before.
		for (const name of ['mthdsContents', 'pythonFiles']) {
			const property = properties.find((p: INodeProperties) => p.name === name);
			expect(property?.type, name).toBe('fixedCollection');
			expect(property?.typeOptions?.multipleValues, name).toBe(true);
			expect(property?.placeholder, name).toMatch(/^Add /);
		}
	});

	it('hides the inline pair behind the toggle', () => {
		for (const name of ['mthdsContents', 'pythonFiles']) {
			const property = properties.find((p: INodeProperties) => p.name === name);
			expect(property?.displayOptions?.show?.inlineMethod, name).toEqual([true]);
		}
		// The toggle itself must NOT be gated on itself, or it could never be turned on.
		const toggle = properties.find((p: INodeProperties) => p.name === 'inlineMethod');
		expect(toggle?.displayOptions?.show?.inlineMethod).toBeUndefined();
		expect(toggle?.default).toBe(false);
	});

	it('gives every fixedCollection a placeholder, so its add-button is not invisible', () => {
		// Regression guard for a bug that shipped past lint AND past unit tests:
		// `Python Files` and `Bundle Files` were defined with
		// `typeOptions.multipleValueButtonText`, which labels the add-button only for
		// simple multi-value types. On a fixedCollection the label comes from
		// `placeholder`, and without it an empty collection renders as nothing at all
		// — the fields were in the compiled description but absent from the editor.
		// Nothing else catches this: the node's behaviour is fully testable through
		// getNodeParameter, which does not care whether the field is reachable in the
		// UI. (114 of 122 fixedCollections in n8n-nodes-base set placeholder.)
		const collections = properties.filter(
			(p: INodeProperties) => p.type === 'fixedCollection',
		);
		expect(collections.length).toBeGreaterThan(0);
		for (const property of collections) {
			expect(property.placeholder, `${property.name} needs a placeholder`).toBeTruthy();
			expect(
				property.typeOptions?.multipleValueButtonText,
				`${property.name}: multipleValueButtonText does nothing on a fixedCollection — use placeholder`,
			).toBeUndefined();
		}
	});

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

describe('Pipelex node — explaining a failed run', () => {
	beforeEach(() => vi.clearAllMocks());

	const FAILURE_MESSAGE =
		"Live run of PipeSequence 'build_client_quote': missing required inputs: illustrations. These optional inputs may be omitted: comments.";
	const RUN_ROW = {
		pipeline_run_id: 'run-1',
		status: 'FAILED',
		pipe_code: 'build_client_quote',
		error: { message: FAILURE_MESSAGE, error_type: 'PipeRunInputsError' },
	};

	/** results → 409 (the generic body); status → the run row carrying the reason. */
	function failedRunImpl(statusResponse: IN8nHttpFullResponse): HttpImpl {
		return (options) => {
			if (options.method === 'POST') return fullResponse(202, START_ACK);
			if (String(options.url).endsWith('/status')) return statusResponse;
			return fullResponse(409, { detail: 'Run finished with status FAILED; no result available' });
		};
	}

	it('surfaces the real reason instead of "no result available"', async () => {
		// The 409 knows only THAT the run failed. The reason lives on the run row,
		// so a failure costs one extra light read to become explicable.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { methodId: 'm', inputs: '{}' },
			continueOnFail: true,
			httpImpl: failedRunImpl(fullResponse(200, RUN_ROW)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const error = String(result[0][0].json.error);
		expect(error).toContain('missing required inputs: illustrations');
		expect(error).toContain('PipeRunInputsError');
		expect(error).not.toContain('no result available');

		// It reads /status (light), never /runs/{id} (which drags mthds_contents).
		const urls = httpFn.mock.calls.map((call) => String(call[0].url));
		expect(urls.some((url) => url.endsWith('/v1/runs/run-1/status'))).toBe(true);
		expect(urls).not.toContain('https://api.test/v1/runs/run-1');
	});

	it('puts the actionable report in the error description, not a repeat of the message', async () => {
		// NodeApiError renders message/description/httpCode only. Without an explicit
		// description, n8n derives one by echoing error.message from the body — the
		// same sentence twice, which is what the panel used to show.
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { methodId: 'm', inputs: '{}' },
			continueOnFail: true,
			httpImpl: failedRunImpl(
				fullResponse(200, {
					...RUN_ROW,
					finished_at: '2026-08-17T16:01:54Z',
					error: {
						...RUN_ROW.error,
						title: 'Pipe run inputs',
						type_uri: 'https://docs.pipelex.com/latest/errors/pipe-run-inputs-error/',
						retryable: false,
						user_action: { kind: 'change_input', detail: 'Provide the illustrations input' },
					},
				}),
			),
		});

		// Catch the NodeApiError itself — `continueOnFail` flattens it to a message
		// string, which would hide the description entirely.
		let captured: { message?: string; description?: string } | undefined;
		try {
			await Pipelex.prototype.execute.call({
				...ctx,
				continueOnFail: () => false,
			} as unknown as IExecuteFunctions);
		} catch (error) {
			captured = error as { message?: string; description?: string };
		}

		expect(captured?.message).toContain('missing required inputs: illustrations');
		expect(captured?.description).toContain('Pipe run inputs');
		expect(captured?.description).toContain('What to do: change input');
		expect(captured?.description).toContain('Retryable: no');
		expect(captured?.description).toContain('Docs: https://docs.pipelex.com');
		// Single line: n8n collapses newlines, so a multi-line block would render as
		// a run-on sentence.
		expect(captured?.description).not.toContain('\n');
		// ...while the "Error data" row DOES keep them: it renders in <pre><code>.
		const data = (captured as { context?: { data?: string } }).context?.data;
		expect(data).toContain('\n');
		expect(data).toContain('error_type');
		expect(data).toContain('pipeline_run_id');
		// The description must add information, not restate the headline.
		expect(captured?.description).not.toBe(captured?.message);
	});

	it('falls back to the 409 message when the run row carries no report', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { methodId: 'm', inputs: '{}' },
			continueOnFail: true,
			httpImpl: failedRunImpl(fullResponse(200, { pipeline_run_id: 'run-1', status: 'FAILED' })),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('no result available');
	});

	it.each([
		['the status read errors', fullResponse(500, { detail: 'boom' })],
		['the status read 404s', fullResponse(404, {})],
	])('still reports the failure when %s', async (_label, statusResponse) => {
		// Best-effort enrichment: a failure to EXPLAIN a failure must never replace
		// or swallow the failure itself.
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { methodId: 'm', inputs: '{}' },
			continueOnFail: true,
			httpImpl: failedRunImpl(statusResponse),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('no result available');
	});

	it('survives the status read throwing outright', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: { methodId: 'm', inputs: '{}' },
			continueOnFail: true,
			httpImpl: (options) => {
				if (options.method === 'POST') return fullResponse(202, START_ACK);
				if (String(options.url).endsWith('/status')) throw new Error('network down');
				return fullResponse(409, { detail: 'Run finished with status FAILED; no result available' });
			},
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('no result available');
	});

	it('explains a failure on the single-shot Get Run Result too', async () => {
		const { ctx } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			continueOnFail: true,
			httpImpl: (options) =>
				String(options.url).endsWith('/status')
					? fullResponse(200, RUN_ROW)
					: fullResponse(409, { detail: 'Run finished with status FAILED; no result available' }),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('missing required inputs: illustrations');
	});

	it('does not read the run row for a non-failure error (403)', async () => {
		// Only a terminal FAILED run has a report to fetch; spending a request on a
		// 403 or 404 would be waste.
		const { ctx, httpFn } = makeContext({
			operation: 'getResult',
			params: { runId: 'run-1' },
			continueOnFail: true,
			httpImpl: () => fullResponse(403, { detail: 'forbidden' }),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls.map((call) => String(call[0].url))).not.toContain(
			'https://api.test/v1/runs/run-1/status',
		);
	});
});
