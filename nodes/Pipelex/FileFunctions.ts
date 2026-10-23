import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type IN8nHttpFullResponse,
	type INodeExecutionData,
	type JsonObject,
} from 'n8n-workflow';

import {
	DEFAULT_DOWNLOAD_BINARY_PROPERTY,
	DEFAULT_FILE_LIMIT,
	DOWNLOAD_BY,
	FILE_OPERATION,
	WHEN_SEVERAL_MATCH,
} from './FileDescription';
import {
	FILE_ID_PATTERN,
	FILE_KINDS,
	FILE_SUMMARY_FIELDS,
	MAX_FILE_PAGE_SIZE,
	MAX_FILE_SEARCH_CHARS,
	type FileKind,
	type FileLinkError,
	type FileLinksBody,
	type FileListQuery,
	type FilePage,
	type FileSummary,
} from './FilesApiShapes';
import {
	apiHeaders,
	describeNetworkFailure,
	eitherSignal,
	isTimeoutFailure,
	parseStorageError,
	roleRefusalMessage,
	scalarText,
	storageOrigin,
	withoutFinalPeriod,
	withServerDetail,
	type ApiConnection,
	type StorageRefusal,
} from './GenericFunctions';
import { uploadTimeoutMs } from './PipelexApiShapes';

// ── The File resource: the organization's files ─────────────────────────────
//
// Get Many pages `GET /v1/files`; Download finds one file, by its name through
// the same list or by its ID through `GET /v1/files/{file_id}`, asks
// `POST /v1/files/links` for a fresh presigned link, and reads the bytes from
// storage with it. The wire shapes are in `FilesApiShapes.ts`, the editor's
// fields in `FileDescription.ts`. A link is a bearer capability: it never
// reaches an item, an error message or an error body.

/** Said when the credential's Base URL serves no files routes, as a bare runner does not. */
export const FILES_UNAVAILABLE_MESSAGE =
	"The credential's Base URL offers no files routes (it has no /v1/files), so your organization's files cannot be read from here. Point the Base URL at the hosted Pipelex API.";

/** The response body as a problem document, or an empty one when it is not an object. */
function objectBody(body: unknown): IDataObject {
	return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as IDataObject) : {};
}

// ── Dates: a filter bound is an instant with an offset ──────────────────────

const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const NAIVE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/;

/**
 * How far `timeZone`'s clock is ahead of UTC at the instant `utcMs`, in
 * milliseconds, read through `Intl` (the IANA database Node ships). An unknown
 * zone throws `RangeError`, which the caller reads as UTC.
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric',
	}).formatToParts(new Date(utcMs));
	const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value);
	const asUtc = Date.UTC(
		part('year'),
		part('month') - 1,
		part('day'),
		part('hour') % 24,
		part('minute'),
		part('second'),
	);
	return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in `timeZone`. The offset is looked up
 * twice, the second time at the instant the first guess gives, so a time near a
 * daylight-saving change lands on the offset in force then. A time the clock
 * skips (in a daylight-saving gap, such as a midnight Santiago jumps over) reads
 * back as another time; it is taken as the later candidate, the instant the
 * clock jumps, whichever side of UTC the zone lies.
 */
function zonedWallTimeToUtc(wallAsUtcMs: number, timeZone: string): number {
	try {
		const first = wallAsUtcMs - zoneOffsetMs(wallAsUtcMs, timeZone);
		const second = wallAsUtcMs - zoneOffsetMs(first, timeZone);
		const inGap = second + zoneOffsetMs(second, timeZone) !== wallAsUtcMs;
		return inGap ? Math.max(first, second) : second;
	} catch {
		return wallAsUtcMs;
	}
}

/**
 * A date filter's value as the ISO 8601 UTC instant the platform accepts, which
 * refuses a value without an offset (`400`), since a bare date names a different
 * instant in every zone.
 *
 * n8n's date picker gives a wall-clock time with no offset, such as
 * `2026-10-01T00:00:00`, meant in the workflow's time zone; n8n's own nodes read
 * it there, and so does this one (`timeZone` is the workflow's, from
 * `getTimezone`). A value carrying an offset or `Z`, such as an expression's
 * `{{ $now.minus({ days: 1 }) }}`, is the instant it says. A luxon `DateTime` or
 * a `Date` that an expression resolves to is taken as the instant it holds.
 * Anything else is refused with the field's name, before any request.
 *
 * A date with no time at all, such as `2026-10-01`, is midnight at the start of
 * that day, unless `endOfDay` is set, as it is for the upper bound of a range:
 * then it is the last millisecond of that day, so "created to 2026-10-01"
 * includes the files of October 1 rather than leaving out all but midnight.
 */
export function toInstant(
	value: unknown,
	timeZone: string,
	fieldName: string,
	options: { endOfDay?: boolean } = {},
): { instant?: string; error?: string } {
	if (value === undefined || value === null || value === '') return {};
	const refusal = {
		error: `"${fieldName}" must be a date and time, such as 2026-10-01T00:00:00 or 2026-10-01T00:00:00Z, but it is ${JSON.stringify(value)}.`,
	};
	if (value instanceof Date) {
		return Number.isFinite(value.getTime()) ? { instant: value.toISOString() } : refusal;
	}
	if (typeof value === 'object' && typeof (value as { toISO?: unknown }).toISO === 'function') {
		const iso = (value as { toISO: () => unknown }).toISO();
		return typeof iso === 'string' ? toInstant(iso, timeZone, fieldName, options) : refusal;
	}
	if (typeof value !== 'string') return refusal;
	const text = value.trim();
	if (!text) return {};

	const naive = NAIVE_DATE_TIME.exec(text);
	if (naive) {
		const [, year, month, day, time, minute = '0', second = '0', fraction = ''] = naive;
		const hour = time ?? '0';
		const wallAsUtc = Date.UTC(
			Number(year),
			Number(month) - 1,
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
			Number(fraction.padEnd(3, '0').slice(0, 3)),
		);
		const date = new Date(wallAsUtc);
		// `Date.UTC` rolls an impossible date over (February 30 becomes March 2);
		// reading the fields back refuses it instead.
		if (
			!Number.isFinite(wallAsUtc) ||
			date.getUTCMonth() !== Number(month) - 1 ||
			date.getUTCDate() !== Number(day) ||
			date.getUTCHours() !== Number(hour) ||
			date.getUTCMinutes() !== Number(minute)
		) {
			return refusal;
		}
		if (time === undefined && options.endOfDay) {
			// The next day's midnight, less a millisecond: when daylight saving
			// skips that midnight, the next day starts where the clock jumps.
			const nextMidnight = Date.UTC(Number(year), Number(month) - 1, Number(day) + 1);
			return { instant: new Date(zonedWallTimeToUtc(nextMidnight, timeZone) - 1).toISOString() };
		}
		return { instant: new Date(zonedWallTimeToUtc(wallAsUtc, timeZone)).toISOString() };
	}
	if (OFFSET_SUFFIX.test(text) && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
		const parsed = Date.parse(text);
		if (Number.isFinite(parsed)) return { instant: new Date(parsed).toISOString() };
	}
	return refusal;
}

// ── Get Many: the filters and the list request ──────────────────────────────

/** A comma-separated filter value as its distinct, trimmed, non-empty entries. */
function listValues(value: unknown): string[] {
	const entries = Array.isArray(value) ? value.map(scalarText) : scalarText(value).split(',');
	return [...new Set(entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/**
 * Read the `Filters` collection into the query of `GET /v1/files`. Blank values
 * are left out, so a filter added and left empty filters nothing. Pure, so the
 * node turns the returned error into an item-scoped one.
 */
export function readFileListFilters(
	raw: unknown,
	timeZone: string,
): { query: FileListQuery; error?: string } {
	const filters = objectBody(raw);
	const query: FileListQuery = {};

	const q = scalarText(filters.q);
	if (q) query.q = q;
	const methodId = scalarText(filters.methodId);
	if (methodId) query.method_id = methodId;
	const runId = scalarText(filters.runId);
	if (runId) query.run_id = runId;
	const createdBy = scalarText(filters.createdBy);
	if (createdBy) query.created_by = createdBy;

	if (filters.kind !== undefined && filters.kind !== '') {
		const kind = scalarText(filters.kind);
		if (!(FILE_KINDS as readonly string[]).includes(kind)) {
			return {
				query,
				error: `"Kind" must be one of ${FILE_KINDS.join(', ')}, but it is ${JSON.stringify(filters.kind)}.`,
			};
		}
		query.kind = kind as FileKind;
	}

	const formats = listValues(filters.formats);
	if (formats.length > 0) query.format = formats;
	const mediaTypes = listValues(filters.mediaTypes);
	if (mediaTypes.length > 0) query.media_type = mediaTypes;

	for (const [field, wire, label, endOfDay] of [
		['createdFrom', 'created_from', 'Created From', false],
		['createdTo', 'created_to', 'Created To', true],
	] as const) {
		const { instant, error } = toInstant(filters[field], timeZone, label, { endOfDay });
		if (error) return { query, error };
		if (instant) query[wire] = instant;
	}
	return { query };
}

/**
 * The URL of one page of `GET /v1/files`: the query in its wire names, `format`
 * and `media_type` repeated once per value, then the page size and the cursor.
 */
export function fileListUrl(
	baseUrl: string,
	query: FileListQuery,
	limit: number,
	cursor?: string,
): string {
	const params = new URLSearchParams();
	for (const key of ['q', 'method_id', 'run_id', 'created_by', 'kind'] as const) {
		const value = query[key];
		if (value) params.append(key, value);
	}
	for (const value of query.format ?? []) params.append('format', value);
	for (const value of query.media_type ?? []) params.append('media_type', value);
	if (query.created_from) params.append('created_from', query.created_from);
	if (query.created_to) params.append('created_to', query.created_to);
	params.append('limit', String(limit));
	if (cursor) params.append('cursor', cursor);
	return `${baseUrl}/v1/files?${params.toString()}`;
}

/** A list row the node can use: an object with at least its id, address and name. */
function isFileRow(value: unknown): value is FileSummary {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const { file_id: fileId, uri, name } = value as Record<string, unknown>;
	return typeof fileId === 'string' && fileId.length > 0 && typeof uri === 'string' && typeof name === 'string';
}

/** Read an answer of `GET /v1/files` into a {@link FilePage}, or `undefined` when it is not one. */
export function readFilePage(body: unknown): FilePage | undefined {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
	const { items, next_cursor: nextCursor } = body as Record<string, unknown>;
	if (!Array.isArray(items) || !items.every(isFileRow)) return undefined;
	if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== 'string') return undefined;
	return { items, next_cursor: typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : null };
}

/**
 * Whether a `404` names a thing the request asked for — a run of the `run_id`
 * filter, a file by its ID — rather than a route the Base URL does not serve.
 * The platform answers the second as a library `404` whose `error_domain` is
 * `config`; a gateway in front of a deployment without the route answers with no
 * problem document at all.
 */
export function namesMissingResource(body: IDataObject): boolean {
	if (body.code === 'run_not_found') return true;
	return body.code === 'not_found' && body.error_domain !== 'config';
}

/**
 * The message for a refused request to a files route, `action` saying what the
 * node was asked to do ("list your organization's files"). A refusal by role is
 * read first on a `403`, as on every route; a `404` that names no resource is a
 * Base URL without the routes; the platform's `problem+json` detail follows the
 * rest, its field errors first.
 */
export function filesRefusalMessage(statusCode: number, body: IDataObject, action: string): string {
	switch (statusCode) {
		case 401:
			return withServerDetail(
				`Pipelex did not accept the credential's Bearer Token when asked to ${action} (HTTP 401). Check the token in the Pipelex credential.`,
				body,
			);
		case 403: {
			const roleRefusal = roleRefusalMessage(body);
			if (roleRefusal) return `Pipelex refused to ${action}. ${roleRefusal}`;
			return withServerDetail(
				`Pipelex refused to ${action} (HTTP 403): the credential's token is not allowed to read your organization's files.`,
				body,
			);
		}
		case 404:
			if (!namesMissingResource(body)) return FILES_UNAVAILABLE_MESSAGE;
			return withServerDetail(`Pipelex could not ${action} (HTTP 404).`, body);
		default: {
			const retry = statusCode >= 500 ? ' Retry the item.' : '';
			return withServerDetail(`Pipelex could not ${action} (HTTP ${statusCode}).${retry}`, body);
		}
	}
}

/** Refuse the next request of an execution that was cancelled, saying what was stopped. */
function assertNotCancelled(ctx: IExecuteFunctions, action: string, itemIndex: number): void {
	if (ctx.getExecutionCancelSignal()?.aborted) {
		throw new NodeOperationError(
			ctx.getNode(),
			`The execution was cancelled while the node was asked to ${action}.`,
			{ itemIndex },
		);
	}
}

/** `GET /v1/files` — one page of the organization's listed files, always the largest page. */
export async function requestFilePage(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	query: FileListQuery,
	cursor: string | undefined,
	action: string,
	itemIndex: number,
): Promise<FilePage> {
	const response = (await ctx.helpers.httpRequest({
		method: 'GET' as IHttpRequestMethods,
		url: fileListUrl(conn.baseUrl, query, MAX_FILE_PAGE_SIZE, cursor),
		headers: apiHeaders(conn),
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		abortSignal: ctx.getExecutionCancelSignal(),
	})) as IN8nHttpFullResponse;
	const statusCode = response.statusCode;
	if (statusCode < 200 || statusCode >= 300) {
		const body = objectBody(response.body);
		throw new NodeApiError(ctx.getNode(), body as JsonObject, {
			message: filesRefusalMessage(statusCode, body, action),
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	const page = readFilePage(response.body);
	if (!page) {
		throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
			message: `Pipelex answered the request to ${action} with something that is not a page of files. This is a server-side problem — report it to Pipelex support.`,
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	return page;
}

/**
 * Read the list page after page, handing each page's rows to `visit`, until
 * `visit` says it has enough (`true`) or the list ends. **Only a null cursor ends
 * a list**: a filtered page can be short or empty and still carry one, so an
 * empty page never stops the walk. A server that answers the cursor it was sent
 * would loop forever, so that is refused instead.
 */
export async function visitFilePages(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	query: FileListQuery,
	action: string,
	itemIndex: number,
	visit: (rows: FileSummary[]) => boolean,
): Promise<void> {
	let cursor: string | undefined;
	for (;;) {
		assertNotCancelled(ctx, action, itemIndex);
		const page = await requestFilePage(ctx, conn, query, cursor, action, itemIndex);
		if (visit(page.items) || page.next_cursor === null) return;
		if (page.next_cursor === cursor) {
			throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
				message: `Pipelex answered the same page of files twice when asked to ${action}, so the list would never end. This is a server-side problem — report it to Pipelex support.`,
				itemIndex,
			});
		}
		cursor = page.next_cursor;
	}
}

/** The `Limit` of Get Many as a whole number of at least one, or the reason it is not one. */
function readLimit(value: unknown): { limit?: number; error?: string } {
	const limit = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1) return { limit };
	return { error: `"Limit" must be a whole number of at least 1, but it is ${JSON.stringify(value)}.` };
}

/**
 * Get Many: the organization's files, newest first (or a run's in the order of
 * their addresses), one output item per file, its list row as the item's JSON.
 * Return All walks the list to its end; otherwise the walk stops at the limit.
 * Every page is the largest the platform serves, because a filter thins pages
 * and the walk would otherwise make many small requests to fill a small limit.
 */
export async function listFiles(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const returnAll = ctx.getNodeParameter('returnAll', itemIndex, false) === true;
	let limit = Number.POSITIVE_INFINITY;
	if (!returnAll) {
		const read = readLimit(ctx.getNodeParameter('limit', itemIndex, DEFAULT_FILE_LIMIT));
		if (read.error) throw new NodeOperationError(ctx.getNode(), read.error, { itemIndex });
		limit = read.limit as number;
	}
	const { query, error } = readFileListFilters(
		ctx.getNodeParameter('filters', itemIndex, {}),
		ctx.getTimezone(),
	);
	if (error) throw new NodeOperationError(ctx.getNode(), error, { itemIndex });

	const files: FileSummary[] = [];
	await visitFilePages(ctx, conn, query, "list your organization's files", itemIndex, (rows) => {
		for (const row of rows) {
			if (files.length >= limit) break;
			files.push(row);
		}
		return files.length >= limit;
	});
	return files.map((file) => ({ json: file as IDataObject, pairedItem: { item: itemIndex } }));
}

// ── Download: find the file, link it, read its bytes ────────────────────────

/**
 * A name as Download compares it: Unicode-normalised (NFC) and lowercased, so a
 * name typed on one system finds the same name stored from another, where an
 * accented letter may be one code point or a letter and a combining mark. The
 * platform's search folds less, lowercasing alone, which
 * {@link fileNameSearches} makes up for.
 */
function foldName(name: string): string {
	return name.normalize('NFC').toLowerCase();
}

/** Whether a listed file carries the name asked for, ignoring case and Unicode composition. */
export function sameFileName(listed: string, wanted: string): boolean {
	return foldName(listed) === foldName(wanted.trim());
}

/**
 * The `q` that finds a file by its name: the name itself, or, past the list's
 * bound on a search, its first characters, counted in code points as the
 * platform counts them. The search is a substring match, so a prefix still finds
 * the file, and the exact name is compared on the rows that come back.
 */
export function fileSearchText(name: string): string {
	return Array.from(name.trim()).slice(0, MAX_FILE_SEARCH_CHARS).join('');
}

/**
 * The searches for a name: as typed, in its composed form (NFC) and in its
 * decomposed form (NFD), each once. The platform matches `q` against the stored
 * name lowercased but not normalised, so a name uploaded from macOS, often
 * decomposed, is missed by the composed name a person types, and the reverse;
 * a name holding no accent is the same in every form and needs one search.
 *
 * Together they find a stored name that is entirely composed, entirely
 * decomposed, or exactly as typed. A name stored with its accents partly one
 * way and partly the other, which {@link sameFileName} would accept, is listed
 * by none of them; it is found once the platform's search folds names itself
 * (L-261022-a9b93b), and until then only by its ID.
 */
export function fileNameSearches(name: string): string[] {
	const typed = name.trim();
	return [
		...new Set([typed, typed.normalize('NFC'), typed.normalize('NFD')].map(fileSearchText)),
	];
}

/** When a file was created, in milliseconds, or the earliest instant when its date cannot be read. */
function createdAtMs(file: FileSummary): number {
	const ms = Date.parse(file.created_at);
	return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** Files newest first, as the list orders them, those of the same instant kept in their order. */
function newestFirst(files: FileSummary[]): FileSummary[] {
	return [...files].sort((a, b) => createdAtMs(b) - createdAtMs(a));
}

/** How a file is named in a message that lists candidates: its ID and when it was created. */
function describeCandidate(file: FileSummary): string {
	return `${file.file_id} (created ${file.created_at})`;
}

/**
 * Find a file by its name: list with the name as the search, in each form
 * {@link fileNameSearches} gives, keep the rows whose name is the one asked for,
 * compared ignoring case and Unicode composition, and pick one.
 *
 * Each list is newest first, so its first match is its newest: with `newest`
 * each walk stops there and the newer of those wins; with `fail` each walk stops
 * at its second match, and two distinct files across the walks fail the item.
 * The rows are merged by `file_id`, since a name holding both forms of a letter
 * can come back from more than one search. Only a file no list row names fails
 * the item with "no file", once every list has been read to its end, since a
 * filtered page can be empty with more to come.
 */
export async function findFileByName(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	name: string,
	whenSeveral: string,
	itemIndex: number,
): Promise<FileSummary> {
	const enough = whenSeveral === WHEN_SEVERAL_MATCH.fail ? 2 : 1;
	const found = new Map<string, FileSummary>();
	for (const search of fileNameSearches(name)) {
		// With `fail`, two distinct files already settle it; with `newest`, every
		// search is read, since the newest match may be one only a later one lists.
		if (enough === 2 && found.size >= 2) break;
		let matchesHere = 0;
		await visitFilePages(ctx, conn, { q: search }, `look up the file named "${name}"`, itemIndex, (rows) => {
			for (const row of rows) {
				if (!sameFileName(row.name, name)) continue;
				if (!found.has(row.file_id)) found.set(row.file_id, row);
				matchesHere += 1;
				if (matchesHere >= enough) return true;
			}
			return false;
		});
	}
	const matches = newestFirst([...found.values()]);
	if (matches.length === 0) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Your organization's files hold no file named "${name}". Names are compared ignoring case, extension included; a file whose upload has not finished is not listed yet. To pick a file another way, list them with the File resource's Get Many operation and download one by its ID.`,
			{ itemIndex },
		);
	}
	if (enough === 2 && matches.length > 1) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Several of your organization's files are named "${name}", such as ${describeCandidate(matches[0])} and ${describeCandidate(matches[1])}. Download one by its ID, or set "If Several Files Have This Name" to "Use the Newest".`,
			{ itemIndex },
		);
	}
	return matches[0];
}

/**
 * A file record as its list row: the {@link FILE_SUMMARY_FIELDS} it carries, in
 * that order, so a file downloaded by its ID gives the same item as one found by
 * its name. `undefined` when the record is not one the node can use.
 */
export function fileSummaryOf(record: unknown): FileSummary | undefined {
	if (!isFileRow(record)) return undefined;
	const source = record as Record<string, unknown>;
	const summary: Record<string, unknown> = {};
	for (const field of FILE_SUMMARY_FIELDS) {
		if (field in source) summary[field] = source[field];
	}
	return summary as FileSummary;
}

/**
 * `GET /v1/files/{file_id}` — the file's record, kept as its list row. One use is
 * asked for, the fewest the route serves, since the node reads none. A file that
 * is not the organization's is a `404` naming it; a Base URL without the route,
 * a `404` that does not.
 */
export async function requestFileSummary(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	fileId: string,
	itemIndex: number,
): Promise<FileSummary> {
	const response = (await ctx.helpers.httpRequest({
		method: 'GET' as IHttpRequestMethods,
		url: `${conn.baseUrl}/v1/files/${encodeURIComponent(fileId)}?uses_limit=1`,
		headers: apiHeaders(conn),
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		abortSignal: ctx.getExecutionCancelSignal(),
	})) as IN8nHttpFullResponse;
	const statusCode = response.statusCode;
	if (statusCode < 200 || statusCode >= 300) {
		const body = objectBody(response.body);
		const message =
			statusCode === 404 && namesMissingResource(body)
				? `Your organization's files hold no file with ID "${fileId}". Check the ID, or find the file with the File resource's Get Many operation.`
				: filesRefusalMessage(statusCode, body, `read the file ${fileId}`);
		throw new NodeApiError(ctx.getNode(), body as JsonObject, {
			message,
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	const summary = fileSummaryOf(response.body);
	if (!summary) {
		throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
			message: `Pipelex answered the request for the file ${fileId} with something that is not a file record. This is a server-side problem — report it to Pipelex support.`,
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	return summary;
}

/** A link the node can read a file through: its presigned URL, and the name and type it was signed for. */
export interface UsableFileLink {
	url: string;
	name?: string;
	mediaType?: string;
}

/**
 * Read the answer of `POST /v1/files/links` for the one file the node asked
 * about: a usable link, the item's own `error`, or `undefined` when the answer
 * is neither. The node branches on the item's `error`, never on the status, as
 * the route asks; a link's URL must be an absolute `http(s)` URL with no user
 * info, the rule the upload's storage URL is held to.
 */
export function readFileLink(body: unknown): { link?: UsableFileLink; error?: FileLinkError } | undefined {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
	const items = (body as { items?: unknown }).items;
	if (!Array.isArray(items) || items.length !== 1) return undefined;
	const item = items[0] as Record<string, unknown> | null;
	if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
	const error = item.error as Record<string, unknown> | null | undefined;
	if (error !== null && error !== undefined) {
		if (typeof error !== 'object' || typeof error.code !== 'string') return undefined;
		return { error: { code: error.code, detail: typeof error.detail === 'string' ? error.detail : '' } };
	}
	const { url, name, media_type: mediaType } = item;
	if (typeof url !== 'string' || storageOrigin(url) === undefined) return undefined;
	const link: UsableFileLink = { url };
	if (typeof name === 'string' && name.length > 0) link.name = name;
	if (typeof mediaType === 'string' && mediaType.length > 0) link.mediaType = mediaType;
	return { link };
}

/**
 * The message for a file the links route answered with an `error` rather than a
 * link: `not_found` is a file deleted since it was found, `conflict` an upload
 * still in progress, anything else a refusal whose detail follows.
 */
export function fileLinkErrorMessage(error: FileLinkError, fileName: string): string {
	const detail = error.detail ? { detail: error.detail } : {};
	switch (error.code) {
		case 'not_found':
			return `Pipelex no longer holds the file "${fileName}": it was deleted while the node was preparing its download.`;
		case 'conflict':
			return `The upload of the file "${fileName}" has not finished, so it cannot be downloaded yet. Retry the item in a moment.`;
		default:
			return withServerDetail(`Pipelex refused a download link for the file "${fileName}" (${error.code}).`, detail);
	}
}

/**
 * `POST /v1/files/links` for one file, by its ID — a fresh presigned link that
 * names the file. Sent without an `Idempotency-Key`: the route keeps no copy of
 * a link (a repeated key is a `409`) and asking again is free. The answer's body
 * is never attached to an error, since a link in it is a bearer capability.
 */
export async function requestFileLink(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	file: FileSummary,
	itemIndex: number,
): Promise<UsableFileLink> {
	const request: FileLinksBody = { files: [{ file_id: file.file_id }] };
	const response = (await ctx.helpers.httpRequest({
		method: 'POST' as IHttpRequestMethods,
		url: `${conn.baseUrl}/v1/files/links`,
		headers: apiHeaders(conn),
		body: request as unknown as IDataObject,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		abortSignal: ctx.getExecutionCancelSignal(),
	})) as IN8nHttpFullResponse;
	const statusCode = response.statusCode;
	if (statusCode < 200 || statusCode >= 300) {
		const body = objectBody(response.body);
		throw new NodeApiError(ctx.getNode(), body as JsonObject, {
			message: filesRefusalMessage(statusCode, body, `prepare the download of the file "${file.name}"`),
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	const answer = readFileLink(response.body);
	if (answer?.error) {
		throw new NodeOperationError(ctx.getNode(), fileLinkErrorMessage(answer.error, file.name), {
			itemIndex,
			description: `Pipelex answered ${answer.error.code} for the file ${file.file_id}.`,
		});
	}
	if (!answer?.link) {
		throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
			message: `Pipelex answered the download request for the file "${file.name}" without a usable link, so nothing was downloaded. This is a server-side problem — report it to Pipelex support.`,
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	return answer.link;
}

/** How much of storage's error body is read — where S3 writes its `<Code>` and `<Message>`. */
const STORAGE_ERROR_BODY_MAX_BYTES = 16 * 1024;

/** A response body or one of its chunks as bytes, whichever form n8n hands it in. */
export function bodyBytes(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (typeof body === 'string') return Buffer.from(body, 'utf8');
	return Buffer.alloc(0);
}

/**
 * A response body n8n hands back as a stream, for a request sent with
 * `encoding: 'stream'`: the form `prepareBinaryData` takes besides a `Buffer`.
 * It is named through n8n's own signature because a community node may not
 * import Node's `stream` module, not even for a type.
 */
export type BodyStream = Exclude<Parameters<IExecuteFunctions['helpers']['prepareBinaryData']>[0], Buffer>;

/** Whether a response body is a readable stream rather than bytes. */
export function isBodyStream(body: unknown): body is BodyStream {
	if (body === null || typeof body !== 'object') return false;
	const candidate = body as { pipe?: unknown; on?: unknown; destroy?: unknown };
	return (
		typeof candidate.pipe === 'function' &&
		typeof candidate.on === 'function' &&
		typeof candidate.destroy === 'function'
	);
}

/**
 * The first `maxBytes` of a stream, after which the stream is destroyed rather
 * than read to its end: storage's error document opens its body, so nothing past
 * it is ever held, however long the body. A stream that fails or is destroyed
 * partway gives what it gave by then.
 */
export async function readStreamPrefix(stream: BodyStream, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let length = 0;
	try {
		for await (const chunk of stream) {
			const bytes = bodyBytes(chunk);
			chunks.push(bytes);
			length += bytes.length;
			if (length >= maxBytes) break;
		}
	} catch {
		// What arrived before the failure is all there is to read the refusal from.
	} finally {
		if (!stream.destroyed) stream.destroy();
	}
	return Buffer.concat(chunks).subarray(0, maxBytes);
}

/** The error a download's stream is destroyed with when its deadline passes or the execution is cancelled. */
function stoppedDownloadError(): Error {
	return Object.assign(new Error('The download from storage was stopped.'), {
		name: 'AbortError',
		code: 'ABORT_ERR',
	});
}

/**
 * The message for storage's answer to the download when it is not a `2xx`,
 * after the upload's own reading of storage's errors: an expired link, bytes
 * storage no longer holds, a signature that does not match, or another refusal,
 * each with what to do. Never the link, nor storage's body beyond its code and
 * message.
 */
export function storageDownloadRefusalMessage(
	statusCode: number,
	refusal: StorageRefusal,
	fileName: string,
): string {
	const subject = `"${fileName}"`;
	const status = refusal.code ? `${statusCode} ${refusal.code}` : String(statusCode);
	if (statusCode >= 300 && statusCode < 400) {
		return `Storage redirected the download of ${subject} (${status}), and the redirect was refused: a presigned link is valid only at the address it was signed for.`;
	}
	if (statusCode >= 400 && statusCode < 500) {
		const lead = `Storage refused the download of ${subject} (${status})`;
		if (refusal.message && /expired/i.test(refusal.message)) {
			return `${lead}: the download link expired before the download started. Retry the item: it asks for a new link.`;
		}
		if (statusCode === 404 || refusal.code === 'NoSuchKey') {
			return `${lead}: storage no longer holds the file's bytes, though Pipelex still lists the file. Retry the item; if it fails again, report it to Pipelex support.`;
		}
		if (refusal.code === 'SignatureDoesNotMatch') {
			return `${lead}: the request differs from what the download link signed. Something between n8n and storage changed it (a proxy rewriting headers), or this is a bug in the node — please report it.`;
		}
		return refusal.message
			? `${lead}: ${withoutFinalPeriod(refusal.message)}. Retry the item.`
			: `${lead}. Retry the item.`;
	}
	const detail = refusal.message ? `: ${withoutFinalPeriod(refusal.message)}` : '';
	return `Storage failed to send ${subject} (${status})${detail}. Retry the item.`;
}

/**
 * `GET` the file's bytes from storage with its link and hand them to `store` as
 * the stream they arrive as, so the node never holds the whole file: no
 * `Authorization` (the signature in the URL is the credential, and a second one
 * makes S3 refuse the request) and no `User-Agent` (the client-identification
 * spec leaves a request to a presigned object-store URL alone). Redirects are
 * refused, since a presigned URL is valid only where it was signed. A body n8n
 * hands back as bytes rather than a stream is handed on as bytes.
 *
 * The deadline is the upload's, a minute plus a second per started 128 KiB of
 * the file's recorded size, owned by the node as an `AbortSignal.timeout` linked
 * with the execution's cancel signal, for the reason `putToStorage` gives: it
 * bounds the whole exchange on every axios. With a stream the exchange outlasts
 * the request: axios answers once storage's headers arrive, and its own
 * `timeout` stops counting then, so the signal stays linked until `store` has
 * read the body, and when it fires the node destroys the stream itself, whoever
 * is reading it. A refusal (any status but a `2xx`) is read from the first
 * {@link STORAGE_ERROR_BODY_MAX_BYTES} of its body alone.
 *
 * Every failure is described without the link, which is why a failed request or
 * transfer is caught here and classified outside the `catch`: by the signal that
 * fired, then by whether the stream itself failed. The stream's `error` is always
 * listened to, since an unheard one is thrown, and axios logs it with its
 * request, the link included.
 */
export async function downloadFromLink<T>(
	ctx: IExecuteFunctions,
	link: UsableFileLink,
	file: FileSummary,
	itemIndex: number,
	store: (body: Buffer | BodyStream) => Promise<T>,
): Promise<T> {
	const origin = storageOrigin(link.url) ?? 'storage';
	const fileName = link.name ?? file.name;
	const subject = `"${fileName}"`;
	const cancelSignal = ctx.getExecutionCancelSignal();
	const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0 ? file.size : 0;
	const limitMs = uploadTimeoutMs(size);
	const deadline = AbortSignal.timeout(limitMs);
	const linked = cancelSignal ? eitherSignal(cancelSignal, deadline) : undefined;
	const signal = linked?.signal ?? deadline;

	const cancelled = (): NodeOperationError =>
		new NodeOperationError(ctx.getNode(), `The download of ${subject} was cancelled with the execution.`, {
			itemIndex,
		});
	// The failure's names and codes go in the description, never the message:
	// n8n replaces a message holding a Node error code with a generic sentence.
	const outOfTime = (description: string): NodeOperationError =>
		new NodeOperationError(
			ctx.getNode(),
			`The download of ${subject} from storage did not finish within ${Math.round(limitMs / 1000)} s. Retry the item.`,
			{ itemIndex, description },
		);

	try {
		let response: IN8nHttpFullResponse | undefined;
		let failure: unknown;
		try {
			response = (await ctx.helpers.httpRequest({
				method: 'GET' as IHttpRequestMethods,
				url: link.url,
				encoding: 'stream',
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				abortSignal: signal,
			})) as IN8nHttpFullResponse;
		} catch (error) {
			failure = error;
		}

		if (response === undefined) {
			if (cancelSignal?.aborted) throw cancelled();
			const description = `Network failure: ${describeNetworkFailure(failure)}.`;
			if (deadline.aborted || isTimeoutFailure(failure)) throw outOfTime(description);
			throw new NodeOperationError(
				ctx.getNode(),
				`The download of ${subject} could not reach storage at ${origin}. A file comes from storage directly, not through the Pipelex API, so this n8n instance must be able to reach ${origin}.`,
				{ itemIndex, description },
			);
		}

		const statusCode = response.statusCode;
		const body: unknown = response.body;
		const stream = isBodyStream(body) ? body : undefined;
		let streamFailure: unknown;
		const onStreamError = (error: unknown): void => {
			if (streamFailure === undefined) streamFailure = error ?? stoppedDownloadError();
		};
		// Settles only when the signal fires, so the node stops waiting on `store`
		// then even if what reads the stream never notices it was destroyed.
		let rejectStopped: (error: Error) => void = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			rejectStopped = reject;
		});
		// A refusal's read is not raced, so `stopped` may reject with no one waiting.
		stopped.catch(() => {});
		const stop = (): void => {
			if (stream && !stream.destroyed) stream.destroy(stoppedDownloadError());
			rejectStopped(stoppedDownloadError());
		};
		stream?.on('error', onStreamError);
		signal.addEventListener('abort', stop, { once: true });
		if (signal.aborted) stop();
		try {
			if (statusCode < 200 || statusCode >= 300) {
				const prefix = stream
					? await readStreamPrefix(stream, STORAGE_ERROR_BODY_MAX_BYTES)
					: bodyBytes(body).subarray(0, STORAGE_ERROR_BODY_MAX_BYTES);
				if (cancelSignal?.aborted) throw cancelled();
				// A refusal cut short by the deadline or the network is still read
				// from its status and whatever of its error document arrived.
				const refusal = parseStorageError(prefix.toString('utf8'));
				throw new NodeApiError(
					ctx.getNode(),
					{ storage_status: statusCode, storage_error: refusal.code ?? null } as JsonObject,
					{
						message: storageDownloadRefusalMessage(statusCode, refusal, fileName),
						httpCode: String(statusCode),
						itemIndex,
					},
				);
			}

			try {
				return await Promise.race([store(stream ?? bodyBytes(body)), stopped]);
			} catch (error) {
				if (cancelSignal?.aborted) throw cancelled();
				if (deadline.aborted) {
					throw outOfTime(`Network failure: ${describeNetworkFailure(streamFailure ?? error)}.`);
				}
				if (streamFailure !== undefined) {
					throw new NodeOperationError(
						ctx.getNode(),
						`The download of ${subject} from storage broke off before the whole file arrived. Retry the item.`,
						{ itemIndex, description: `Network failure: ${describeNetworkFailure(streamFailure)}.` },
					);
				}
				// The stream did not fail, so n8n could not keep what it read: its
				// binary data store refused the file.
				throw new NodeOperationError(
					ctx.getNode(),
					`n8n could not store ${subject} as binary data while downloading it. Check the storage n8n keeps binary data in (its binary data mode, and the space left there), then retry the item.`,
					{ itemIndex, description: `Failure: ${describeNetworkFailure(error)}.` },
				);
			}
		} finally {
			signal.removeEventListener('abort', stop);
			// A body not read to its end still holds its connection to storage.
			if (stream && !stream.destroyed) stream.destroy();
		}
	} finally {
		linked?.unlink();
	}
}

/** The extension of a file name, the text after its last dot, or undefined when it has none. */
export function fileExtensionOf(fileName: string): string | undefined {
	const dot = fileName.lastIndexOf('.');
	if (dot <= 0 || dot === fileName.length - 1) return undefined;
	const extension = fileName.slice(dot + 1);
	return /[\s/\\?]/.test(extension) ? undefined : extension;
}

/** Each run of a path separator or another character a file system refuses in a name. */
const UNSAFE_NAME_CHARACTERS = /[\\/:*?"<>|]+/g;

/** A control, format, private-use, unassigned or lone-surrogate character. */
const INVISIBLE_CHARACTERS = /\p{C}/gu;

/** A binary file's name when nothing of the Pipelex name is left to make one. */
export const FALLBACK_BINARY_FILE_NAME = 'file';

/**
 * A Pipelex name as the name of a binary file, safe for a node that writes the
 * file where its name says. The platform keeps a name as a member typed it,
 * `/`, `\` and `..` included, while n8n's other sources give a bare name and a
 * workflow trusts it as one: written to `/data/{{ $binary.data.fileName }}`, a
 * file named `../../.ssh/authorized_keys.pdf` would land outside `/data`. So,
 * as the platform does for the names it gives generated files, each run of a
 * path separator or another character a file system refuses (`: * ? " < > |`)
 * becomes a `-`, an invisible character a space (a right-to-left override among
 * them, which can disguise an extension), runs of whitespace one space, and the
 * trailing dots and spaces go. What is left is one path segment, whose
 * extension is the name's own; a name left empty, or with dots alone, which
 * would be `.` or `..`, becomes {@link FALLBACK_BINARY_FILE_NAME}. The whole
 * name stays in the item's JSON, as `name`.
 */
export function binaryFileNameOf(name: string): string {
	const safe = name
		.replace(INVISIBLE_CHARACTERS, ' ')
		.replace(UNSAFE_NAME_CHARACTERS, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[ .]+$/, '');
	return /^\.*$/.test(safe) ? FALLBACK_BINARY_FILE_NAME : safe;
}

/**
 * Download: one of the organization's files as n8n binary data, its list row as
 * the item's JSON. The file is found by its name ({@link findFileByName}) or by
 * its ID ({@link requestFileSummary}), linked, streamed from storage into n8n's
 * binary data ({@link downloadFromLink}), and put in the output binary field
 * under the name the link was signed for, made safe as a file name
 * ({@link binaryFileNameOf}); the item's JSON keeps the whole name.
 */
export async function downloadFile(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const binaryPropertyName = scalarText(
		ctx.getNodeParameter('binaryPropertyName', itemIndex, DEFAULT_DOWNLOAD_BINARY_PROPERTY),
	);
	if (!binaryPropertyName) {
		throw new NodeOperationError(
			ctx.getNode(),
			`"Put Output File in Field" names no binary field. Set it to the field the file should land in (n8n's default is "${DEFAULT_DOWNLOAD_BINARY_PROPERTY}").`,
			{ itemIndex },
		);
	}

	const findBy = ctx.getNodeParameter('downloadBy', itemIndex, DOWNLOAD_BY.name) as string;
	let file: FileSummary;
	if (findBy === DOWNLOAD_BY.id) {
		const fileId = scalarText(ctx.getNodeParameter('fileId', itemIndex, ''));
		if (!fileId) {
			throw new NodeOperationError(ctx.getNode(), 'File ID is required', { itemIndex });
		}
		if (!FILE_ID_PATTERN.test(fileId)) {
			throw new NodeOperationError(
				ctx.getNode(),
				`"${fileId}" is not a file ID: a file ID holds letters, digits, _ and - alone, such as the file_id of an item from Get Many.`,
				{ itemIndex },
			);
		}
		file = await requestFileSummary(ctx, conn, fileId, itemIndex);
	} else if (findBy === DOWNLOAD_BY.name) {
		const name = scalarText(ctx.getNodeParameter('fileName', itemIndex, ''));
		if (!name) {
			throw new NodeOperationError(ctx.getNode(), 'File Name is required', { itemIndex });
		}
		const whenSeveral = ctx.getNodeParameter(
			'whenSeveralMatch',
			itemIndex,
			WHEN_SEVERAL_MATCH.newest,
		) as string;
		if (whenSeveral !== WHEN_SEVERAL_MATCH.newest && whenSeveral !== WHEN_SEVERAL_MATCH.fail) {
			throw new NodeOperationError(
				ctx.getNode(),
				`"If Several Files Have This Name" must be "${WHEN_SEVERAL_MATCH.newest}" or "${WHEN_SEVERAL_MATCH.fail}", but it is ${JSON.stringify(whenSeveral)}.`,
				{ itemIndex },
			);
		}
		file = await findFileByName(ctx, conn, name, whenSeveral, itemIndex);
	} else {
		throw new NodeOperationError(
			ctx.getNode(),
			`"Find File By" must be "${DOWNLOAD_BY.name}" or "${DOWNLOAD_BY.id}", but it is ${JSON.stringify(findBy)}.`,
			{ itemIndex },
		);
	}

	const link = await requestFileLink(ctx, conn, file, itemIndex);
	const fileName = binaryFileNameOf(link.name ?? file.name);
	const mediaType = link.mediaType ?? (file.media_type || undefined);
	// n8n writes the stream into its binary data store as it arrives, and measures
	// the file there. The name is always given, and never empty: n8n names a
	// response stream given no name after the URL it was read from, which here is
	// the link. The MIME type Pipelex recorded is given too; without one, n8n
	// would read it from the name, then from storage's `Content-Type`.
	const binary = await downloadFromLink(
		ctx,
		link,
		file,
		itemIndex,
		async (body) => await ctx.helpers.prepareBinaryData(body, fileName, mediaType),
	);
	// n8n reads the name it is given as a path, keeping what follows its last
	// slash and cutting it at a `?`. The safe name holds neither, so n8n keeps it
	// whole; it is set again, with no directory and its own extension, so the
	// binary carries exactly the safe name whatever n8n's parsing does.
	binary.fileName = fileName;
	delete binary.directory;
	const extension = fileExtensionOf(fileName);
	if (extension) binary.fileExtension = extension;
	else delete binary.fileExtension;
	return [
		{
			json: file as IDataObject,
			binary: { [binaryPropertyName]: binary },
			pairedItem: { item: itemIndex },
		},
	];
}

/** Run one File operation for one input item, returning its output items. */
export async function executeFileOperation(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	operation: string,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case FILE_OPERATION.getAll:
			return await listFiles(ctx, conn, itemIndex);
		case FILE_OPERATION.download:
			return await downloadFile(ctx, conn, itemIndex);
		default:
			throw new NodeOperationError(ctx.getNode(), `Unknown file operation: ${operation}`, {
				itemIndex,
			});
	}
}
