import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
	UPLOAD_UNAVAILABLE_MESSAGE,
} from '../nodes/Pipelex/GenericFunctions';
import { Pipelex } from '../nodes/Pipelex/Pipelex.node';
import { storedUploads } from '../nodes/Pipelex/StoredUploads';

type HttpImpl = (options: {
	method?: string;
	url: string;
	[key: string]: unknown;
}) => IN8nHttpFullResponse | Promise<IN8nHttpFullResponse>;

/** An n8n binary as it sits on an item: base64 data plus the metadata n8n keeps. */
interface TestBinary {
	data: string;
	mimeType: string;
	fileName?: string;
	fileExtension?: string;
	/** The size n8n records when it stores a binary. */
	bytes?: number;
	/** Set on a binary n8n keeps outside memory; its size is then in `binaryMetadata`. */
	id?: string;
}

interface ContextOptions {
	operation: string;
	params?: Record<string, unknown>;
	httpImpl: HttpImpl;
	continueOnFail?: boolean;
	items?: Array<{ json: Record<string, unknown>; binary?: Record<string, TestBinary> }>;
	executionId?: string;
	cancelSignal?: AbortSignal;
	/**
	 * The workflow's binary mode. Under `combined`, n8n keeps a file in the item's
	 * JSON and `assertBinaryData` resolves the field name as a path there.
	 */
	binaryMode?: 'separate' | 'combined';
	/** `getBinaryMetadata` answers, by binary id. Without it the helper is absent. */
	binaryMetadata?: Record<string, { fileSize: number }>;
	/** Shared with `httpImpl` to record the order of loads and requests. */
	log?: string[];
}

function makeContext(opts: ContextOptions): {
	ctx: IExecuteFunctions;
	httpFn: ReturnType<typeof vi.fn>;
	bufferFn: ReturnType<typeof vi.fn>;
} {
	const params = opts.params ?? {};
	const items = opts.items ?? [{ json: {} }];
	// The node uses ctx.helpers.httpRequest (manual Authorization header — the
	// credential has no `authenticate` block; see PiplexApi.credentials.ts).
	const httpFn = vi.fn(async (options: { url: string }) => opts.httpImpl(options));
	// n8n's binary helpers, answered from the items. `assertBinaryData` throws the
	// way the real one does when the field is missing, so a test that reaches it
	// by mistake fails loudly rather than reading `undefined`.
	const binaryOf = (itemIndex: number, propertyName: string): TestBinary => {
		const binary =
			opts.binaryMode === 'combined'
				? (items[itemIndex]?.json[propertyName] as TestBinary | undefined)
				: items[itemIndex]?.binary?.[propertyName];
		if (!binary) throw new Error(`no binary field "${propertyName}" on item ${itemIndex}`);
		return binary;
	};
	const bufferFn = vi.fn(async (itemIndex: number, propertyName: string) => {
		opts.log?.push(`load ${propertyName}`);
		return Buffer.from(binaryOf(itemIndex, propertyName).data, 'base64');
	});
	const metadata = opts.binaryMetadata;

	const ctx = {
		getInputData: () => items,
		getCredentials: async () => ({ baseUrl: 'https://api.test', apiKey: 'secret-token' }),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'operation') return opts.operation;
			return name in params ? params[name] : fallback;
		},
		getExecutionId: () => opts.executionId ?? 'exec-1',
		getExecutionCancelSignal: () => opts.cancelSignal,
		continueOnFail: () => opts.continueOnFail ?? false,
		getNode: () => ({ id: 'node-1', name: 'Pipelex', type: 'pipelex', typeVersion: 1 }),
		helpers: {
			httpRequest: httpFn,
			assertBinaryData: (itemIndex: number, propertyName: string) =>
				binaryOf(itemIndex, propertyName),
			getBinaryDataBuffer: bufferFn,
			...(metadata
				? {
						getBinaryMetadata: async (binaryDataId: string) => {
							const found = metadata[binaryDataId];
							if (!found) throw new Error(`no metadata for ${binaryDataId}`);
							return found;
						},
					}
				: {}),
		},
	} as unknown as IExecuteFunctions;

	return { ctx, httpFn, bufferFn };
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

// Read from the manifest, independently of `UserAgent.ts`, so a drifted
// constant fails here (spec: docs/specs/client-identification.md).
const EXPECTED_USER_AGENT = `n8n-nodes-pipelex/${
	(JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version: string }).version
}`;

describe('Pipelex node — client identification (User-Agent on every API request)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('sends the User-Agent on POST /v1/start and GET /v1/runs/{id}/results', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'my-pipe', inputs: '{}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);

		const [startCall, resultCall] = httpFn.mock.calls.map((call) => call[0]);
		expect(startCall.url).toBe('https://api.test/v1/start');
		expect(startCall.headers['User-Agent']).toBe(EXPECTED_USER_AGENT);
		expect(startCall.headers['Idempotency-Key']).toBe('exec-1:node-1:0');
		expect(resultCall.url).toBe('https://api.test/v1/runs/run-1/results');
		expect(resultCall.headers['User-Agent']).toBe(EXPECTED_USER_AGENT);
	});

	it('sends the User-Agent on GET /v1/runs/{id}/status (the failed-run explanation read)', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'my-pipe', inputs: '{}' },
			continueOnFail: true,
			httpImpl: (options) => {
				if (options.method === 'POST') return fullResponse(202, START_ACK);
				if (String(options.url).endsWith('/status'))
					return fullResponse(200, { pipeline_run_id: 'run-1', status: 'FAILED', error: { message: 'boom' } });
				return fullResponse(409, { detail: 'Run finished with status FAILED; no result available' });
			},
		});

		await Pipelex.prototype.execute.call(ctx);

		const statusCall = httpFn.mock.calls
			.map((call) => call[0])
			.find((options) => String(options.url).endsWith('/v1/runs/run-1/status'));
		expect(statusCall).toBeDefined();
		expect(statusCall.headers['User-Agent']).toBe(EXPECTED_USER_AGENT);
		expect(statusCall.headers.Authorization).toBe('Bearer secret-token');
	});

	it('sends the same User-Agent on every request it makes', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { pipeCode: 'my-pipe', inputs: '{}' },
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);

		expect(httpFn.mock.calls.length).toBeGreaterThan(0);
		for (const [options] of httpFn.mock.calls) {
			expect(options.headers['User-Agent']).toBe(EXPECTED_USER_AGENT);
		}
	});
});

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

	it('never silently switches to the stored method on a pre-0.2.0 workflow', async () => {
		// Regression, greptile P1. In 0.1.0 "both together is allowed: the inline
		// bundles run, method_id links the run to the stored method" — so a saved
		// workflow with BOTH ran the INLINE method. After the toggle was introduced,
		// `inlineMethod` is absent on such a workflow, the inline content is dropped,
		// and the STORED method runs instead: a different method, with no error.
		// A migration must not change WHICH method executes.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'method-42',
				// The legacy field shape: a bare string[], not { bundle: [...] }.
				mthdsContents: ['domain = "legacy"'],
				inputs: '{}',
				// `inlineMethod` deliberately absent — the workflow predates it.
			},
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const error = String(result[0][0].json.error);
		expect(error).toMatch(/Define Method Inline/);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('flags a pre-0.2.0 inline-only workflow with migration guidance', async () => {
		// Same discriminator, without a Method ID. This already failed with "Nothing
		// to run", which is loud but says nothing about the toggle.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: { mthdsContents: ['domain = "legacy"'], inputs: '{}' },
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toMatch(/Define Method Inline/);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('rejects a duplicate Python file path instead of overwriting it', async () => {
		// Regression, greptile P1. `files[path] = content` is last-write-wins, so a
		// repeated path silently dropped a file and ran content the author did not
		// intend as the only version.
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inlineMethod: true,
				mthdsContents: { bundle: [{ content: 'domain = "d"' }] },
				pythonFiles: {
					file: [
						{ path: 'funcs/score.py', content: 'def score(): return 1' },
						{ path: 'funcs/score.py', content: 'def score(): return 2' },
					],
				},
				inputs: '{}',
			},
			continueOnFail: true,
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const error = String(result[0][0].json.error);
		expect(error).toContain('funcs/score.py');
		expect(error).toMatch(/more than once|duplicat/i);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('still accepts the same content at two distinct paths', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				inlineMethod: true,
				mthdsContents: { bundle: [{ content: 'domain = "d"' }] },
				pythonFiles: {
					file: [
						{ path: 'funcs/a.py', content: 'shared' },
						{ path: 'funcs/b.py', content: 'shared' },
					],
				},
				inputs: '{}',
			},
			httpImpl: startThenResults(() => fullResponse(200, COMPLETED_RESULT)),
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(httpFn.mock.calls[0][0].body.files).toEqual({
			'main.mthds': 'domain = "d"',
			'funcs/a.py': 'shared',
			'funcs/b.py': 'shared',
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
		expect(startFields.slice(0, 6)).toEqual([
			'methodId',
			'inlineMethod',
			'mthdsContents',
			'pythonFiles',
			'inputs',
			'binaryInputs',
		]);
	});

	it('offers Binary Inputs as rows of input name + binary field, the field defaulting to data', () => {
		const property = properties.find((p: INodeProperties) => p.name === 'binaryInputs');
		expect(property?.type).toBe('fixedCollection');
		expect(property?.typeOptions?.multipleValues).toBe(true);
		const row = (property?.options ?? [])[0] as { name: string; values: INodeProperties[] };
		expect(row.name).toBe('input');
		expect(row.values.map((value) => value.name)).toEqual(['name', 'binaryPropertyName']);
		expect(row.values.find((value) => value.name === 'binaryPropertyName')?.default).toBe('data');
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
			'binaryInputs',
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

describe('Pipelex node — binary inputs (an n8n file becomes a method input)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The memory of stored uploads is process-wide; every test starts as a
		// fresh process would.
		storedUploads.clear();
	});

	const PDF_BYTES = Buffer.from('%PDF-1.7 a fake invoice');
	const PDF: TestBinary = {
		data: PDF_BYTES.toString('base64'),
		mimeType: 'application/pdf',
		fileName: 'invoice.pdf',
		fileExtension: 'pdf',
	};
	const PNG_BYTES = Buffer.from('\x89PNG fake receipt');
	// n8n types a file it could not identify as octet-stream; the extension decides.
	const PNG: TestBinary = {
		data: PNG_BYTES.toString('base64'),
		mimeType: 'application/octet-stream',
		fileName: 'receipt.png',
	};

	// A presigned URL carries its credential in the query string: it must never
	// reach an error message.
	const STORAGE_ORIGIN = 'https://app-bucket.s3.eu-west-3.amazonaws.com';
	const grantFor = (n: number) => ({
		uri: `pipelex-storage://orgs/org-1/assets/file-${n}.pdf`,
		url: `${STORAGE_ORIGIN}/orgs/org-1/assets/file-${n}.pdf?X-Amz-Credential=AKIASECRET&X-Amz-Signature=deadbeef${n}`,
		headers: {
			'If-None-Match': '*',
			'Content-Type': 'application/pdf',
			'x-amz-meta-uploaded-by': 'user-1',
		},
		expires_at: '2026-09-28T12:05:00Z',
		max_bytes: 52428800,
	});

	/** The hosted plane, faked: numbered grants, storage accepting, a start ack, a completed result. */
	function hostedPlane(overrides: { grant?: HttpImpl; storage?: HttpImpl } = {}): HttpImpl {
		let granted = 0;
		return (options) => {
			const url = String(options.url);
			if (url === 'https://api.test/v1/upload/grant') {
				if (overrides.grant) return overrides.grant(options);
				granted += 1;
				return fullResponse(200, grantFor(granted));
			}
			if (url.startsWith(STORAGE_ORIGIN)) {
				if (overrides.storage) return overrides.storage(options);
				return { statusCode: 200, body: '', headers: {} } as unknown as IN8nHttpFullResponse;
			}
			if (url === 'https://api.test/v1/start') return fullResponse(202, START_ACK);
			return fullResponse(200, COMPLETED_RESULT);
		};
	}

	const calls = (httpFn: ReturnType<typeof vi.fn>) =>
		httpFn.mock.calls.map((call) => call[0] as Record<string, unknown> & { url: string });

	it('uploads the mapped binary, then starts the run with its storage reference as the input', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{"language":"fr"}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.status).toBe('COMPLETED');

		const sent = calls(httpFn);
		expect(sent.map((call) => `${call.method} ${call.url.split('?')[0]}`)).toEqual([
			'POST https://api.test/v1/upload/grant',
			`PUT ${STORAGE_ORIGIN}/orgs/org-1/assets/file-1.pdf`,
			'POST https://api.test/v1/start',
			'GET https://api.test/v1/runs/run-1/results',
		]);
		const [grantCall, putCall, startCall] = sent as Array<Record<string, any>>;

		// The grant describes the file with the name and type n8n carries; the bytes
		// are not in it.
		expect(grantCall.body).toEqual({
			filename: 'invoice.pdf',
			content_type: 'application/pdf',
			size: PDF_BYTES.length,
		});
		expect(grantCall.json).toBe(true);
		expect(grantCall.headers.Authorization).toBe('Bearer secret-token');
		expect(grantCall.headers['User-Agent']).toBe(EXPECTED_USER_AGENT);
		// The grant route never replays: a repeated key would be a 409.
		expect(grantCall.headers['Idempotency-Key']).toBeUndefined();

		// The bytes go straight to storage, with the grant's signed headers and
		// nothing of the node's own: no API key, no User-Agent override.
		expect(putCall.url).toBe(grantFor(1).url);
		expect(putCall.headers).toEqual(grantFor(1).headers);
		expect(Buffer.isBuffer(putCall.body)).toBe(true);
		expect((putCall.body as Buffer).equals(PDF_BYTES)).toBe(true);
		expect(putCall.disableFollowRedirect).toBe(true);
		expect(putCall.json).toBeUndefined();
		// The deadline is the node's own signal, not axios's socket-inactivity timer.
		expect(putCall.timeout).toBeUndefined();
		expect(putCall.abortSignal).toBeInstanceOf(AbortSignal);

		// The reference replaces nothing: it joins the JSON inputs.
		expect(startCall.body).toEqual({
			method_id: 'mt_invoice',
			inputs: {
				language: 'fr',
				document: {
					url: 'pipelex-storage://orgs/org-1/assets/file-1.pdf',
					filename: 'invoice.pdf',
					mime_type: 'application/pdf',
				},
			},
		});
		// A run carrying fresh uploads gets a key that covers them — see idempotencyKey.
		expect(startCall.headers['Idempotency-Key']).toMatch(/^exec-1:node-1:0:files-[0-9a-f]{32}$/);
	});

	it("feeds a Gmail trigger's attachment field on Start Pipeline too", async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'attachment_0' }] },
			},
			items: [{ json: { subject: 'Invoice' }, binary: { attachment_0: PDF } }],
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.pipeline_run_id).toBe('run-1');
		const startCall = calls(httpFn).find((call) => call.url === 'https://api.test/v1/start') as Record<string, any>;
		expect(startCall.body.inputs.document.url).toBe('pipelex-storage://orgs/org-1/assets/file-1.pdf');
	});

	it('uploads every mapped binary of an item, skipping a row left blank', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: {
				methodId: 'mt_expense',
				inputs: '{}',
				binaryInputs: {
					input: [
						{ name: 'invoice', binaryPropertyName: 'attachment_0' },
						// The editor persists a row as soon as its add button is clicked.
						{ name: '  ', binaryPropertyName: 'data' },
						{ name: 'receipt', binaryPropertyName: 'attachment_1' },
					],
				},
			},
			items: [{ json: {}, binary: { attachment_0: PDF, attachment_1: PNG } }],
			httpImpl: hostedPlane(),
		});

		await Pipelex.prototype.execute.call(ctx);
		const sent = calls(httpFn) as Array<Record<string, any>>;
		const grants = sent.filter((call) => call.url === 'https://api.test/v1/upload/grant');
		expect(grants.map((call) => call.body)).toEqual([
			{ filename: 'invoice.pdf', content_type: 'application/pdf', size: PDF_BYTES.length },
			// n8n said octet-stream; the extension names the type instead.
			{ filename: 'receipt.png', content_type: 'image/png', size: PNG_BYTES.length },
		]);
		const startCall = sent.find((call) => call.url === 'https://api.test/v1/start');
		expect(startCall?.body.inputs).toEqual({
			invoice: {
				url: 'pipelex-storage://orgs/org-1/assets/file-1.pdf',
				filename: 'invoice.pdf',
				mime_type: 'application/pdf',
			},
			receipt: {
				url: 'pipelex-storage://orgs/org-1/assets/file-2.pdf',
				filename: 'receipt.png',
				mime_type: 'image/png',
			},
		});
	});

	it('uploads each item its own file', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [
				{ json: {}, binary: { data: PDF } },
				{ json: {}, binary: { data: PNG } },
			],
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0]).toHaveLength(2);
		const starts = calls(httpFn).filter((call) => call.url === 'https://api.test/v1/start') as Array<
			Record<string, any>
		>;
		expect(starts.map((call) => call.body.inputs.document.filename)).toEqual([
			'invoice.pdf',
			'receipt.png',
		]);
		expect(starts[0].headers['Idempotency-Key']).toMatch(/^exec-1:node-1:0:files-/);
		expect(starts[1].headers['Idempotency-Key']).toMatch(/^exec-1:node-1:1:files-/);
	});

	it('names the binary fields the item does carry when the mapped one is missing, before any call', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { attachment_0: PDF, attachment_1: PNG } }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		const error = String(result[0][0].json.error);
		expect(error).toContain('Binary input "document" reads the binary field "data", but this item has no such field.');
		expect(error).toContain('attachment_0, attachment_1');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('says so when the item carries no binary data at all', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {} }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('carries no binary data at all');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('refuses an input set both in Inputs and in Binary Inputs, rather than picking one', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{"document": {"url": "https://example.com/invoice.pdf"}}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('Input "document" is set twice');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('refuses an input mapped twice', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: {
					input: [
						{ name: 'document', binaryPropertyName: 'attachment_0' },
						{ name: 'document', binaryPropertyName: 'attachment_1' },
					],
				},
			},
			items: [{ json: {}, binary: { attachment_0: PDF, attachment_1: PNG } }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('listed more than once');
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('refuses an empty file before uploading anything', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: { ...PDF, data: '' } } }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('is empty (0 bytes)');
		expect(httpFn).not.toHaveBeenCalled();
	});

	/** Run with Continue On Fail off and hand back the error the node threw. */
	async function captureError(ctx: IExecuteFunctions): Promise<Record<string, any>> {
		try {
			await Pipelex.prototype.execute.call(ctx);
		} catch (error) {
			return error as Record<string, any>;
		}
		throw new Error('expected the node to throw');
	}

	it('fails the item with no run when Pipelex refuses the upload as too large', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane({
				grant: () =>
					fullResponse(413, {
						title: 'Payload Too Large',
						detail: 'Declared file size exceeds the 50 MiB limit.',
					}),
			}),
		});

		const error = await captureError(ctx);
		expect(error.message).toContain('The file "invoice.pdf" for input "document" is too large for Pipelex');
		expect(error.message).toContain('(Server: Declared file size exceeds the 50 MiB limit.)');
		expect(error.httpCode).toBe('413');
		expect(calls(httpFn).map((call) => call.url)).toEqual(['https://api.test/v1/upload/grant']);
	});

	it('says the Base URL offers no upload when the grant route is missing', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane({ grant: () => fullResponse(404, { detail: 'Not Found' }) }),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(UPLOAD_UNAVAILABLE_MESSAGE);
	});

	it("classifies storage's refusal and never repeats its body or the grant URL", async () => {
		// S3 echoes the canonical request on a signature mismatch — the credential
		// included. Only its <Code> and <Message> may surface.
		const s3Body =
			'<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>' +
			'<Message>The request signature we calculated does not match the signature you provided.</Message>' +
			'<CanonicalRequest>PUT /orgs/org-1/assets/file-1.pdf X-Amz-Credential=AKIASECRET</CanonicalRequest></Error>';
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane({
				storage: () => ({ statusCode: 403, body: s3Body, headers: {} }) as unknown as IN8nHttpFullResponse,
			}),
		});

		const error = await captureError(ctx);
		expect(error.message).toContain(
			'Storage refused the upload of "invoice.pdf" for input "document" (403 SignatureDoesNotMatch): the request differs from what the upload grant signed.',
		);
		expect(error.httpCode).toBe('403');
		expect(JSON.stringify({ ...error, message: error.message, description: error.description })).not.toMatch(
			/AKIASECRET|X-Amz-Signature|CanonicalRequest/,
		);
		expect(calls(httpFn).some((call) => call.url === 'https://api.test/v1/start')).toBe(false);
	});

	it('names only the storage origin when storage cannot be reached', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane({
				storage: (options) => {
					// A runtime error can carry the whole presigned URL in its message.
					const failure = new Error(`getaddrinfo ENOTFOUND ${options.url}`) as Error & { code: string };
					failure.name = 'AxiosError';
					failure.code = 'ENOTFOUND';
					throw failure;
				},
			}),
		});

		const error = await captureError(ctx);
		expect(error.message).toContain(
			`The upload of "invoice.pdf" for input "document" could not reach storage at ${STORAGE_ORIGIN}.`,
		);
		// The code rides in the description: in the message, n8n would swap the whole
		// sentence for a generic "incorrect host" one naming neither file nor host.
		expect(error.description).toBe('Network failure: AxiosError ENOTFOUND.');
		expect(`${error.message} ${error.description}`).not.toMatch(/AKIASECRET|X-Amz-Signature/);
		expect(calls(httpFn).some((call) => call.url === 'https://api.test/v1/start')).toBe(false);
	});

	it('reports a storage upload that ran out of time as unknown, not as refused', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane({
				storage: () => {
					const failure = new Error('timeout of 61000ms exceeded') as Error & { code: string };
					failure.code = 'ECONNABORTED';
					throw failure;
				},
			}),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			/did not finish within 61 s, so whether storage stored it is unknown/,
		);
	});

	/** Storage that never answers: the request settles only when its signal aborts, as axios does. */
	const storageAwaitingAbort: HttpImpl = (options) =>
		new Promise<never>((_resolve, reject) => {
			const signal = options.abortSignal as AbortSignal;
			const cancel = (): void => {
				const failure = new Error('canceled') as Error & { code: string };
				failure.name = 'CanceledError';
				failure.code = 'ERR_CANCELED';
				reject(failure);
			};
			if (signal.aborted) cancel();
			else signal.addEventListener('abort', cancel, { once: true });
		});

	it("owns the PUT's deadline: its own timeout signal, sized by the file, ends a stalled upload", async () => {
		// A stand-in for AbortSignal.timeout that the test fires itself, so the
		// deadline is proven without waiting a minute.
		const deadline = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => deadline.signal);
		const cancel = new AbortController();
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			cancelSignal: cancel.signal,
			httpImpl: hostedPlane({
				storage: (options) => {
					deadline.abort();
					return storageAwaitingAbort(options);
				},
			}),
		});

		const error = await captureError(ctx);
		expect(timeoutSpy).toHaveBeenCalledWith(61_000);
		expect(error.message).toContain(
			'The upload of "invoice.pdf" for input "document" to storage did not finish within 61 s, so whether storage stored it is unknown.',
		);
		// The execution was not cancelled: the deadline, not the user, ended it.
		expect(cancel.signal.aborted).toBe(false);
	});

	it('says the upload was cancelled when the execution is, even with the deadline linked in', async () => {
		const cancel = new AbortController();
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			cancelSignal: cancel.signal,
			httpImpl: hostedPlane({
				storage: (options) => {
					cancel.abort();
					return storageAwaitingAbort(options);
				},
			}),
		});

		const error = await captureError(ctx);
		expect(error.message).toBe('The upload of "invoice.pdf" for input "document" was cancelled with the execution.');
	});

	it('reads a connect timeout as storage never reached, not as a file that may have been stored', async () => {
		const { ctx } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane({
				storage: () => {
					// What axios throws when the TCP connection never opens: the operating
					// system's ETIMEDOUT, its `syscall` on the cause.
					const cause = Object.assign(new Error('connect ETIMEDOUT 52.95.0.1:443'), {
						code: 'ETIMEDOUT',
						syscall: 'connect',
					});
					throw Object.assign(new Error('connect ETIMEDOUT 52.95.0.1:443'), {
						name: 'AxiosError',
						code: 'ETIMEDOUT',
						cause,
					});
				},
			}),
		});

		const error = await captureError(ctx);
		expect(error.message).toContain(
			`The upload of "invoice.pdf" for input "document" could not reach storage at ${STORAGE_ORIGIN}.`,
		);
		expect(error.description).toBe('Network failure: AxiosError ETIMEDOUT, caused by Error ETIMEDOUT.');
	});

	it('turns an upload failure into an error item under Continue On Fail', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'startAndPoll',
			params: {
				methodId: 'mt_invoice',
				inputs: '{}',
				binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
			},
			items: [{ json: {}, binary: { data: PDF } }],
			continueOnFail: true,
			httpImpl: hostedPlane({
				storage: () =>
					({
						statusCode: 503,
						body: '<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>',
						headers: {},
					}) as unknown as IN8nHttpFullResponse,
			}),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain(
			'Storage failed to store "invoice.pdf" for input "document" (503 SlowDown): Please reduce your request rate. Whether the file was stored is unknown; retry the item.',
		);
		expect(calls(httpFn).some((call) => call.url === 'https://api.test/v1/start')).toBe(false);
	});

	// ── Retry On Fail: a retried item reuses what it stored ──────────────────
	// n8n retries by running the whole node again, every item of it, in the same
	// execution. Each test below calls `execute` twice on one context to play it.

	const ONE_DOCUMENT = {
		methodId: 'mt_invoice',
		inputs: '{}',
		binaryInputs: { input: [{ name: 'document', binaryPropertyName: 'data' }] },
	};

	it('reuses the stored reference when Retry On Fail re-runs the node, so the run key stays and the run replays', async () => {
		// The first attempt stores item 0 and starts its run, then fails on item 1,
		// whose PUT storage refuses; the retry re-runs both items.
		let storageDown = true;
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: ONE_DOCUMENT,
			items: [
				{ json: {}, binary: { data: PDF } },
				{ json: {}, binary: { data: PNG } },
			],
			httpImpl: hostedPlane({
				storage: (options) =>
					storageDown && String(options.url).includes('/file-2.pdf')
						? ({ statusCode: 503, body: '', headers: {} } as unknown as IN8nHttpFullResponse)
						: ({ statusCode: 200, body: '', headers: {} } as unknown as IN8nHttpFullResponse),
			}),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/Storage failed to store "receipt.png"/);
		const firstAttempt = calls(httpFn) as Array<Record<string, any>>;
		const [firstStart] = firstAttempt.filter((call) => call.url === 'https://api.test/v1/start');

		storageDown = false;
		httpFn.mockClear();
		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0]).toHaveLength(2);

		const retry = calls(httpFn) as Array<Record<string, any>>;
		// Item 0 is not uploaded again; only item 1, whose PUT failed, is.
		expect(retry.filter((call) => call.url === 'https://api.test/v1/upload/grant')).toHaveLength(1);
		const retryStarts = retry.filter((call) => call.url === 'https://api.test/v1/start');
		expect(retryStarts).toHaveLength(2);
		// Item 0 sends the very body and key of its first attempt: the platform
		// replays the run it already started instead of starting a second one.
		expect(retryStarts[0].body).toEqual(firstStart.body);
		expect(retryStarts[0].headers['Idempotency-Key']).toBe(firstStart.headers['Idempotency-Key']);
		expect(retryStarts[0].body.inputs.document.url).toBe('pipelex-storage://orgs/org-1/assets/file-1.pdf');
		// Item 1's failed PUT was never remembered: its retry stored a new object.
		expect(retryStarts[1].body.inputs.document.url).toBe('pipelex-storage://orgs/org-1/assets/file-3.pdf');
	});

	it('uploads again, under a new key, when the bytes changed between attempts', async () => {
		const items: NonNullable<ContextOptions['items']> = [{ json: {}, binary: { data: PDF } }];
		const { ctx, httpFn } = makeContext({ operation: 'start', params: ONE_DOCUMENT, items, httpImpl: hostedPlane() });

		await Pipelex.prototype.execute.call(ctx);
		const [first] = calls(httpFn).filter((call) => call.url === 'https://api.test/v1/start') as Array<
			Record<string, any>
		>;

		items[0].binary = { data: { ...PDF, data: Buffer.from('%PDF-1.7 the corrected invoice').toString('base64') } };
		httpFn.mockClear();
		await Pipelex.prototype.execute.call(ctx);
		const retry = calls(httpFn) as Array<Record<string, any>>;
		expect(retry.filter((call) => call.url === 'https://api.test/v1/upload/grant')).toHaveLength(1);
		const [second] = retry.filter((call) => call.url === 'https://api.test/v1/start');
		expect(second.body.inputs.document.url).not.toBe(first.body.inputs.document.url);
		expect(second.headers['Idempotency-Key']).not.toBe(first.headers['Idempotency-Key']);
	});

	it('never reuses a reference across executions', async () => {
		const first = makeContext({
			operation: 'start',
			params: ONE_DOCUMENT,
			items: [{ json: {}, binary: { data: PDF } }],
			httpImpl: hostedPlane(),
		});
		await Pipelex.prototype.execute.call(first.ctx);

		const second = makeContext({
			operation: 'start',
			params: ONE_DOCUMENT,
			items: [{ json: {}, binary: { data: PDF } }],
			executionId: 'exec-2',
			httpImpl: hostedPlane(),
		});
		await Pipelex.prototype.execute.call(second.ctx);
		expect(calls(second.httpFn).filter((call) => call.url === 'https://api.test/v1/upload/grant')).toHaveLength(1);
	});

	// ── Memory: measured from metadata, loaded one file at a time ────────────

	const TWO_FILES = {
		methodId: 'mt_expense',
		inputs: '{}',
		binaryInputs: {
			input: [
				{ name: 'invoice', binaryPropertyName: 'attachment_0' },
				{ name: 'receipt', binaryPropertyName: 'attachment_1' },
			],
		},
	};

	it("refuses a file over the size limit from n8n's metadata, before loading or sending anything", async () => {
		const { ctx, httpFn, bufferFn } = makeContext({
			operation: 'start',
			params: TWO_FILES,
			items: [
				{
					json: {},
					binary: { attachment_0: PDF, attachment_1: { ...PNG, bytes: 60 * 1024 * 1024 } },
				},
			],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toBe(
			'The file "receipt.png" in binary field "attachment_1" for input "receipt" is 62914560 bytes, over the 50 MiB Pipelex accepts for one file, so it was not uploaded. Pass a smaller file.',
		);
		expect(bufferFn).not.toHaveBeenCalled();
		expect(httpFn).not.toHaveBeenCalled();
	});

	it("refuses an empty file from n8n's metadata, before loading the files before it", async () => {
		const { ctx, httpFn, bufferFn } = makeContext({
			operation: 'start',
			params: TWO_FILES,
			items: [{ json: {}, binary: { attachment_0: PDF, attachment_1: { ...PNG, bytes: 0 } } }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('is empty (0 bytes)');
		expect(bufferFn).not.toHaveBeenCalled();
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('reads the size of a binary n8n keeps outside memory through getBinaryMetadata', async () => {
		const { ctx, httpFn, bufferFn } = makeContext({
			operation: 'start',
			params: ONE_DOCUMENT,
			items: [{ json: {}, binary: { data: { ...PDF, id: 'filesystem-v2:abc' } } }],
			binaryMetadata: { 'filesystem-v2:abc': { fileSize: 51 * 1024 * 1024 } },
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('over the 50 MiB Pipelex accepts for one file');
		expect(bufferFn).not.toHaveBeenCalled();
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('measures the loaded file when the metadata says nothing', async () => {
		// Kept outside memory, but this n8n offers no getBinaryMetadata.
		const { ctx, httpFn, bufferFn } = makeContext({
			operation: 'start',
			params: ONE_DOCUMENT,
			items: [{ json: {}, binary: { data: { ...PDF, data: '', id: 'filesystem-v2:abc' } } }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toContain('is empty (0 bytes)');
		expect(bufferFn).toHaveBeenCalledTimes(1);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('loads, uploads and lets go of one file before loading the next', async () => {
		const log: string[] = [];
		const plane = hostedPlane();
		const { ctx } = makeContext({
			operation: 'start',
			params: TWO_FILES,
			items: [{ json: {}, binary: { attachment_0: PDF, attachment_1: PNG } }],
			log,
			httpImpl: (options) => {
				const url = String(options.url);
				log.push(
					url === 'https://api.test/v1/upload/grant' ? 'grant' : url.startsWith(STORAGE_ORIGIN) ? 'put' : 'start',
				);
				return plane(options);
			},
		});

		await Pipelex.prototype.execute.call(ctx);
		expect(log).toEqual([
			'load attachment_0',
			'grant',
			'put',
			'load attachment_1',
			'grant',
			'put',
			'start',
		]);
	});

	// ── The workflow's binary mode ────────────────────────────────────────────

	it("finds a file kept in the item's JSON under the combined binary mode", async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: ONE_DOCUMENT,
			binaryMode: 'combined',
			items: [{ json: { subject: 'Invoice', data: PDF as unknown as Record<string, unknown> } }],
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(result[0][0].json.pipeline_run_id).toBe('run-1');
		const startCall = calls(httpFn).find((call) => call.url === 'https://api.test/v1/start') as Record<string, any>;
		expect(startCall.body.inputs.document).toEqual({
			url: 'pipelex-storage://orgs/org-1/assets/file-1.pdf',
			filename: 'invoice.pdf',
			mime_type: 'application/pdf',
		});
	});

	it("names the JSON's binary fields when the mapped one is missing under the combined mode", async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'start',
			params: ONE_DOCUMENT,
			binaryMode: 'combined',
			items: [{ json: { subject: 'Invoice', attachment_0: PDF as unknown as Record<string, unknown> } }],
			continueOnFail: true,
			httpImpl: hostedPlane(),
		});

		const result = await Pipelex.prototype.execute.call(ctx);
		expect(String(result[0][0].json.error)).toBe(
			'Binary input "document" reads the binary field "data", but this item has no such field. Its binary fields are: attachment_0.',
		);
		expect(httpFn).not.toHaveBeenCalled();
	});
});
