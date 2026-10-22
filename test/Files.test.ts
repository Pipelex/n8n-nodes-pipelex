import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
	IBinaryData,
	IExecuteFunctions,
	IN8nHttpFullResponse,
	INodeProperties,
} from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_DOWNLOAD_BINARY_PROPERTY,
	DEFAULT_FILE_LIMIT,
	DOWNLOAD_BY,
	FILE_OPERATION,
	FILE_RESOURCE,
	WHEN_SEVERAL_MATCH,
	fileFields,
	fileOperations,
} from '../nodes/Pipelex/FileDescription';
import {
	FILES_UNAVAILABLE_MESSAGE,
	FALLBACK_BINARY_FILE_NAME,
	binaryFileNameOf,
	bodyBytes,
	fileExtensionOf,
	fileLinkErrorMessage,
	fileListUrl,
	fileNameSearches,
	fileSearchText,
	fileSummaryOf,
	filesRefusalMessage,
	namesMissingResource,
	readFileLink,
	readFileListFilters,
	readFilePage,
	sameFileName,
	storageDownloadRefusalMessage,
	toInstant,
} from '../nodes/Pipelex/FileFunctions';
import { FILE_SUMMARY_FIELDS, type FileSummary } from '../nodes/Pipelex/FilesApiShapes';
import { ROLE_NOT_PERMITTED_MESSAGE } from '../nodes/Pipelex/GenericFunctions';
import { Pipelex } from '../nodes/Pipelex/Pipelex.node';

// The node's files operations against a faked hosted plane: every request goes
// through `helpers.httpRequest`, answered here, and no test reaches a network.

type HttpOptions = {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
	[key: string]: unknown;
};
type HttpImpl = (options: HttpOptions) => IN8nHttpFullResponse | Promise<IN8nHttpFullResponse>;

interface ContextOptions {
	operation: string;
	params?: Record<string, unknown>;
	httpImpl: HttpImpl;
	continueOnFail?: boolean;
	items?: Array<{ json: Record<string, unknown> }>;
	cancelSignal?: AbortSignal;
	timezone?: string;
}

/**
 * n8n's `prepareBinaryData`, faked the way n8n-core behaves: the name is read as
 * a path (its directory split off, cut at a `?`), and the bytes kept as base64.
 */
async function fakePrepareBinaryData(
	bytes: Buffer,
	filePath?: string,
	mimeType?: string,
): Promise<IBinaryData> {
	const binary: IBinaryData = { data: bytes.toString('base64'), mimeType: mimeType ?? 'text/plain' };
	if (filePath) {
		const path = filePath.split('?')[0];
		const slash = path.lastIndexOf('/');
		if (slash >= 0) binary.directory = path.slice(0, slash);
		binary.fileName = path.slice(slash + 1);
		const dot = binary.fileName.lastIndexOf('.');
		if (dot > 0) binary.fileExtension = binary.fileName.slice(dot + 1);
	}
	return binary;
}

function makeContext(opts: ContextOptions): {
	ctx: IExecuteFunctions;
	httpFn: ReturnType<typeof vi.fn>;
	prepareFn: ReturnType<typeof vi.fn>;
} {
	const params: Record<string, unknown> = { resource: FILE_RESOURCE, ...(opts.params ?? {}) };
	const httpFn = vi.fn(async (options: HttpOptions) => opts.httpImpl(options));
	const prepareFn = vi.fn(fakePrepareBinaryData);
	const ctx = {
		getInputData: () => opts.items ?? [{ json: {} }],
		getCredentials: async () => ({ baseUrl: 'https://api.test', apiKey: 'secret-token' }),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => {
			if (name === 'operation') return opts.operation;
			return name in params ? params[name] : fallback;
		},
		getTimezone: () => opts.timezone ?? 'UTC',
		getExecutionId: () => 'exec-1',
		getExecutionCancelSignal: () => opts.cancelSignal,
		continueOnFail: () => opts.continueOnFail ?? false,
		getNode: () => ({ id: 'node-1', name: 'Pipelex', type: 'pipelex', typeVersion: 1 }),
		helpers: {
			httpRequest: httpFn,
			prepareBinaryData: prepareFn,
		},
	} as unknown as IExecuteFunctions;
	return { ctx, httpFn, prepareFn };
}

function fullResponse(
	statusCode: number,
	body: unknown,
	headers: Record<string, unknown> = {},
): IN8nHttpFullResponse {
	return { statusCode, body, headers } as IN8nHttpFullResponse;
}

const EXPECTED_USER_AGENT = `n8n-nodes-pipelex/${
	(JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version: string }).version
}`;

function fileRow(n: number, overrides: Partial<FileSummary> = {}): FileSummary {
	return {
		file_id: `fl_${n}`,
		uri: `pipelex-storage://org_1/assets/${n}.pdf`,
		name: `file-${n}.pdf`,
		media_type: 'application/pdf',
		format: 'pdf',
		size: 1000 + n,
		kind: 'uploaded',
		origin: { surface: 'app', run_id: null, method_id: null, method_version: null },
		created_at: `2026-10-${String(30 - n).padStart(2, '0')}T09:00:00+00:00`,
		created_by: 'user_1',
		...overrides,
	};
}

// A presigned link carries its credential in the query string: it must never
// reach an item, an error message or an error body.
const STORAGE_ORIGIN = 'https://app-bucket.s3.eu-west-3.amazonaws.com';
const SIGNATURE = 'X-Amz-Signature=deadbeefsecret';
const linkFor = (file: FileSummary) => ({
	file_id: file.file_id,
	uri: file.uri,
	name: file.name,
	media_type: file.media_type,
	url: `${STORAGE_ORIGIN}/org_1/assets/${file.file_id}.pdf?X-Amz-Credential=AKIASECRET&${SIGNATURE}`,
	expires_at: '2026-10-23T09:15:00Z',
	error: null,
});

const PDF_BYTES = Buffer.from('%PDF-1.7 a team file');

/**
 * The hosted plane, faked: list pages in order, file records by id, links, and
 * storage. With `searchable`, the list instead searches those rows as the
 * platform does: `q` lowercased, as a substring of the name lowercased and not
 * normalised, the matching rows in one page in the order given (newest first).
 */
function hostedPlane(config: {
	pages?: Array<{ items: FileSummary[]; next_cursor: string | null }>;
	searchable?: FileSummary[];
	records?: Record<string, Record<string, unknown>>;
	link?: (file: FileSummary, options: HttpOptions) => IN8nHttpFullResponse;
	storage?: (options: HttpOptions) => IN8nHttpFullResponse | Promise<IN8nHttpFullResponse>;
}): HttpImpl {
	const pages = config.pages ?? [];
	const known = new Map<string, FileSummary>();
	for (const page of pages) for (const row of page.items) known.set(row.file_id, row);
	for (const row of config.searchable ?? []) known.set(row.file_id, row);
	for (const [fileId, record] of Object.entries(config.records ?? {})) {
		known.set(fileId, record as unknown as FileSummary);
	}
	return (options) => {
		const url = String(options.url);
		if (url.startsWith('https://api.test/v1/files?') && config.searchable) {
			const needle = (new URL(url).searchParams.get('q') ?? '').trim().toLowerCase();
			const items = config.searchable.filter((row) => row.name.toLowerCase().includes(needle));
			return fullResponse(200, { items, next_cursor: null });
		}
		if (url.startsWith('https://api.test/v1/files?')) {
			const cursor = new URL(url).searchParams.get('cursor');
			const index = cursor === null ? 0 : Number(cursor.replace('cursor-', ''));
			return fullResponse(200, pages[index] ?? { items: [], next_cursor: null });
		}
		if (url === 'https://api.test/v1/files/links') {
			const fileId = (options.body as { files: Array<{ file_id: string }> }).files[0].file_id;
			const file = known.get(fileId) as FileSummary;
			if (config.link) return config.link(file, options);
			return fullResponse(200, { items: [linkFor(file)] });
		}
		const record = /^https:\/\/api\.test\/v1\/files\/([^/?]+)\?uses_limit=1$/.exec(url);
		if (record) {
			const found = config.records?.[decodeURIComponent(record[1])];
			if (found) return fullResponse(200, found);
			return fullResponse(404, {
				type: 'about:blank',
				title: 'Not found',
				status: 404,
				detail: `File ${record[1]} not found`,
				code: 'not_found',
				error_domain: 'input',
				retryable: false,
			});
		}
		if (url.startsWith(STORAGE_ORIGIN)) {
			if (config.storage) return config.storage(options);
			return fullResponse(200, PDF_BYTES);
		}
		throw new Error(`unexpected request ${options.method ?? 'GET'} ${url}`);
	};
}

/** The URLs of the list requests a test made, as parsed query parameters. */
function listQueries(httpFn: ReturnType<typeof vi.fn>): URLSearchParams[] {
	return httpFn.mock.calls
		.map((call) => String((call[0] as HttpOptions).url))
		.filter((url) => url.startsWith('https://api.test/v1/files?'))
		.map((url) => new URL(url).searchParams);
}

afterEach(() => vi.restoreAllMocks());

// ── The editor surface ──────────────────────────────────────────────────────

describe('File resource — the editor surface', () => {
	const properties = new Pipelex().description.properties;
	const byName = (name: string) => properties.filter((p: INodeProperties) => p.name === name);

	it('offers a Resource selector, Run first and by default, then File', () => {
		const [resource] = byName('resource');
		expect(resource.type).toBe('options');
		expect(resource.noDataExpression).toBe(true);
		expect(resource.default).toBe('run');
		expect((resource.options ?? []).map((option) => (option as { value: string }).value)).toEqual([
			'run',
			FILE_RESOURCE,
		]);
		expect(properties[0].name).toBe('resource');
	});

	it('gives the File resource its own Operation selector: Download by default, and Get Many', () => {
		const fileOperation = byName('operation').find((p) =>
			(p.displayOptions?.show?.resource ?? []).includes(FILE_RESOURCE),
		);
		expect(fileOperation?.default).toBe(FILE_OPERATION.download);
		expect(fileOperation?.noDataExpression).toBe(true);
		const options = (fileOperation?.options ?? []) as Array<{ name: string; value: string; action: string }>;
		expect(options.map((option) => [option.value, option.name, option.action])).toEqual([
			['download', 'Download', 'Download a file'],
			['getAll', 'Get Many', 'Get many files'],
		]);
	});

	it('never reuses a Run operation value, so a field shown on an operation belongs to one resource', () => {
		const operations = byName('operation');
		const valuesOf = (resource: string) =>
			operations
				.filter((p) => (p.displayOptions?.show?.resource ?? []).includes(resource))
				.flatMap((p) => (p.options ?? []).map((option) => (option as { value: string }).value));
		const runValues = [...valuesOf('run'), 'execute'];
		for (const value of valuesOf(FILE_RESOURCE)) expect(runValues).not.toContain(value);
	});

	it('shows every File field on the File resource and one of its operations alone', () => {
		for (const field of fileFields) {
			expect(field.displayOptions?.show?.resource, field.name).toEqual([FILE_RESOURCE]);
			const operations = field.displayOptions?.show?.operation as string[];
			expect(operations.length, field.name).toBe(1);
			expect(Object.values(FILE_OPERATION), field.name).toContain(operations[0]);
		}
	});

	it('shows none of the Run fields on a File operation', () => {
		const fileNames = new Set([...fileFields, ...fileOperations].map((p) => p.name));
		for (const property of properties) {
			if (fileNames.has(property.name) || property.name === 'resource') continue;
			const operations = (property.displayOptions?.show?.operation ?? []) as string[];
			expect(operations, property.name).not.toContain(FILE_OPERATION.download);
			expect(operations, property.name).not.toContain(FILE_OPERATION.getAll);
		}
	});

	it('spells each default as the literal the code reads', () => {
		const field = (name: string) => fileFields.find((p) => p.name === name);
		expect(fileOperations[0].default).toBe(FILE_OPERATION.download);
		expect(field('downloadBy')?.default).toBe(DOWNLOAD_BY.name);
		expect(field('whenSeveralMatch')?.default).toBe(WHEN_SEVERAL_MATCH.newest);
		expect(field('binaryPropertyName')?.default).toBe(DEFAULT_DOWNLOAD_BINARY_PROPERTY);
		expect(field('limit')?.default).toBe(DEFAULT_FILE_LIMIT);
	});

	it('shows File Name and the several-matches choice when finding by name, File ID when finding by ID', () => {
		const field = (name: string) => fileFields.find((p) => p.name === name);
		expect(field('fileName')?.displayOptions?.show?.downloadBy).toEqual([DOWNLOAD_BY.name]);
		expect(field('whenSeveralMatch')?.displayOptions?.show?.downloadBy).toEqual([DOWNLOAD_BY.name]);
		expect(field('fileId')?.displayOptions?.show?.downloadBy).toEqual([DOWNLOAD_BY.id]);
		expect(field('limit')?.displayOptions?.show?.returnAll).toEqual([false]);
	});

	it('names each File operation in the node subtitle', () => {
		const subtitle = new Pipelex().description.subtitle ?? '';
		expect(subtitle).toContain('download: "Download File"');
		expect(subtitle).toContain('getAll: "Get Many Files"');
	});
});

// ── The wire contract ───────────────────────────────────────────────────────

describe('File resource — the wire contract', () => {
	it('keeps a list row to the fields the platform pins, in its order', () => {
		expect([...FILE_SUMMARY_FIELDS]).toEqual([
			'file_id',
			'uri',
			'name',
			'media_type',
			'format',
			'size',
			'kind',
			'origin',
			'created_at',
			'created_by',
		]);
	});

	it('sends every filter under its wire name, repeating format and media_type, and always the largest page', () => {
		const url = fileListUrl(
			'https://api.test',
			{
				q: 'march invoice',
				method_id: 'mt_1',
				run_id: 'run-1',
				created_by: 'me',
				kind: 'generated',
				format: ['pdf', 'image'],
				media_type: ['image/png', 'image/jpeg'],
				created_from: '2026-10-01T00:00:00.000Z',
				created_to: '2026-10-31T23:59:59.000Z',
			},
			200,
			'cursor-1',
		);
		expect(url.startsWith('https://api.test/v1/files?')).toBe(true);
		expect([...new URL(url).searchParams.entries()]).toEqual([
			['q', 'march invoice'],
			['method_id', 'mt_1'],
			['run_id', 'run-1'],
			['created_by', 'me'],
			['kind', 'generated'],
			['format', 'pdf'],
			['format', 'image'],
			['media_type', 'image/png'],
			['media_type', 'image/jpeg'],
			['created_from', '2026-10-01T00:00:00.000Z'],
			['created_to', '2026-10-31T23:59:59.000Z'],
			['limit', '200'],
			['cursor', 'cursor-1'],
		]);
	});

	it('sends only the page size for an unfiltered first page', () => {
		expect(fileListUrl('https://api.test', {}, 200)).toBe('https://api.test/v1/files?limit=200');
	});

	it('asks the links route for one file by its file_id, and reads a record with one use', async () => {
		const record = { ...fileRow(1), sha256: 'ab'.repeat(32), uses: { items: [], next_cursor: null } };
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { downloadBy: 'id', fileId: 'fl_1' },
			httpImpl: hostedPlane({ records: { fl_1: record } }),
		});

		await Pipelex.prototype.execute.call(ctx);

		const [recordCall, linksCall] = httpFn.mock.calls.map((call) => call[0] as HttpOptions);
		expect(recordCall.method).toBe('GET');
		expect(recordCall.url).toBe('https://api.test/v1/files/fl_1?uses_limit=1');
		expect(linksCall.method).toBe('POST');
		expect(linksCall.url).toBe('https://api.test/v1/files/links');
		expect(linksCall.body).toEqual({ files: [{ file_id: 'fl_1' }] });
		// The route keeps no copy of a link, so a key would only make a retry a 409.
		expect(linksCall.headers?.['Idempotency-Key']).toBeUndefined();
	});
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('toInstant — a date filter as an instant with an offset', () => {
	it('reads a picker value with no offset in the workflow time zone', () => {
		expect(toInstant('2026-10-01T00:00:00', 'Europe/Paris', 'Created From')).toEqual({
			instant: '2026-09-30T22:00:00.000Z',
		});
		expect(toInstant('2026-01-15T09:30', 'Europe/Paris', 'Created From')).toEqual({
			instant: '2026-01-15T08:30:00.000Z',
		});
		expect(toInstant('2026-07-04', 'America/New_York', 'Created From')).toEqual({
			instant: '2026-07-04T04:00:00.000Z',
		});
		expect(toInstant('2026-10-01T00:00:00', 'UTC', 'Created From')).toEqual({
			instant: '2026-10-01T00:00:00.000Z',
		});
	});

	it('lands on the offset in force on either side of a daylight-saving change', () => {
		// Paris leaves summer time at 03:00 on 2026-10-25.
		expect(toInstant('2026-10-24T12:00:00', 'Europe/Paris', 'Created From').instant).toBe(
			'2026-10-24T10:00:00.000Z',
		);
		expect(toInstant('2026-10-26T12:00:00', 'Europe/Paris', 'Created From').instant).toBe(
			'2026-10-26T11:00:00.000Z',
		);
	});

	it('takes a value with an offset or Z as the instant it says', () => {
		expect(toInstant('2026-10-01T00:00:00+02:00', 'America/New_York', 'Created From').instant).toBe(
			'2026-09-30T22:00:00.000Z',
		);
		expect(toInstant('2026-10-01T08:00:00.250Z', 'Europe/Paris', 'Created From').instant).toBe(
			'2026-10-01T08:00:00.250Z',
		);
	});

	it('takes a luxon DateTime or a Date an expression resolved to', () => {
		const luxonLike = { toISO: () => '2026-10-01T00:00:00.000+09:00' };
		expect(toInstant(luxonLike, 'UTC', 'Created From').instant).toBe('2026-09-30T15:00:00.000Z');
		expect(toInstant(new Date('2026-10-01T00:00:00Z'), 'UTC', 'Created From').instant).toBe(
			'2026-10-01T00:00:00.000Z',
		);
	});

	it('reads a date with no time as midnight, or as the last millisecond of the day for an upper bound', () => {
		expect(toInstant('2026-10-01', 'Europe/Paris', 'Created From').instant).toBe('2026-09-30T22:00:00.000Z');
		expect(toInstant('2026-10-01', 'Europe/Paris', 'Created To', { endOfDay: true }).instant).toBe(
			'2026-10-01T21:59:59.999Z',
		);
		// The day Paris leaves summer time lasts 25 hours, and ends where the next one starts.
		expect(toInstant('2026-10-25', 'Europe/Paris', 'Created To', { endOfDay: true }).instant).toBe(
			'2026-10-25T22:59:59.999Z',
		);
		expect(toInstant('2026-12-31', 'UTC', 'Created To', { endOfDay: true }).instant).toBe(
			'2026-12-31T23:59:59.999Z',
		);
		// A time, even midnight, is the instant it says.
		expect(toInstant('2026-10-01T00:00:00', 'UTC', 'Created To', { endOfDay: true }).instant).toBe(
			'2026-10-01T00:00:00.000Z',
		);
		expect(toInstant('2026-02-30', 'UTC', 'Created To', { endOfDay: true }).error).toMatch(/^"Created To"/);
	});

	it('leaves an empty value out', () => {
		expect(toInstant('', 'UTC', 'Created From')).toEqual({});
		expect(toInstant('   ', 'UTC', 'Created From')).toEqual({});
		expect(toInstant(undefined, 'UTC', 'Created From')).toEqual({});
	});

	it('refuses what is not a date and time, naming the field', () => {
		expect(toInstant('yesterday', 'UTC', 'Created From').error).toMatch(/^"Created From" must be a date and time/);
		expect(toInstant('2026-02-30', 'UTC', 'Created To').error).toMatch(/^"Created To"/);
		expect(toInstant(42, 'UTC', 'Created To').error).toMatch(/^"Created To"/);
	});

	it('reads an unknown time zone as UTC rather than failing', () => {
		expect(toInstant('2026-10-01T00:00:00', 'Not/AZone', 'Created From').instant).toBe(
			'2026-10-01T00:00:00.000Z',
		);
	});
});

describe('readFileListFilters — the Filters collection as the list query', () => {
	it('maps every filter to its wire name, trimmed, the lists split on commas and deduplicated', () => {
		const { query, error } = readFileListFilters(
			{
				q: '  invoice ',
				methodId: ' mt_1 ',
				runId: 'run-1',
				createdBy: 'me',
				kind: 'test',
				formats: 'pdf, image, ,pdf',
				mediaTypes: 'image/png,image/jpeg',
				createdFrom: '2026-10-01T00:00:00',
				createdTo: '2026-10-31T00:00:00Z',
			},
			'Europe/Paris',
		);
		expect(error).toBeUndefined();
		expect(query).toEqual({
			q: 'invoice',
			method_id: 'mt_1',
			run_id: 'run-1',
			created_by: 'me',
			kind: 'test',
			format: ['pdf', 'image'],
			media_type: ['image/png', 'image/jpeg'],
			created_from: '2026-09-30T22:00:00.000Z',
			created_to: '2026-10-31T00:00:00.000Z',
		});
	});

	it('takes in the whole of a Created To day given without a time, and starts Created From at its midnight', () => {
		expect(readFileListFilters({ createdFrom: '2026-10-01', createdTo: '2026-10-01' }, 'UTC').query).toEqual({
			created_from: '2026-10-01T00:00:00.000Z',
			created_to: '2026-10-01T23:59:59.999Z',
		});
	});

	it('leaves out a filter added and left blank', () => {
		expect(readFileListFilters({ q: '', methodId: '  ', formats: ' , ', createdFrom: '' }, 'UTC')).toEqual({
			query: {},
		});
		expect(readFileListFilters(undefined, 'UTC')).toEqual({ query: {} });
	});

	it('refuses an unknown kind and a date it cannot read', () => {
		expect(readFileListFilters({ kind: 'secret' }, 'UTC').error).toMatch(/^"Kind" must be one of uploaded, generated, test/);
		expect(readFileListFilters({ createdTo: 'soon' }, 'UTC').error).toMatch(/^"Created To"/);
	});
});

describe('the name a file is found by', () => {
	it('compares names ignoring case and Unicode composition, the given name trimmed', () => {
		expect(sameFileName('March Invoice.PDF', '  march invoice.pdf ')).toBe(true);
		expect(sameFileName('Café.pdf', 'Café.pdf')).toBe(true);
		expect(sameFileName('old march invoice.pdf', 'march invoice.pdf')).toBe(false);
		expect(sameFileName('march invoice.pdf.pdf', 'march invoice.pdf')).toBe(false);
	});

	it('searches the name as typed and in each Unicode composition, each once', () => {
		const composed = 'R\u00e9sum\u00e9.pdf';
		const decomposed = 'Re\u0301sume\u0301.pdf';
		expect(fileNameSearches(` ${composed} `)).toEqual([composed, decomposed]);
		expect(fileNameSearches(decomposed)).toEqual([decomposed, composed]);
		// Typed half one way, half the other: the name as typed is searched too.
		const mixed = 'R\u00e9sume\u0301.pdf';
		expect(fileNameSearches(mixed)).toEqual([mixed, composed, decomposed]);
		expect(fileNameSearches('March invoice.pdf')).toEqual(['March invoice.pdf']);
	});

	it('searches by the name, or by its first characters past the search bound, counted in code points', () => {
		expect(fileSearchText('  March invoice.pdf ')).toBe('March invoice.pdf');
		const long = `${'🧾'.repeat(150)}${'a'.repeat(100)}.pdf`;
		const search = fileSearchText(long);
		expect(Array.from(search)).toHaveLength(200);
		expect(long.startsWith(search)).toBe(true);
	});
});

describe('reading the files routes', () => {
	it('reads a page, an empty or absent cursor ending the list', () => {
		expect(readFilePage({ items: [fileRow(1)], next_cursor: 'c' })).toEqual({ items: [fileRow(1)], next_cursor: 'c' });
		expect(readFilePage({ items: [], next_cursor: '' })).toEqual({ items: [], next_cursor: null });
		expect(readFilePage({ items: [] })).toEqual({ items: [], next_cursor: null });
		expect(readFilePage({ items: [{ name: 'no id' }], next_cursor: null })).toBeUndefined();
		expect(readFilePage({ items: 'nope' })).toBeUndefined();
		expect(readFilePage(null)).toBeUndefined();
	});

	it('keeps a record to its list row, dropping what only a record carries', () => {
		const record = {
			...fileRow(1),
			original_name: 'scan.pdf',
			sha256: 'ab'.repeat(32),
			state: 'stored',
			method_ids: ['mt_1'],
			uses: { items: [], next_cursor: null },
		};
		const summary = fileSummaryOf(record);
		expect(summary).toEqual(fileRow(1));
		expect(Object.keys(summary ?? {})).toEqual([...FILE_SUMMARY_FIELDS]);
		expect(fileSummaryOf({ name: 'no id' })).toBeUndefined();
	});

	it('tells a 404 naming a resource from a Base URL without the routes', () => {
		expect(namesMissingResource({ code: 'not_found', error_domain: 'input' })).toBe(true);
		expect(namesMissingResource({ code: 'run_not_found', error_domain: 'input' })).toBe(true);
		expect(namesMissingResource({ code: 'not_found', error_domain: 'config' })).toBe(false);
		expect(namesMissingResource({ message: 'Not Found' })).toBe(false);
	});

	it('says what each refusal of a files route means', () => {
		const action = "list your organization's files";
		expect(filesRefusalMessage(401, { detail: 'Invalid token' }, action)).toBe(
			"Pipelex did not accept the credential's Bearer Token when asked to list your organization's files (HTTP 401). Check the token in the Pipelex credential. (Server: Invalid token)",
		);
		expect(
			filesRefusalMessage(403, { code: 'role_not_permitted', detail: 'Your role, runner, reads only.' }, action),
		).toBe(`Pipelex refused to list your organization's files. ${ROLE_NOT_PERMITTED_MESSAGE} Your role, runner, reads only.`);
		expect(filesRefusalMessage(403, {}, action)).toMatch(/not allowed to read your organization's files/);
		expect(filesRefusalMessage(404, { code: 'not_found', error_domain: 'config' }, action)).toBe(
			FILES_UNAVAILABLE_MESSAGE,
		);
		expect(filesRefusalMessage(404, {}, action)).toBe(FILES_UNAVAILABLE_MESSAGE);
		expect(
			filesRefusalMessage(404, { code: 'run_not_found', error_domain: 'input', detail: 'Run run-9 not found' }, action),
		).toBe("Pipelex could not list your organization's files (HTTP 404). (Server: Run run-9 not found)");
		expect(
			filesRefusalMessage(400, { detail: 'created_from is after created_to: the date range holds no file.' }, action),
		).toMatch(/\(HTTP 400\)\. \(Server: created_from is after created_to/);
		expect(filesRefusalMessage(503, {}, action)).toMatch(/\(HTTP 503\)\. Retry the item\.$/);
	});

	it('reads a link, a refusal, and nothing else', () => {
		const file = fileRow(1);
		expect(readFileLink({ items: [linkFor(file)] })).toEqual({
			link: { url: linkFor(file).url, name: file.name, mediaType: file.media_type },
		});
		expect(
			readFileLink({ items: [{ ...linkFor(file), url: null, error: { code: 'conflict', detail: 'Not stored yet' } }] }),
		).toEqual({ error: { code: 'conflict', detail: 'Not stored yet' } });
		// A URL with user info, a relative one, or an answer that is not one item is no link.
		expect(readFileLink({ items: [{ ...linkFor(file), url: 'https://user:pw@bucket.test/x' }] })).toBeUndefined();
		expect(readFileLink({ items: [{ ...linkFor(file), url: '/relative' }] })).toBeUndefined();
		expect(readFileLink({ items: [] })).toBeUndefined();
		expect(readFileLink({ items: [linkFor(file), linkFor(fileRow(2))] })).toBeUndefined();
	});

	it('says why a file got no link', () => {
		expect(fileLinkErrorMessage({ code: 'not_found', detail: '' }, 'a.pdf')).toMatch(/no longer holds the file "a\.pdf"/);
		expect(fileLinkErrorMessage({ code: 'conflict', detail: '' }, 'a.pdf')).toMatch(/has not finished.*Retry the item/);
		expect(fileLinkErrorMessage({ code: 'forbidden', detail: 'Another organization' }, 'a.pdf')).toBe(
			'Pipelex refused a download link for the file "a.pdf" (forbidden). (Server: Another organization)',
		);
	});

	it('says why storage refused the download, without the link', () => {
		expect(
			storageDownloadRefusalMessage(403, { code: 'AccessDenied', message: 'Request has expired' }, 'a.pdf'),
		).toMatch(/link expired before the download started\. Retry the item/);
		expect(storageDownloadRefusalMessage(404, { code: 'NoSuchKey' }, 'a.pdf')).toMatch(/no longer holds the file's bytes/);
		expect(storageDownloadRefusalMessage(403, { code: 'SignatureDoesNotMatch' }, 'a.pdf')).toMatch(/differs from what the download link signed/);
		expect(storageDownloadRefusalMessage(503, { code: 'SlowDown', message: 'Reduce your rate.' }, 'a.pdf')).toBe(
			'Storage failed to send "a.pdf" (503 SlowDown): Reduce your rate. Retry the item.',
		);
		expect(storageDownloadRefusalMessage(307, {}, 'a.pdf')).toMatch(/redirect was refused/);
	});

	it('reads a response body as bytes whichever form n8n hands it in', () => {
		const bytes = Buffer.from('abc');
		expect(bodyBytes(bytes)).toBe(bytes);
		expect(bodyBytes(new Uint8Array([97, 98, 99]).buffer).toString()).toBe('abc');
		expect(bodyBytes(new Uint8Array([97, 98, 99])).toString()).toBe('abc');
		expect(bodyBytes('abc').toString()).toBe('abc');
		expect(bodyBytes(undefined)).toHaveLength(0);
	});
});

// ── Get Many ────────────────────────────────────────────────────────────────

describe('File resource — Get Many', () => {
	it('lists the files as one item each, with the API headers, up to the default limit', async () => {
		const rows = [fileRow(1), fileRow(2), fileRow(3)];
		const { ctx, httpFn } = makeContext({
			operation: 'getAll',
			httpImpl: hostedPlane({ pages: [{ items: rows, next_cursor: null }] }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items.map((item) => item.json)).toEqual(rows);
		expect(items.every((item) => (item.pairedItem as { item: number }).item === 0)).toBe(true);
		const [call] = httpFn.mock.calls.map((entry) => entry[0] as HttpOptions);
		expect(call.method).toBe('GET');
		expect(call.url).toBe('https://api.test/v1/files?limit=200');
		expect(call.headers?.Authorization).toBe('Bearer secret-token');
		expect(call.headers?.['User-Agent']).toBe(EXPECTED_USER_AGENT);
	});

	it('pages on past a short or empty filtered page until the limit, sending each cursor back', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getAll',
			params: { limit: 3, filters: { kind: 'generated' } },
			httpImpl: hostedPlane({
				pages: [
					{ items: [fileRow(1), fileRow(2)], next_cursor: 'cursor-1' },
					{ items: [], next_cursor: 'cursor-2' },
					{ items: [fileRow(3), fileRow(4)], next_cursor: 'cursor-3' },
					{ items: [fileRow(5)], next_cursor: null },
				],
			}),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items.map((item) => item.json.file_id)).toEqual(['fl_1', 'fl_2', 'fl_3']);
		const queries = listQueries(httpFn);
		expect(queries.map((query) => query.get('cursor'))).toEqual([null, 'cursor-1', 'cursor-2']);
		expect(queries.every((query) => query.get('kind') === 'generated')).toBe(true);
	});

	it('walks the whole list with Return All, and only a null cursor ends it', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getAll',
			params: { returnAll: true, limit: 1 },
			httpImpl: hostedPlane({
				pages: [
					{ items: [fileRow(1)], next_cursor: 'cursor-1' },
					{ items: [], next_cursor: 'cursor-2' },
					{ items: [fileRow(2)], next_cursor: null },
				],
			}),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items.map((item) => item.json.file_id)).toEqual(['fl_1', 'fl_2']);
		expect(listQueries(httpFn)).toHaveLength(3);
	});

	it("returns a list longer than the engine's limit on a call's arguments", async () => {
		const many = Array.from({ length: 150_000 }, (_, n) => fileRow(n));
		const { ctx } = makeContext({
			operation: 'getAll',
			params: { returnAll: true },
			httpImpl: () => fullResponse(200, { items: many, next_cursor: null }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items).toHaveLength(many.length);
		expect(items[items.length - 1].json.file_id).toBe(`fl_${many.length - 1}`);
	});

	it('answers no item for an empty list', async () => {
		const { ctx } = makeContext({ operation: 'getAll', httpImpl: hostedPlane({ pages: [] }) });
		const [items] = await Pipelex.prototype.execute.call(ctx);
		expect(items).toEqual([]);
	});

	it('sends the filters, a picked date read in the workflow time zone', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getAll',
			timezone: 'Europe/Paris',
			params: { filters: { createdBy: 'me', formats: 'pdf,docx', createdFrom: '2026-10-01T00:00:00' } },
			httpImpl: hostedPlane({ pages: [] }),
		});

		await Pipelex.prototype.execute.call(ctx);

		const [query] = listQueries(httpFn);
		expect(query.get('created_by')).toBe('me');
		expect(query.getAll('format')).toEqual(['pdf', 'docx']);
		expect(query.get('created_from')).toBe('2026-09-30T22:00:00.000Z');
	});

	it('refuses a bad limit or filter before any request', async () => {
		for (const params of [{ limit: 0 }, { limit: 2.5 }, { filters: { createdTo: 'soon' } }]) {
			const { ctx, httpFn } = makeContext({ operation: 'getAll', params, httpImpl: hostedPlane({}) });
			await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/Limit|Created To/);
			expect(httpFn).not.toHaveBeenCalled();
		}
	});

	it('refuses a server that answers the cursor it was sent, rather than looping', async () => {
		const { ctx } = makeContext({
			operation: 'getAll',
			params: { returnAll: true },
			httpImpl: (options) =>
				fullResponse(200, {
					items: [],
					next_cursor: new URL(String(options.url)).searchParams.get('cursor') ?? 'cursor-1',
				}),
		});
		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/same page of files twice/);
	});

	it('says when the Base URL serves no files routes, and continues on fail with the reason', async () => {
		const { ctx } = makeContext({
			operation: 'getAll',
			continueOnFail: true,
			httpImpl: () =>
				fullResponse(404, { title: 'Not found', detail: 'Not Found', code: 'not_found', error_domain: 'config' }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items).toEqual([{ json: { error: FILES_UNAVAILABLE_MESSAGE }, pairedItem: { item: 0 } }]);
	});

	it('stops when the execution is cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		const { ctx, httpFn } = makeContext({
			operation: 'getAll',
			cancelSignal: controller.signal,
			httpImpl: hostedPlane({ pages: [] }),
		});
		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/cancelled/);
		expect(httpFn).not.toHaveBeenCalled();
	});

	it('runs once per input item', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'getAll',
			items: [{ json: {} }, { json: {} }],
			httpImpl: hostedPlane({ pages: [{ items: [fileRow(1)], next_cursor: null }] }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items.map((item) => (item.pairedItem as { item: number }).item)).toEqual([0, 1]);
		expect(httpFn).toHaveBeenCalledTimes(2);
	});
});

// ── Download ────────────────────────────────────────────────────────────────

describe('File resource — Download by name', () => {
	it('lists with the name as the search, links the newest match and puts its bytes in the binary field', async () => {
		const newest = fileRow(1, { name: 'March invoice.pdf' });
		const older = fileRow(2, { name: 'march invoice.pdf' });
		const { ctx, httpFn, prepareFn } = makeContext({
			operation: 'download',
			params: { fileName: ' March invoice.pdf ' },
			httpImpl: hostedPlane({
				pages: [{ items: [fileRow(3, { name: 'Old March invoice.pdf' }), newest, older], next_cursor: null }],
			}),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items).toHaveLength(1);
		expect(items[0].json).toEqual(newest);
		expect(items[0].pairedItem).toEqual({ item: 0 });
		const binary = items[0].binary?.data as IBinaryData;
		expect(Buffer.from(binary.data, 'base64').equals(PDF_BYTES)).toBe(true);
		expect(binary.fileName).toBe('March invoice.pdf');
		expect(binary.mimeType).toBe('application/pdf');
		expect(prepareFn).toHaveBeenCalledWith(PDF_BYTES, 'March invoice.pdf', 'application/pdf');

		const calls = httpFn.mock.calls.map((call) => call[0] as HttpOptions);
		expect(new URL(calls[0].url).searchParams.get('q')).toBe('March invoice.pdf');
		expect(calls[1].body).toEqual({ files: [{ file_id: newest.file_id }] });
		// The newest match is the first: nothing more is listed once it is found.
		expect(listQueries(httpFn)).toHaveLength(1);
	});

	it('reads storage with the link alone: no credential, no User-Agent, no redirect, the bytes as a buffer', async () => {
		const file = fileRow(1, { name: 'a.pdf' });
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { fileName: 'a.pdf' },
			httpImpl: hostedPlane({ pages: [{ items: [file], next_cursor: null }] }),
		});

		await Pipelex.prototype.execute.call(ctx);

		const storageCall = httpFn.mock.calls
			.map((call) => call[0] as HttpOptions)
			.find((options) => String(options.url).startsWith(STORAGE_ORIGIN));
		expect(storageCall?.method).toBe('GET');
		expect(storageCall?.url).toBe(linkFor(file).url);
		expect(storageCall?.headers).toBeUndefined();
		expect(storageCall?.encoding).toBe('arraybuffer');
		expect(storageCall?.disableFollowRedirect).toBe(true);
		expect(storageCall?.abortSignal).toBeInstanceOf(AbortSignal);
	});

	it('finds a match past an empty filtered page that still carries a cursor', async () => {
		const file = fileRow(4, { name: 'report.docx' });
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { fileName: 'report.docx', binaryPropertyName: 'report' },
			httpImpl: hostedPlane({
				pages: [
					{ items: [fileRow(1, { name: 'report.docx.pdf' })], next_cursor: 'cursor-1' },
					{ items: [], next_cursor: 'cursor-2' },
					{ items: [file], next_cursor: 'cursor-3' },
				],
			}),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items[0].json.file_id).toBe('fl_4');
		expect(Object.keys(items[0].binary ?? {})).toEqual(['report']);
		expect(listQueries(httpFn)).toHaveLength(3);
	});

	it('finds a name stored decomposed, as a Mac uploads it, from the composed name typed in n8n', async () => {
		const stored = fileRow(1, { name: 'Re\u0301sume\u0301.pdf' });
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { fileName: 'R\u00e9sum\u00e9.pdf' },
			httpImpl: hostedPlane({ searchable: [fileRow(2, { name: 'Other.pdf' }), stored] }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items[0].json).toEqual(stored);
		expect(listQueries(httpFn).map((query) => query.get('q'))).toEqual([
			'R\u00e9sum\u00e9.pdf',
			'Re\u0301sume\u0301.pdf',
		]);
	});

	it('finds a name stored composed from a decomposed name', async () => {
		const stored = fileRow(1, { name: 'R\u00e9sum\u00e9.pdf' });
		const { ctx } = makeContext({
			operation: 'download',
			params: { fileName: 'Re\u0301sume\u0301.pdf' },
			httpImpl: hostedPlane({ searchable: [stored] }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items[0].json).toEqual(stored);
	});

	it('with Use the Newest, downloads the newer of two files whose names differ only in composition', async () => {
		const newerDecomposed = fileRow(1, { name: 'Caf\u0065\u0301.pdf' });
		const olderComposed = fileRow(5, { name: 'Caf\u00e9.pdf' });
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { fileName: 'Caf\u00e9.pdf' },
			httpImpl: hostedPlane({ searchable: [newerDecomposed, olderComposed] }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items[0].json.file_id).toBe(newerDecomposed.file_id);
		const linksCall = httpFn.mock.calls
			.map((call) => call[0] as HttpOptions)
			.find((options) => options.url === 'https://api.test/v1/files/links');
		expect(linksCall?.body).toEqual({ files: [{ file_id: newerDecomposed.file_id }] });
	});

	it('with Fail, fails on two files whose names differ only in composition, naming the newer first', async () => {
		const { ctx } = makeContext({
			operation: 'download',
			params: { fileName: 'Caf\u00e9.pdf', whenSeveralMatch: 'fail' },
			httpImpl: hostedPlane({
				searchable: [fileRow(1, { name: 'Caf\u0065\u0301.pdf' }), fileRow(5, { name: 'CAF\u00c9.pdf' })],
			}),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/such as fl_1 \(created .*\) and fl_5 \(created .*\)/);
	});

	it('with Fail, counts a file listed by more than one search once', async () => {
		// This list answers the same row to the composed and the decomposed search.
		const file = fileRow(1, { name: 'Caf\u00e9.pdf' });
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { fileName: 'caf\u00e9.pdf', whenSeveralMatch: 'fail' },
			httpImpl: hostedPlane({ pages: [{ items: [file], next_cursor: null }] }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items[0].json.file_id).toBe('fl_1');
		expect(listQueries(httpFn)).toHaveLength(2);
	});

	it('with Fail, fails on a second file of the same name, naming both', async () => {
		const { ctx } = makeContext({
			operation: 'download',
			params: { fileName: 'scan.png', whenSeveralMatch: 'fail' },
			httpImpl: hostedPlane({
				pages: [
					{ items: [fileRow(1, { name: 'scan.png' })], next_cursor: 'cursor-1' },
					{ items: [fileRow(2, { name: 'SCAN.png' })], next_cursor: null },
				],
			}),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			/Several of your organization's files are named "scan\.png", such as fl_1 \(created .*\) and fl_2 \(created .*\)\. Download one by its ID/,
		);
	});

	it('with Fail, downloads the one file of the name once the whole list is read', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { fileName: 'scan.png', whenSeveralMatch: 'fail' },
			httpImpl: hostedPlane({
				pages: [
					{ items: [fileRow(1, { name: 'scan.png' })], next_cursor: 'cursor-1' },
					{ items: [fileRow(2, { name: 'other scan.png' })], next_cursor: null },
				],
			}),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(items[0].json.file_id).toBe('fl_1');
		expect(listQueries(httpFn)).toHaveLength(2);
	});

	it('fails when no file carries the name, once the whole list is read', async () => {
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { fileName: 'missing.pdf' },
			httpImpl: hostedPlane({
				pages: [
					{ items: [fileRow(1, { name: 'not missing.pdf' })], next_cursor: 'cursor-1' },
					{ items: [], next_cursor: null },
				],
			}),
		});

		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			/hold no file named "missing\.pdf"\. Names are compared ignoring case/,
		);
		expect(listQueries(httpFn)).toHaveLength(2);
	});

	it('names the binary safely when the Pipelex name climbs out of a folder, keeping the whole name in the JSON', async () => {
		const traversal = '../../.ssh/authorized_keys.pdf';
		const file = fileRow(1, { name: traversal });
		const { ctx, prepareFn } = makeContext({
			operation: 'download',
			params: { fileName: traversal },
			httpImpl: hostedPlane({ pages: [{ items: [file], next_cursor: null }] }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		const binary = items[0].binary?.data as IBinaryData;
		expect(binary.fileName).toBe('..-..-.ssh-authorized_keys.pdf');
		expect(binary.fileName).not.toMatch(/[\\/]/);
		expect(binary.directory).toBeUndefined();
		expect(binary.fileExtension).toBe('pdf');
		expect(prepareFn).toHaveBeenCalledWith(PDF_BYTES, '..-..-.ssh-authorized_keys.pdf', 'application/pdf');
		expect(items[0].json.name).toBe(traversal);
	});

	it('names the binary safely from the name the link was signed for', async () => {
		const file = fileRow(1, { name: 'Q1/Q2 report?.pdf' });
		const { ctx } = makeContext({
			operation: 'download',
			params: { fileName: 'Q1/Q2 report?.pdf' },
			httpImpl: hostedPlane({
				pages: [{ items: [file], next_cursor: null }],
				link: (linked) => fullResponse(200, { items: [{ ...linkFor(linked), name: '../Q1 report.pdf' }] }),
			}),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect((items[0].binary?.data as IBinaryData).fileName).toBe('..-Q1 report.pdf');
		expect(items[0].json.name).toBe('Q1/Q2 report?.pdf');
	});

	it('makes a name safe as a binary file name: one path segment, never . or .., its extension kept', () => {
		expect(binaryFileNameOf('March invoice.pdf')).toBe('March invoice.pdf');
		expect(binaryFileNameOf('../../.ssh/authorized_keys.pdf')).toBe('..-..-.ssh-authorized_keys.pdf');
		expect(binaryFileNameOf('..\\..\\Windows\\win.ini')).toBe('..-..-Windows-win.ini');
		expect(binaryFileNameOf('C:/temp//x?.pdf')).toBe('C-temp-x-.pdf');
		expect(binaryFileNameOf('a <b> "c" | d*.txt')).toBe('a -b- -c- - d-.txt');
		// A right-to-left override would make an executable read as a PDF.
		expect(binaryFileNameOf('invoice\u202Efdp.exe')).toBe('invoice fdp.exe');
		expect(binaryFileNameOf('  two\tspaces\n.pdf. . ')).toBe('two spaces .pdf');
		expect(binaryFileNameOf('.env')).toBe('.env');
		expect(binaryFileNameOf('Caf\u00e9.pdf')).toBe('Caf\u00e9.pdf');
		for (const nothingLeft of ['', '.', '..', '...', ' . ', '\u200B']) {
			expect(binaryFileNameOf(nothingLeft), JSON.stringify(nothingLeft)).toBe(FALLBACK_BINARY_FILE_NAME);
		}
		expect(binaryFileNameOf('/')).toBe('-');
	});

	it('reads the extension from the whole name, and drops one n8n read from a cut name', () => {
		expect(fileExtensionOf('March invoice.PDF')).toBe('PDF');
		expect(fileExtensionOf('archive.tar.gz')).toBe('gz');
		expect(fileExtensionOf('README')).toBeUndefined();
		expect(fileExtensionOf('.env')).toBeUndefined();
		expect(fileExtensionOf('trailing.')).toBeUndefined();
		expect(fileExtensionOf('v1.2/notes')).toBeUndefined();
	});

	it('refuses a blank name or binary field before any request', async () => {
		for (const params of [{ fileName: '  ' }, { fileName: 'a.pdf', binaryPropertyName: ' ' }]) {
			const { ctx, httpFn } = makeContext({ operation: 'download', params, httpImpl: hostedPlane({}) });
			await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/File Name is required|names no binary field/);
			expect(httpFn).not.toHaveBeenCalled();
		}
	});
});

describe('File resource — Download by ID', () => {
	it('reads the record, links it and gives the same item a name lookup gives', async () => {
		const record = {
			...fileRow(7, { name: 'contract.docx', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
			original_name: 'Contract v3.docx',
			sha256: 'cd'.repeat(32),
			state: 'stored',
			role: null,
			source_uri: null,
			method_ids: [],
			uses: { items: [], next_cursor: null },
		};
		const { ctx, httpFn } = makeContext({
			operation: 'download',
			params: { downloadBy: 'id', fileId: ' fl_7 ' },
			httpImpl: hostedPlane({ records: { fl_7: record } }),
		});

		const [items] = await Pipelex.prototype.execute.call(ctx);

		expect(Object.keys(items[0].json)).toEqual([...FILE_SUMMARY_FIELDS]);
		expect(items[0].json.file_id).toBe('fl_7');
		expect((items[0].binary?.data as IBinaryData).fileName).toBe('contract.docx');
		expect(listQueries(httpFn)).toHaveLength(0);
	});

	it('says when no file has the ID', async () => {
		const { ctx } = makeContext({
			operation: 'download',
			params: { downloadBy: 'id', fileId: 'fl_missing' },
			httpImpl: hostedPlane({}),
		});
		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(
			/Your organization's files hold no file with ID "fl_missing"/,
		);
	});

	it('says when the Base URL serves no files routes', async () => {
		const { ctx } = makeContext({
			operation: 'download',
			params: { downloadBy: 'id', fileId: 'fl_1' },
			httpImpl: () => fullResponse(404, { message: 'Not Found' }),
		});
		await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(FILES_UNAVAILABLE_MESSAGE);
	});

	it('refuses what cannot be a file ID before any request', async () => {
		for (const fileId of ['', '../etc/passwd', 'fl 1']) {
			const { ctx, httpFn } = makeContext({
				operation: 'download',
				params: { downloadBy: 'id', fileId },
				httpImpl: hostedPlane({}),
			});
			await expect(Pipelex.prototype.execute.call(ctx)).rejects.toThrow(/File ID is required|is not a file ID/);
			expect(httpFn).not.toHaveBeenCalled();
		}
	});
});

describe('File resource — Download failures', () => {
	const file = fileRow(1, { name: 'a.pdf' });
	const onePage = { pages: [{ items: [file], next_cursor: null }] };

	/** Run a download that fails, and return its error message and the error's whole serialised form. */
	async function failedDownload(config: Parameters<typeof hostedPlane>[0]): Promise<{ message: string; dump: string }> {
		const { ctx } = makeContext({
			operation: 'download',
			params: { fileName: 'a.pdf' },
			httpImpl: hostedPlane(config),
		});
		try {
			await Pipelex.prototype.execute.call(ctx);
		} catch (error) {
			const { message } = error as Error;
			const dump = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
			return { message, dump };
		}
		throw new Error('the download did not fail');
	}

	it('branches on the link item error, never the status: an upload still in progress', async () => {
		const { message } = await failedDownload({
			...onePage,
			link: () =>
				fullResponse(200, {
					items: [{ ...linkFor(file), url: null, expires_at: null, error: { code: 'conflict', detail: 'not stored yet' } }],
				}),
		});
		expect(message).toMatch(/The upload of the file "a\.pdf" has not finished/);
	});

	it('says a file deleted since it was found', async () => {
		const { message } = await failedDownload({
			...onePage,
			link: () =>
				fullResponse(200, { items: [{ ...linkFor(file), url: null, error: { code: 'not_found', detail: 'gone' } }] }),
		});
		expect(message).toMatch(/no longer holds the file "a\.pdf"/);
	});

	it('never lets a link reach an error, even from an answer it cannot use', async () => {
		const unusable = { ...linkFor(file), url: `ftp://bucket.test/x?${SIGNATURE}` };
		const { message, dump } = await failedDownload({
			...onePage,
			link: () => fullResponse(200, { items: [unusable] }),
		});
		expect(message).toMatch(/without a usable link/);
		expect(dump).not.toContain(SIGNATURE);
	});

	it('says an expired link means retrying, without the link', async () => {
		const { message, dump } = await failedDownload({
			...onePage,
			storage: () =>
				fullResponse(
					403,
					Buffer.from(
						`<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message><X-Amz-Expires>900</X-Amz-Expires><RequestId>1</RequestId><Signature>${SIGNATURE}</Signature></Error>`,
					),
				),
		});
		expect(message).toMatch(/Storage refused the download of "a\.pdf" \(403 AccessDenied\): the download link expired/);
		expect(dump).not.toContain(SIGNATURE);
	});

	it('says storage was not reached, naming its host and not the link', async () => {
		const { message, dump } = await failedDownload({
			...onePage,
			storage: () => {
				throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${STORAGE_ORIGIN}/?${SIGNATURE}`), {
					code: 'ENOTFOUND',
				});
			},
		});
		expect(message).toBe(
			`The download of "a.pdf" could not reach storage at ${STORAGE_ORIGIN}. A file comes from storage directly, not through the Pipelex API, so this n8n instance must be able to reach ${STORAGE_ORIGIN}.`,
		);
		expect(dump).not.toContain(SIGNATURE);
	});

	it('says a refusal of the links route in its own words', async () => {
		const { message } = await failedDownload({
			...onePage,
			link: () =>
				fullResponse(403, { code: 'role_not_permitted', detail: 'Your role, runner, cannot do this.' }),
		});
		expect(message).toBe(
			`Pipelex refused to prepare the download of the file "a.pdf". ${ROLE_NOT_PERMITTED_MESSAGE} Your role, runner, cannot do this.`,
		);
	});
});
