/**
 * REPLICATED wire shapes of the hosted Pipelex API's files routes — the
 * organization's files, which the node's **File** resource reads. Copied from the
 * platform's own contract, `pipelex-server/platform/docs/files.md` and the routes
 * in `platform/src/pipelex_platform/routers/v1/files.py`, at `pipelex-server`
 * `e835a297` (the merge that added the routes), with the record shapes from
 * `shared/src/pipelex_shared/schemas/file_record.py`.
 *
 * The platform is the source of truth here, not `@pipelex/sdk`, which did not
 * carry the files routes when this was written. Once it does, re-point this
 * header at the SDK, as `PipelexApiShapes.ts` points at it for the run lifecycle.
 * The rule of that file holds here too: **never import `@pipelex/sdk`**, because
 * an n8n community node ships with no dependencies.
 *
 * Re-syncing is a manual read, as for the run shapes: read the platform's
 * `docs/files.md` from the commit stamped above forward, port what changed,
 * update the stamp and the pins in `test/Files.test.ts` (they fail on purpose
 * when a wire field name changes), and note it in `CHANGELOG.md`.
 *
 * The routes this node calls:
 *
 * - `GET /v1/files` — one page of the organization's listed files, newest first
 *   (or, with `run_id`, in the order of the run's addresses), filtered. **Only a
 *   null `next_cursor` ends a list**: a filter applies to the rows a page reads
 *   and the page is never refilled, so a filtered page can be short or empty and
 *   still carry a cursor.
 * - `GET /v1/files/{file_id}` — one file's record, read here only for the
 *   fields its list row carries.
 * - `POST /v1/files/links` — fresh presigned links to read files, one verdict per
 *   file on a `200`: **a client branches on each item's `error`, never on the
 *   status.** A link is a bearer capability for fifteen minutes, so the node never
 *   puts one in an item, a log or an error.
 */

/** What made a file: a person's upload, a run, or the build assistant's test input. */
export type FileKind = 'uploaded' | 'generated' | 'test';

/** The kinds `GET /v1/files` filters on, in the order the node offers them. */
export const FILE_KINDS: readonly FileKind[] = ['uploaded', 'generated', 'test'];

/**
 * Who or what made a file. Every field is optional because each kind fills a
 * different part: an upload its `surface`, a run's file its `run_id`, method and
 * version. Open to fields the platform adds.
 */
export interface FileOrigin {
	surface?: string | null;
	run_id?: string | null;
	method_id?: string | null;
	method_version?: number | 'draft' | null;
	[extension: string]: unknown;
}

/**
 * One row of a file list, `FileSummary`: what a list shows of a file. The item
 * the node outputs for a file, whether it listed it or downloaded it.
 */
export interface FileSummary {
	/** The record's id, `fl_…`. */
	file_id: string;
	/** The `pipelex-storage://` address of the bytes, which a run takes as a file input. */
	uri: string;
	/** The name a person sees, used for downloads; changes with a rename. */
	name: string;
	media_type: string;
	/** The format key the list's `format` filter matches: `pdf`, `docx`, `image`, `html`, … */
	format: string;
	/** The byte size. */
	size: number;
	kind: FileKind;
	origin: FileOrigin;
	/** ISO 8601 instant the record was made. */
	created_at: string;
	/** The user the file is attributed to: the uploader, or the user who started the run. */
	created_by: string;
	[extension: string]: unknown;
}

/**
 * The fields of {@link FileSummary}, in the platform's order. A record read by its
 * id carries more (its original name, its hash, its state, its methods and its
 * uses); the node keeps these alone, so a downloaded file's item has one shape
 * however the file was found.
 */
export const FILE_SUMMARY_FIELDS = [
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
] as const;

/** Answer of `GET /v1/files`: one page, newest first. Only a null `next_cursor` ends the list. */
export interface FilePage {
	items: FileSummary[];
	next_cursor: string | null;
}

/**
 * The query of `GET /v1/files`, in its wire names. Every filter is optional;
 * `format` and `media_type` repeat for several values, and the two dates are
 * ISO 8601 instants with an offset, both inclusive.
 */
export interface FileListQuery {
	method_id?: string;
	run_id?: string;
	/** A member's user id, or `me` for the caller's own files. */
	created_by?: string;
	kind?: FileKind;
	format?: string[];
	media_type?: string[];
	created_from?: string;
	created_to?: string;
	/** A case-insensitive search in the file's name and original name. */
	q?: string;
}

/** The largest page `GET /v1/files` answers (`MAX_FILE_PAGE_SIZE`); the node always asks for it. */
export const MAX_FILE_PAGE_SIZE = 200;

/** The longest `q` the list accepts, in characters (Unicode code points, as Python counts them). */
export const MAX_FILE_SEARCH_CHARS = 200;

/**
 * What a file id may hold (`FILE_ID_PATTERN`, at most `MAX_FILE_ID_CHARS`): the
 * platform refuses anything else with a `422`, and the node says so first.
 */
export const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** One file to link, by its record's id. The route also takes a `uri`, which the node does not send. */
export interface FileLinkTarget {
	file_id: string;
}

/** Body of `POST /v1/files/links`: at most 100 files, answered in the request's order. */
export interface FileLinksBody {
	files: FileLinkTarget[];
}

/**
 * Why one file got no link: `not_found` (an unknown id, or one deleted while the
 * request settled it), `conflict` (an upload that has not finished),
 * `invalid_storage_uri` or `forbidden`.
 */
export interface FileLinkError {
	code: string;
	detail: string;
}

/**
 * One file's link, or why it has none. Either `url` and `expires_at` are set and
 * `error` is null, or `error` is set and the others are null.
 */
export interface FileLink {
	file_id: string | null;
	uri: string | null;
	/** The name the download saves under. */
	name: string | null;
	media_type: string | null;
	/** A presigned `GET`, valid for fifteen minutes: a bearer capability. */
	url: string | null;
	expires_at: string | null;
	error: FileLinkError | null;
}

/** Answer of `POST /v1/files/links`: exactly one {@link FileLink} per requested file. */
export interface FileLinksAnswer {
	items: FileLink[];
}
