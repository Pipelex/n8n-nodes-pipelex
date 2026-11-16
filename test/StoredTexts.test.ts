/**
 * Stored texts — a `Text`, `Markdown`, `Html` or `JSON` value the runtime holds by reference,
 * `{ url, size, mime_type, preview }`, in place of its value field. The node hands every stored
 * text of `main_stuff` on loaded, as `@pipelex/sdk` does by default: the references resolved
 * through the platform's bulk route, each signed link read from storage, a `data:` URL decoded
 * where it is, and nothing read from any other URL.
 *
 * The pure half (which values are stored texts, by concept) is tested directly; the loading is
 * tested through the node's own operations, the HTTP boundary mocked per URL.
 */

import { Readable } from 'node:stream';

import type { IDataObject, IExecuteFunctions, IN8nHttpFullResponse } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../nodes/Pipelex/GenericFunctions', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../nodes/Pipelex/GenericFunctions')>();
	return { ...actual, abortableSleep: vi.fn(async () => {}) };
});

import { Pipelex } from '../nodes/Pipelex/Pipelex.node';
import {
	BULK_RESOLVE_MAX_URIS,
	STORED_TEXTS_ITEM_MAX_BYTES,
	STORED_TEXT_MAX_BYTES,
	findStoredTexts,
	mainStuffNode,
	renderPath,
	storedTextKindOf,
	storedTextKindOfNode,
	type FormNode,
} from '../nodes/Pipelex/StoredTexts';

const BASE_URL = 'https://api.test';
const RUN_ID = 'run-stored';
const STORE = 'https://store.example';
const SECRET_SIGNATURE = 'X-Amz-Signature=very-secret-signature';
const SCOPE = `pipelex-storage://org/method/${RUN_ID}/generated`;
const RESOLVE_URL = `${BASE_URL}/v1/resolve-storage-url/bulk`;

function storedUri(hash: string, extension = 'txt'): string {
	return `${SCOPE}/${hash}/value.${extension}`;
}

function reference(uri: string, mimeType = 'text/plain', size = 4096): Record<string, unknown> {
	return { url: uri, size, mime_type: mimeType, preview: 'The start…' };
}

function signedLink(uri: string): string {
	return `${STORE}/${encodeURIComponent(uri)}?${SECRET_SIGNATURE}`;
}

/** A results body: the main stuff, the working memory naming its concept, and an output form. */
function results(concept: string, mainStuff: unknown, outputField?: FormNode): IDataObject {
	return {
		pipeline_run_id: RUN_ID,
		main_stuff: mainStuff,
		working_memory: {
			root: { summary: { concept, content: mainStuff } },
			aliases: { main_stuff: 'summary' },
		},
		output_form:
			outputField === undefined ? {} : { 'my_domain.summarize': { field: { ...outputField, name: 'output' } } },
		input_form: {},
	} as IDataObject;
}

function fullResponse(statusCode: number, body: unknown, headers: Record<string, unknown> = {}): IN8nHttpFullResponse {
	return { statusCode, body, headers } as IN8nHttpFullResponse;
}

type RequestOptions = {
	method?: string;
	url: string;
	headers?: Record<string, unknown>;
	body?: unknown;
	[key: string]: unknown;
};

interface Boundary {
	/** The `uris` of each bulk resolve request, in order. */
	resolved: string[][];
	/** Each storage request's options, in order. */
	fetched: RequestOptions[];
	/** Every request's URL, in order. */
	urls: string[];
	/** The body of each read whose body never arrives, in order. */
	hungBodies: Readable[];
}

/**
 * Mock the HTTP boundary: the results route answers `body`, the bulk route resolves each
 * reference to a signed store link (or answers `refusals[uri]`, or `resolveStatus`), and the
 * store answers each link with the bytes `objects` holds for its reference, as a stream.
 */
function mockBoundary(options: {
	body: IDataObject;
	objects?: Record<string, string | Buffer>;
	refusals?: Record<string, Record<string, unknown>>;
	resolveStatus?: { statusCode: number; body: Record<string, unknown> };
	storeStatus?: Record<string, { statusCode: number; body: string }>;
	storeHeaders?: Record<string, Record<string, unknown>>;
	asBuffer?: boolean;
	/** References whose read never ends on its own: the request never answers, or its body never arrives. */
	hang?: Record<string, 'request' | 'body'>;
	/** Called once a hanging read has started. */
	onHang?: () => void;
	/** The results route's answers, one per poll, the last one repeated; `body` when absent. */
	bodies?: IDataObject[];
	/** Each reference's `expires_at` on the bulk route's `call`-th answer (0-based); fifteen minutes from now by default. */
	expiresAt?: (uri: string, call: number) => string;
	/** The bulk route's request fails with this error instead of answering. */
	resolveError?: Error;
	/** The bulk route never answers on its own; called once it is waiting. */
	resolveHang?: () => void;
	/** References whose body is this stream, read as storage sends it. */
	streams?: Record<string, () => Readable>;
}): { boundary: Boundary; http: (o: RequestOptions) => Promise<IN8nHttpFullResponse> } {
	const boundary: Boundary = { resolved: [], fetched: [], urls: [], hungBodies: [] };
	let polls = 0;
	const http = async (o: RequestOptions): Promise<IN8nHttpFullResponse> => {
		boundary.urls.push(o.url);
		if (o.url === `${BASE_URL}/v1/start`) {
			return fullResponse(202, { pipeline_run_id: RUN_ID, state: 'STARTED' });
		}
		if (o.url.startsWith(`${BASE_URL}/v1/runs/${RUN_ID}/results`)) {
			const bodies = options.bodies;
			if (bodies === undefined) return fullResponse(200, options.body);
			const body = bodies[Math.min(polls, bodies.length - 1)];
			polls += 1;
			return fullResponse(200, body);
		}
		if (o.url === RESOLVE_URL) {
			const { uris } = o.body as { uris: string[] };
			const call = boundary.resolved.length;
			boundary.resolved.push(uris);
			if (options.resolveError) throw options.resolveError;
			if (options.resolveHang) {
				const signal = o.abortSignal as AbortSignal | undefined;
				const stopped = new Promise<IN8nHttpFullResponse>((_resolve, reject) => {
					const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
					if (signal?.aborted) abort();
					signal?.addEventListener('abort', abort, { once: true });
				});
				options.resolveHang();
				return stopped;
			}
			if (options.resolveStatus) return fullResponse(options.resolveStatus.statusCode, options.resolveStatus.body);
			const items = uris.map(
				(uri) =>
					options.refusals?.[uri] ?? {
						uri,
						url: signedLink(uri),
						expires_at: options.expiresAt?.(uri, call) ?? new Date(Date.now() + 15 * 60_000).toISOString(),
						content_type: 'text/plain',
						error: null,
					},
			);
			return fullResponse(200, { items });
		}
		if (o.url.startsWith(STORE)) {
			boundary.fetched.push(o);
			const uri = decodeURIComponent(new URL(o.url).pathname.slice(1));
			const hang = options.hang?.[uri];
			if (hang === 'request') {
				const signal = o.abortSignal as AbortSignal | undefined;
				const stopped = new Promise<IN8nHttpFullResponse>((_resolve, reject) => {
					const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
					if (signal?.aborted) abort();
					signal?.addEventListener('abort', abort, { once: true });
				});
				options.onHang?.();
				return stopped;
			}
			if (hang === 'body') {
				const body = new Readable({ read() {} });
				boundary.hungBodies.push(body);
				options.onHang?.();
				return fullResponse(200, body);
			}
			const stream = options.streams?.[uri];
			if (stream) {
				const body = stream();
				boundary.hungBodies.push(body);
				return fullResponse(200, body);
			}
			const status = options.storeStatus?.[uri];
			if (status) return fullResponse(status.statusCode, Readable.from([Buffer.from(status.body)]));
			const object = options.objects?.[uri];
			if (object === undefined) return fullResponse(404, Readable.from([Buffer.from('<Error><Code>NoSuchKey</Code></Error>')]));
			const bytes = typeof object === 'string' ? Buffer.from(object, 'utf8') : object;
			return fullResponse(200, options.asBuffer ? bytes : Readable.from([bytes]), options.storeHeaders?.[uri] ?? {});
		}
		throw new Error(`unexpected request ${o.method ?? 'GET'} ${o.url}`);
	};
	return { boundary, http };
}

function makeContext(opts: {
	operation: string;
	http: (o: RequestOptions) => Promise<IN8nHttpFullResponse>;
	continueOnFail?: boolean;
	params?: Record<string, unknown>;
	cancelSignal?: AbortSignal;
}): IExecuteFunctions {
	const params: Record<string, unknown> = { runId: RUN_ID, maxWaitSeconds: 60, ...(opts.params ?? {}) };
	return {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({ baseUrl: BASE_URL, apiKey: 'secret-token' }),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'operation') return opts.operation;
			return name in params ? params[name] : fallback;
		},
		getExecutionId: () => 'exec-1',
		getWorkflowDataProxy: () => ({ $thisRunIndex: 0 }),
		getExecutionCancelSignal: () => opts.cancelSignal,
		continueOnFail: () => opts.continueOnFail ?? false,
		getNode: () => ({ id: 'node-1', name: 'Pipelex', type: 'pipelex', typeVersion: 1 }),
		helpers: { httpRequest: vi.fn(opts.http) },
	} as unknown as IExecuteFunctions;
}

async function runGetResult(http: (o: RequestOptions) => Promise<IN8nHttpFullResponse>): Promise<IDataObject> {
	const [[item]] = await Pipelex.prototype.execute.call(makeContext({ operation: 'getResult', http }));
	return item.json;
}

/** The error an item fails with, as n8n reports it: its message and its description. */
async function failureOf(
	http: (o: RequestOptions) => Promise<IN8nHttpFullResponse>,
	cancelSignal?: AbortSignal,
	operation = 'getResult',
): Promise<{ message: string; description: string }> {
	try {
		await Pipelex.prototype.execute.call(makeContext({ operation, http, cancelSignal }));
	} catch (error) {
		const failure = error as { message: string; description?: string | null };
		return { message: failure.message, description: failure.description ?? '' };
	}
	throw new Error('the item did not fail');
}

afterEach(() => vi.restoreAllMocks());

// ── Which values are stored texts ─────────────────────────────────────

describe('stored texts — told by concept', () => {
	it('names the kind of each stored-text native and of a concept refining one', () => {
		expect(storedTextKindOf('native.Text')).toBe('text');
		expect(storedTextKindOf('native.Markdown')).toBe('text');
		expect(storedTextKindOf('native.Html')).toBe('html');
		expect(storedTextKindOf('native.JSON')).toBe('json');
		expect(storedTextKindOf('my.Memo', ['native.Text'])).toBe('text');
		expect(storedTextKindOf('native.Document')).toBeNull();
		expect(storedTextKindOf('native.Image')).toBeNull();
	});

	it('reads a description-only concept as text, and a list or a bare field as none', () => {
		expect(storedTextKindOfNode({ kind: 'prose', concept_ref: 'my.Note' })).toBe('text');
		expect(storedTextKindOfNode({ kind: 'prose', concept_ref: 'my.Doc', refines: ['native.Document'] })).toBeNull();
		expect(storedTextKindOfNode({ kind: 'text' })).toBeNull();
		expect(
			storedTextKindOfNode({ kind: 'list', concept_ref: 'native.Text', item: { kind: 'prose', concept_ref: 'native.Text' } }),
		).toBeNull();
	});

	it('finds no node for a result without a working memory', () => {
		expect(mainStuffNode({ main_stuff: reference(storedUri('a')) })).toBeNull();
	});

	it('finds a stored text in a structured output, and leaves a document of the same shape alone', () => {
		const output: FormNode = {
			kind: 'object',
			concept_ref: 'my.Report',
			fields: [
				{ kind: 'prose', name: 'summary', concept_ref: 'native.Text' },
				{ kind: 'document', name: 'source', concept_ref: 'native.Document' },
			],
		};
		const mainStuff = { summary: reference(storedUri('s')), source: reference(storedUri('d', 'pdf'), 'application/pdf') };
		const body = results('my.Report', mainStuff, output);
		const sites = findStoredTexts(mainStuff, mainStuffNode(body)!);
		expect(sites.map((site) => [renderPath(site.segments), site.kind, site.url])).toEqual([
			['$.summary', 'text', storedUri('s')],
		]);
	});

	it('walks the plural envelope and the native page shape without a form', () => {
		const pages = { items: [{ text_and_images: { text: reference(storedUri('p0')), images: [] } }] };
		const sites = findStoredTexts(pages, mainStuffNode(results('native.Page', pages))!);
		expect(sites.map((site) => renderPath(site.segments))).toEqual(['$.items[0].text_and_images.text']);
	});

	it('walks a list content sent as a bare array, as it walks the plural envelope', () => {
		const texts = [reference(storedUri('a')), { text: 'inline' }, reference(storedUri('b'))];
		const sites = findStoredTexts(texts, mainStuffNode(results('native.Text', texts))!);
		expect(sites.map((site) => [renderPath(site.segments), site.kind, site.url])).toEqual([
			['$[0]', 'text', storedUri('a')],
			['$[2]', 'text', storedUri('b')],
		]);
	});

	it('walks a bare array of a structured concept by the fields of its concept', () => {
		const output: FormNode = {
			kind: 'list',
			concept_ref: 'my.Report',
			item: {
				kind: 'object',
				concept_ref: 'my.Report',
				fields: [
					{ kind: 'prose', name: 'summary', concept_ref: 'native.Text' },
					{ kind: 'document', name: 'source', concept_ref: 'native.Document' },
				],
			},
		};
		const reports = [{ summary: reference(storedUri('s')), source: reference(storedUri('d')) }];
		const sites = findStoredTexts(reports, mainStuffNode(results('my.Report', reports, output))!);
		expect(sites.map((site) => renderPath(site.segments))).toEqual(['$[0].summary']);
	});

	it('ignores an inline value', () => {
		const sites = findStoredTexts({ text: 'hello' }, mainStuffNode(results('native.Text', { text: 'hello' }))!);
		expect(sites).toEqual([]);
	});
});

// ── Loading, through the node ─────────────────────────────────────────

describe('stored texts — the node hands them on loaded', () => {
	it('loads a stored Markdown into its text through the bulk route and the signed link', async () => {
		const uri = storedUri('md', 'md');
		const { boundary, http } = mockBoundary({
			body: results('native.Markdown', reference(uri, 'text/markdown')),
			objects: { [uri]: '# Quarterly review\n\nAll good.' },
		});

		const json = await runGetResult(http);

		expect(json.status).toBe('COMPLETED');
		expect(json.main_stuff).toEqual({ text: '# Quarterly review\n\nAll good.' });
		expect(boundary.resolved).toEqual([[uri]]);
		expect(boundary.fetched).toHaveLength(1);
		const [storeRequest] = boundary.fetched;
		// The signed link is the credential: the node's own Authorization never rides along,
		// and a redirect is never followed.
		expect(storeRequest.headers?.Authorization).toBeUndefined();
		expect(storeRequest.disableFollowRedirect).toBe(true);
		expect(storeRequest.method).toBe('GET');
	});

	it('sends the bulk resolve with the API headers', async () => {
		const uri = storedUri('t');
		const { http } = mockBoundary({ body: results('native.Text', reference(uri)), objects: { [uri]: 'hello' } });
		const ctx = makeContext({ operation: 'getResult', http });
		await Pipelex.prototype.execute.call(ctx);
		const calls = (ctx.helpers.httpRequest as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
			(call) => call[0] as RequestOptions,
		);
		const resolveCall = calls.find((call) => call.url === RESOLVE_URL)!;
		expect(resolveCall.method).toBe('POST');
		expect(resolveCall.body).toEqual({ uris: [uri] });
		expect(resolveCall.headers?.Authorization).toBe('Bearer secret-token');
		expect(String(resolveCall.headers?.['User-Agent'])).toMatch(/^n8n-nodes-pipelex\//);
	});

	it('loads an Html into inner_html keeping its css_class, and a JSON into the object it serializes', async () => {
		const htmlUri = storedUri('h', 'html');
		const jsonUri = storedUri('j', 'json');
		const output: FormNode = {
			kind: 'object',
			concept_ref: 'my.Page',
			fields: [
				{ kind: 'unknown', name: 'body', concept_ref: 'native.Html' },
				{ kind: 'unknown', name: 'data', concept_ref: 'native.JSON' },
			],
		};
		const mainStuff = {
			body: { ...reference(htmlUri, 'text/html'), css_class: 'report' },
			data: reference(jsonUri, 'application/json'),
		};
		const { http } = mockBoundary({
			body: results('my.Page', mainStuff, output),
			objects: { [htmlUri]: '<p>Hi</p>', [jsonUri]: '{"total": 3, "rows": [1, 2]}' },
		});

		const json = await runGetResult(http);

		expect(json.main_stuff).toEqual({
			body: { inner_html: '<p>Hi</p>', css_class: 'report' },
			data: { json_obj: { total: 3, rows: [1, 2] } },
		});
	});

	it('leaves a document whose reference looks like a stored text untouched', async () => {
		const textUri = storedUri('s');
		const docUri = storedUri('d', 'txt');
		const output: FormNode = {
			kind: 'object',
			concept_ref: 'my.Report',
			fields: [
				{ kind: 'prose', name: 'summary', concept_ref: 'native.Text' },
				{ kind: 'document', name: 'source', concept_ref: 'native.Document' },
			],
		};
		const mainStuff = { summary: reference(textUri), source: reference(docUri) };
		const { boundary, http } = mockBoundary({
			body: results('my.Report', mainStuff, output),
			objects: { [textUri]: 'Summary.' },
		});

		const json = await runGetResult(http);

		expect(json.main_stuff).toEqual({ summary: { text: 'Summary.' }, source: reference(docUri) });
		expect(boundary.resolved).toEqual([[textUri]]);
	});

	it('loads every item of a list, reading a repeated reference once', async () => {
		const a = storedUri('a');
		const b = storedUri('b');
		const { boundary, http } = mockBoundary({
			body: results('native.Text', { items: [reference(a), reference(b), reference(a)] }),
			objects: { [a]: 'first', [b]: 'second' },
		});

		const json = await runGetResult(http);

		expect(json.main_stuff).toEqual({ items: [{ text: 'first' }, { text: 'second' }, { text: 'first' }] });
		expect(boundary.resolved).toEqual([[a, b]]);
		expect(boundary.fetched).toHaveLength(2);
	});

	it('loads every item of a list sent as a bare array', async () => {
		const a = storedUri('a');
		const b = storedUri('b');
		const { http } = mockBoundary({
			body: results('native.Text', [reference(a), reference(b)]),
			objects: { [a]: 'first', [b]: 'second' },
		});

		const json = await runGetResult(http);

		expect(json.main_stuff).toEqual([{ text: 'first' }, { text: 'second' }]);
	});

	it('decodes a reference found under two kinds by the kind of each place, reading it once', async () => {
		const uri = storedUri('shared', 'json');
		const output: FormNode = {
			kind: 'object',
			concept_ref: 'my.Pair',
			fields: [
				{ kind: 'prose', name: 'raw', concept_ref: 'native.Text' },
				{ kind: 'unknown', name: 'data', concept_ref: 'native.JSON' },
			],
		};
		const mainStuff = { raw: reference(uri, 'application/json'), data: reference(uri, 'application/json') };
		const { boundary, http } = mockBoundary({
			body: results('my.Pair', mainStuff, output),
			objects: { [uri]: '{"total": 3}' },
		});

		const json = await runGetResult(http);

		expect(json.main_stuff).toEqual({ raw: { text: '{"total": 3}' }, data: { json_obj: { total: 3 } } });
		expect(boundary.resolved).toEqual([[uri]]);
		expect(boundary.fetched).toHaveLength(1);
	});

	it('resolves at most the route bound per request', async () => {
		const uris = Array.from({ length: BULK_RESOLVE_MAX_URIS + 1 }, (_, index) => storedUri(`n${index}`));
		const { boundary, http } = mockBoundary({
			body: results('native.Text', { items: uris.map((uri) => reference(uri)) }),
			objects: Object.fromEntries(uris.map((uri, index) => [uri, `text ${index}`])),
		});

		const json = await runGetResult(http);

		expect(boundary.resolved.map((chunk) => chunk.length)).toEqual([BULK_RESOLVE_MAX_URIS, 1]);
		expect((json.main_stuff as { items: unknown[] }).items[BULK_RESOLVE_MAX_URIS]).toEqual({
			text: `text ${BULK_RESOLVE_MAX_URIS}`,
		});
	});

	it('decodes a data: URL where it is, with no request', async () => {
		const url = `data:text/plain;base64,${Buffer.from('café', 'utf8').toString('base64')}`;
		const { boundary, http } = mockBoundary({ body: results('native.Text', { url, size: 5, mime_type: 'text/plain' }) });

		const json = await runGetResult(http);

		expect(json.main_stuff).toEqual({ text: 'café' });
		expect(boundary.resolved).toEqual([]);
		expect(boundary.fetched).toEqual([]);
	});

	it('reads a body n8n hands back as bytes rather than a stream', async () => {
		const uri = storedUri('t');
		const { http } = mockBoundary({ body: results('native.Text', reference(uri)), objects: { [uri]: 'bytes' }, asBuffer: true });
		expect((await runGetResult(http)).main_stuff).toEqual({ text: 'bytes' });
	});

	it('also loads on Start & Wait for Result', async () => {
		const uri = storedUri('t');
		const { http } = mockBoundary({ body: results('native.Text', reference(uri)), objects: { [uri]: 'waited' } });
		const [[item]] = await Pipelex.prototype.execute.call(
			makeContext({ operation: 'startAndPoll', http, params: { pipeCode: 'p', inputs: '{}' } }),
		);
		expect(item.json.main_stuff).toEqual({ text: 'waited' });
	});

	it('makes no extra request for an inline value', async () => {
		const { boundary, http } = mockBoundary({ body: results('native.Text', { text: 'inline' }) });
		const json = await runGetResult(http);
		expect(json.main_stuff).toEqual({ text: 'inline' });
		expect(boundary.urls).toHaveLength(1);
	});

	it('hands a result without a working memory on as it is when nothing in it looks like a stored text', async () => {
		const mainStuff = { title: 'Plain', link: { url: 'https://example.com/a' } };
		const { boundary, http } = mockBoundary({ body: { pipeline_run_id: RUN_ID, main_stuff: mainStuff } });
		const json = await runGetResult(http);
		expect(json.main_stuff).toEqual(mainStuff);
		expect(boundary.urls).toHaveLength(1);
	});

	it('hands a structured output without an output form on as it is when nothing in it looks like a stored text', async () => {
		const mainStuff = { title: 'Plain', cover: { url: storedUri('img', 'png'), mime_type: 'image/png' } };
		const body = { ...results('my.Report', mainStuff), output_form: null };
		const { boundary, http } = mockBoundary({ body });
		const json = await runGetResult(http);
		expect(json.main_stuff).toEqual(mainStuff);
		expect(boundary.urls).toHaveLength(1);
	});
});

// ── A result that does not say which values are texts ─────────────────

describe('stored texts — never handed on as references when the concepts are missing', () => {
	it('fails a result without a working memory rather than handing on its reference', async () => {
		const uri = storedUri('t');
		const { boundary, http } = mockBoundary({ body: { pipeline_run_id: RUN_ID, main_stuff: reference(uri) } });

		const failure = await failureOf(http);

		expect(failure.message).toContain('working_memory');
		expect(failure.message).toContain(RUN_ID);
		expect(boundary.resolved).toEqual([]);
	});

	it('fails a structured output whose output form is not written rather than handing on its texts', async () => {
		const uri = storedUri('s');
		const body = { ...results('my.Report', { summary: reference(uri) }), output_form: null };
		const { boundary, http } = mockBoundary({ body });

		const failure = await failureOf(http);

		expect(failure.message).toContain('output_form');
		expect(failure.message).toContain('Get Run Result');
		expect(failure.message).toContain(RUN_ID);
		expect(boundary.resolved).toEqual([]);
	});

	it('waits on Poll & Get Result through the window where the output form is not yet written', async () => {
		const uri = storedUri('s');
		const output: FormNode = {
			kind: 'object',
			concept_ref: 'my.Report',
			fields: [{ kind: 'prose', name: 'summary', concept_ref: 'native.Text' }],
		};
		const described = results('my.Report', { summary: reference(uri) }, output);
		const { http } = mockBoundary({
			body: described,
			bodies: [{ ...described, output_form: null }, described],
			objects: { [uri]: 'The summary.' },
		});

		const [[item]] = await Pipelex.prototype.execute.call(makeContext({ operation: 'poll', http }));

		expect(item.json.status).toBe('COMPLETED');
		expect(item.json.main_stuff).toEqual({ summary: { text: 'The summary.' } });
	});

	it('fails on Poll & Get Result once the output form never arrives', async () => {
		const uri = storedUri('s');
		const body = { ...results('my.Report', { summary: reference(uri) }), output_form: null };
		const { boundary, http } = mockBoundary({ body });

		const failure = await failureOf(http, undefined, 'poll');

		expect(failure.message).toContain('output_form');
		expect(boundary.resolved).toEqual([]);
	});
});

// ── Bounds ────────────────────────────────────────────────────────────

describe('stored texts — bounded', () => {
	it('refuses texts whose declared sizes together cross the per-item cap, before anything is sent', async () => {
		const uris = ['a', 'b', 'c'].map((hash) => storedUri(hash));
		const { boundary, http } = mockBoundary({
			body: results('native.Text', { items: uris.map((uri) => reference(uri, 'text/plain', STORED_TEXT_MAX_BYTES)) }),
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain(`${STORED_TEXTS_ITEM_MAX_BYTES / (1024 * 1024)} MiB`);
		expect(failure.message).toContain('$.items[2]');
		expect(boundary.resolved).toEqual([]);
		expect(boundary.fetched).toEqual([]);
	});

	it('fails the item once the bytes read together cross the per-item cap, stopping every read', async () => {
		const chunk = Buffer.alloc(1024 * 1024, 0x61);
		const perTextMiB = Math.floor(STORED_TEXTS_ITEM_MAX_BYTES / (1024 * 1024) / 3) + 1;
		const uris = ['a', 'b', 'c'].map((hash) => storedUri(hash));
		// Sends its bytes, then nothing more, never ending on its own.
		const endless = (): Readable => {
			let sent = 0;
			return new Readable({
				objectMode: true,
				read() {
					if (sent < perTextMiB) {
						sent += 1;
						this.push(chunk);
					}
				},
			});
		};
		const { boundary, http } = mockBoundary({
			// Each reference understates its size: only the bytes read tell.
			body: results('native.Text', { items: uris.map((uri) => reference(uri)) }),
			streams: Object.fromEntries(uris.map((uri) => [uri, endless])),
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain(`${STORED_TEXTS_ITEM_MAX_BYTES / (1024 * 1024)} MiB`);
		expect(failure.message).toContain('one item');
		expect(boundary.hungBodies).toHaveLength(3);
		expect(boundary.hungBodies.every((body) => body.destroyed)).toBe(true);
	});

	it('stops the other reads when a text read in full does not decode', async () => {
		const bad = storedUri('bad');
		const slow = storedUri('slow');
		const { boundary, http } = mockBoundary({
			body: results('native.Text', { items: [reference(bad), reference(slow)] }),
			objects: { [bad]: Buffer.from([0xff, 0xfe]) },
			hang: { [slow]: 'request' },
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain('UTF-8');
		expect(failure.message).toContain('$.items[0]');
		const slowRequest = boundary.fetched.find((request) => request.url === signedLink(slow))!;
		expect((slowRequest.abortSignal as AbortSignal).aborted).toBe(true);
	});
});

// ── The bulk resolve ──────────────────────────────────────────────────

describe('stored texts — the bulk resolve', () => {
	it('says the API could not be reached, naming the run, when the bulk resolve fails on the network', async () => {
		const uri = storedUri('t');
		const { http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			resolveError: Object.assign(new Error('socket hang up'), { name: 'AxiosError', code: 'ECONNRESET' }),
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain('could not be reached');
		expect(failure.message).toContain(RUN_ID);
		expect(failure.description).toContain('ECONNRESET');
		expect(`${failure.message} ${failure.description}`).not.toContain('secret-token');
	});

	it('gives the bulk resolve a deadline of its own', async () => {
		const uri = storedUri('t');
		const timer = new AbortController();
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal);
		const { http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			resolveHang: () => setTimeout(() => timer.abort(new DOMException('The operation timed out.', 'TimeoutError')), 0),
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain('did not answer within');
		expect(failure.message).toContain(RUN_ID);
	});

	it('resolves a reference again when its link expires before its read starts', async () => {
		const uri = storedUri('t');
		const { boundary, http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			objects: { [uri]: 'fresh' },
			expiresAt: (_uri, call) => new Date(Date.now() + (call === 0 ? -1000 : 15 * 60_000)).toISOString(),
		});

		const json = await runGetResult(http);

		expect(json.main_stuff).toEqual({ text: 'fresh' });
		expect(boundary.resolved).toEqual([[uri], [uri]]);
		expect(boundary.fetched).toHaveLength(1);
	});
});

// ── data: URLs ────────────────────────────────────────────────────────

describe('stored texts — data: URLs', () => {
	it('refuses a base64 payload a backtracking pattern would stall on, at once', async () => {
		const url = `data:text/plain;base64,A${' '.repeat(200_000)}!`;
		const { http } = mockBoundary({ body: results('native.Text', { url, size: 1, preview: 'A' }) });

		const started = Date.now();
		const failure = await failureOf(http);

		expect(Date.now() - started).toBeLessThan(1000);
		expect(failure.message).toContain('does not decode');
	});

	it('refuses malformed base64 rather than decoding it truncated, and accepts unpadded base64 as atob does', async () => {
		const malformed = mockBoundary({ body: results('native.Text', { url: 'data:text/plain;base64,QUJDa', size: 4 }) });
		expect((await failureOf(malformed.http)).message).toContain('does not decode');

		const unpadded = mockBoundary({ body: results('native.Text', { url: 'data:text/plain;base64,QUI', size: 2 }) });
		expect((await runGetResult(unpadded.http)).main_stuff).toEqual({ text: 'AB' });
	});

	it('refuses a data: URL over the cap without decoding it', async () => {
		const payload = 'A'.repeat(4 * Math.ceil((STORED_TEXT_MAX_BYTES + 3) / 3));
		const from = vi.spyOn(Buffer, 'from');
		const { http } = mockBoundary({ body: results('native.Text', { url: `data:text/plain;base64,${payload}`, size: 1 }) });

		const failure = await failureOf(http);

		expect(failure.message).toContain('MiB');
		expect(from.mock.calls.some((call) => (call as unknown[])[1] === 'base64')).toBe(false);
	});

	it('never writes a data: URL whole into the error', async () => {
		const payload = Buffer.alloc(64 * 1024, 0xff).toString('base64');
		const url = `data:text/plain;base64,${payload}`;
		const { http } = mockBoundary({ body: results('native.Text', { url, size: 64 * 1024 }) });

		const failure = await failureOf(http);

		expect(failure.message).toContain('UTF-8');
		expect(`${failure.message} ${failure.description}`).not.toContain(payload.slice(0, 64));
		expect(failure.description).toContain('data:text/plain;base64,');
		expect(failure.description.length).toBeLessThan(1000);
	});
});

// ── Refusals ──────────────────────────────────────────────────────────

describe('stored texts — a text that cannot be loaded fails the item', () => {
	it('never fetches a stored text under another URL', async () => {
		const { boundary, http } = mockBoundary({
			body: results('native.Text', { url: 'https://attacker.example/x.txt', size: 10, preview: 'x' }),
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain('$');
		expect(failure.message).toContain('neither a pipelex-storage:// reference nor a data: URL');
		expect(failure.message).toContain(RUN_ID);
		expect(boundary.urls.some((url) => url.includes('attacker'))).toBe(false);
		expect(boundary.resolved).toEqual([]);
	});

	it('names the bulk route refusal of one reference', async () => {
		const uri = storedUri('other');
		const { http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			refusals: {
				[uri]: {
					uri,
					url: null,
					expires_at: null,
					content_type: null,
					error: { code: 'pipelex.org.mismatch', detail: 'The reference belongs to another organization.' },
				},
			},
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain('another organization');
		expect(`${failure.message} ${failure.description}`).toContain('pipelex.org.mismatch');
		expect(failure.description).toContain(uri);
	});

	it('says when the Base URL serves no bulk resolve route', async () => {
		const uri = storedUri('t');
		const { http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			resolveStatus: { statusCode: 404, body: { detail: 'Not Found' } },
		});
		const failure = await failureOf(http);
		expect(failure.message).toContain('/v1/resolve-storage-url/bulk');
	});

	it('reports a text storage no longer holds without the signed link', async () => {
		const uri = storedUri('gone');
		const { http } = mockBoundary({ body: results('native.Text', reference(uri)) });

		const failure = await failureOf(http);

		expect(failure.message).toContain('no longer');
		expect(`${failure.message} ${failure.description}`).not.toContain('very-secret-signature');
		expect(`${failure.message} ${failure.description}`).not.toContain(STORE);
	});

	it('refuses a redirect from storage', async () => {
		const uri = storedUri('moved');
		const { http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			storeStatus: { [uri]: { statusCode: 302, body: '' } },
		});
		const failure = await failureOf(http);
		expect(failure.message).toContain('redirect');
	});

	it('refuses a text over the cap before reading it', async () => {
		const uri = storedUri('big');
		const { boundary, http } = mockBoundary({
			body: results('native.Text', reference(uri, 'text/plain', STORED_TEXT_MAX_BYTES + 1)),
		});
		const failure = await failureOf(http);
		expect(failure.message).toContain('MiB');
		expect(boundary.fetched).toEqual([]);
	});

	it('refuses a text whose declared length crosses the cap', async () => {
		const uri = storedUri('big');
		const { http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			objects: { [uri]: 'small' },
			storeHeaders: { [uri]: { 'content-length': String(STORED_TEXT_MAX_BYTES + 1) } },
		});
		const failure = await failureOf(http);
		expect(failure.message).toContain('MiB');
	});

	it('refuses bytes that are not UTF-8', async () => {
		const uri = storedUri('bin');
		const { http } = mockBoundary({
			body: results('native.Text', reference(uri)),
			objects: { [uri]: Buffer.from([0xff, 0xfe, 0x00, 0xc3]) },
		});
		const failure = await failureOf(http);
		expect(failure.message).toContain('UTF-8');
	});

	it('refuses a stored JSON that is not a JSON object', async () => {
		const uri = storedUri('j', 'json');
		const { http } = mockBoundary({
			body: results('native.JSON', reference(uri, 'application/json')),
			objects: { [uri]: '[1, 2, 3]' },
		});
		const failure = await failureOf(http);
		expect(failure.message).toContain('JSON object');
	});

	it('names the place whose kind its bytes do not fit, when one reference sits under two kinds', async () => {
		const uri = storedUri('shared', 'json');
		const output: FormNode = {
			kind: 'object',
			concept_ref: 'my.Pair',
			fields: [
				{ kind: 'prose', name: 'raw', concept_ref: 'native.Text' },
				{ kind: 'unknown', name: 'data', concept_ref: 'native.JSON' },
			],
		};
		const mainStuff = { raw: reference(uri), data: reference(uri) };
		const { http } = mockBoundary({ body: results('my.Pair', mainStuff, output), objects: { [uri]: '[1, 2]' } });

		const failure = await failureOf(http);

		expect(failure.message).toContain('$.data');
		expect(failure.message).toContain('JSON object');
	});

	it('stops the other requests in flight once one read fails', async () => {
		const gone = storedUri('gone');
		const slow = storedUri('slow');
		const { boundary, http } = mockBoundary({
			body: results('native.Text', { items: [reference(gone), reference(slow)] }),
			hang: { [slow]: 'request' },
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain('no longer');
		expect(failure.message).toContain('$.items[0]');
		const slowRequest = boundary.fetched.find((request) => request.url === signedLink(slow))!;
		expect((slowRequest.abortSignal as AbortSignal).aborted).toBe(true);
	});

	it('stops the other bodies being read once one read fails', async () => {
		const gone = storedUri('gone');
		const slow = storedUri('slow');
		const { boundary, http } = mockBoundary({
			body: results('native.Text', { items: [reference(slow), reference(gone)] }),
			hang: { [slow]: 'body' },
		});

		const failure = await failureOf(http);

		expect(failure.message).toContain('no longer');
		expect(failure.message).toContain('$.items[1]');
		expect(boundary.hungBodies).toHaveLength(1);
		expect(boundary.hungBodies[0].destroyed).toBe(true);
	});

	it('stops every read when the execution is cancelled', async () => {
		const slow = storedUri('slow');
		const other = storedUri('other');
		const controller = new AbortController();
		const { http } = mockBoundary({
			body: results('native.Text', { items: [reference(slow), reference(other)] }),
			hang: { [slow]: 'request', [other]: 'body' },
			onHang: () => setTimeout(() => controller.abort(), 0),
		});

		const failure = await failureOf(http, controller.signal);

		expect(failure.message).toContain('cancelled');
	});

	it('lands the failure on the item under Continue On Fail', async () => {
		const uri = storedUri('gone');
		const { http } = mockBoundary({ body: results('native.Text', reference(uri)) });
		const [[item]] = await Pipelex.prototype.execute.call(
			makeContext({ operation: 'getResult', http, continueOnFail: true }),
		);
		expect(String(item.json.error)).toContain('could not be loaded');
	});
});
