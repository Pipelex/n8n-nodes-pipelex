/**
 * Stored texts — loading the long texts the runtime keeps out of a run's result.
 *
 * Since the runtime's large-text storage, a `native.Text`, `native.Markdown`, `native.Html` or
 * `native.JSON` value past the runtime's inline threshold is stored under the run's scope and
 * travels as its reference, `{ url, size, mime_type, preview }`, in place of its value field
 * (`text`, `inner_html` or `json_obj`). Its `url` is a `pipelex-storage://` address, exactly as an
 * image's or a document's is.
 *
 * The node hands every stored text of `main_stuff` on LOADED, as `@pipelex/sdk` (v0.69.0) does by
 * default: a downstream n8n node reads `main_stuff.text` whatever the text's length, never a
 * reference it would have to resolve itself. A stored text is never turned into a binary file
 * either: it is a value of the output, not a file the run produced.
 *
 * REPLICATED from `@pipelex/sdk`, which this package never imports (see `PipelexApiShapes.ts`):
 * the pure half from `src/stored-texts.ts` (which values are stored texts), the loading from
 * `loadStoredTexts` in `src/artifacts.ts`. The rules kept from the SDK:
 *
 * - **Which values are stored texts is decided by concept, never by URL or MIME type**, as the
 *   MTHDS standard rules (a `Document` may well be `text/plain`). The concept at each path comes
 *   from the run's own artifacts: the main stuff's concept from `working_memory`, and its
 *   structure from the first `output_form` / `input_form` node naming that concept, else the
 *   native's own shape. A result without a working memory is handed on as it is.
 * - **Only the platform's references and `data:` URLs are loaded.** A `pipelex-storage://`
 *   reference is resolved through `POST /v1/resolve-storage-url/bulk` (at most
 *   {@link BULK_RESOLVE_MAX_URIS} per request) and its signed link read from storage; a `data:`
 *   URL is decoded where it is. A stored text under any other URL, which a method's own code can
 *   put there, fails the item before anything is sent, so a method never has the node read a host
 *   the workflow did not choose.
 * - The bytes are UTF-8 by the standard's rule, and a JSON value is the object they serialize.
 *
 * Deliberate divergences, for a workflow node: the signed link is read with n8n's `httpRequest`
 * under the node's own deadline (the upload's, a minute plus a second per started 128 KiB), plain
 * `http:` links are read as the node's uploads and downloads accept them (the local stack's store
 * hands them out), there is no opt-out (the node never hands on a reference), and a failure is an
 * item error naming the run, so the workflow can fetch it again with Get Run Result. The first
 * read that fails stops the item's other reads in flight, and a URL found under two kinds (a
 * `Text` here, a `JSON` there) is read once and decoded at each place by that place's kind. The
 * signed link never appears in an item, an error or a log: it is a bearer capability. The storage
 * plumbing the read shares with the File resource's Download is in `StorageReads.ts`.
 */

import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type IN8nHttpFullResponse,
	type JsonObject,
} from 'n8n-workflow';

import {
	apiHeaders,
	describeNetworkFailure,
	eitherSignal,
	isTimeoutFailure,
	parseStorageError,
	roleRefusalMessage,
	storageOrigin,
	withServerDetail,
	type ApiConnection,
} from './GenericFunctions';
import { PIPELEX_STORAGE_SCHEME, uploadTimeoutMs } from './PipelexApiShapes';
import { bodyBytes, guardBody, readRefusalPrefix, storageReadDeadline, type BodyStream } from './StorageReads';

// ── Constants ────────────────────────────────────────────────────────

/** What a stored text holds once loaded: a text, an HTML fragment, or a JSON object. */
export type StoredTextKind = 'text' | 'html' | 'json';

const KIND_BY_CONCEPT: Readonly<Record<string, StoredTextKind>> = {
	'native.Text': 'text',
	'native.Markdown': 'text',
	'native.Html': 'html',
	'native.JSON': 'json',
};

/** The field a loaded value of each kind is carried in: the inline form's value field. */
export const STORED_TEXT_VALUE_FIELD: Readonly<Record<StoredTextKind, string>> = {
	text: 'text',
	html: 'inner_html',
	json: 'json_obj',
};

/** The fields of the referenced form, which the loaded form drops. */
const STORED_TEXT_REFERENCE_FIELDS: readonly string[] = ['url', 'size', 'mime_type', 'preview'];

/** How many references one bulk resolve request takes — the route's bound; a longer list is a `422`. */
export const BULK_RESOLVE_MAX_URIS = 100;

/** The cap on one stored text's bytes: the runtime's own cap on what it reads from storage, as the SDK's. */
export const STORED_TEXT_MAX_BYTES = 100 * 1024 * 1024;

/** How many stored texts one item reads from storage at once. */
const STORED_TEXT_CONCURRENCY = 4;

/** The message a read's stream is destroyed with when its deadline passes or something else stops it. */
const READ_STOPPED_MESSAGE = 'The read from storage was stopped.';

const MAIN_STUFF_ALIAS = 'main_stuff';
const LIST_ITEMS_FIELD = 'items';
const NATIVE_PREFIX = 'native.';
const DATA_URL_SCHEME = 'data:';
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A descriptor node of the MTHDS standard's input and output forms (`InputFormItem` in
 * `mthds/protocol`), reduced to the slots the walk reads: a node is discriminated on `kind`, an
 * `object` lists its `fields`, a `list` describes its `item`.
 */
export interface FormNode {
	kind: string;
	name?: string;
	concept_ref?: string;
	refines?: string[];
	fields?: FormNode[];
	item?: FormNode;
}

/**
 * The members of the native composites whose shape the walk knows without a descriptor, so a
 * page's text is found even when the run's forms are missing.
 */
const NATIVE_MEMBERS: Readonly<Record<string, Readonly<Record<string, string | readonly [string]>>>> = {
	'native.Page': { text_and_images: 'native.TextAndImages', page_view: 'native.Image' },
	'native.TextAndImages': { text: 'native.Text', images: ['native.Image'] },
};

const NATIVE_FILE_KINDS: Readonly<Record<string, 'image' | 'document'>> = {
	'native.Image': 'image',
	'native.Document': 'document',
};

// ── Concept tests ────────────────────────────────────────────────────

/**
 * The kind of stored text a concept holds, read off the concept itself and then its refinement
 * chain, or `null` for any other concept: `my.Memo refines native.Text` is a `text`, a
 * `native.Document`, whatever its MIME type, is `null`.
 */
export function storedTextKindOf(
	conceptRef: string | null | undefined,
	refines?: readonly string[] | null,
): StoredTextKind | null {
	for (const candidate of [conceptRef, ...(refines ?? [])]) {
		if (typeof candidate !== 'string') continue;
		const kind = KIND_BY_CONCEPT[candidate];
		if (kind !== undefined) return kind;
	}
	return null;
}

/**
 * The stored-text kind a descriptor node describes, or `null`: a list is never one, its items may
 * be. A node is a stored text when its concept, or one its refinement chain names, is a
 * stored-text native, and also when its concept reaches no native at all and the node is text
 * (`prose`, or `text`): a description-only concept is text by the language's rule, and the
 * runtime stores it as it stores a `native.Text`. A field typed by a bare field type carries no
 * concept and is always inline.
 */
export function storedTextKindOfNode(node: FormNode | undefined): StoredTextKind | null {
	if (node === undefined || node.kind === 'list') return null;
	const kind = storedTextKindOf(node.concept_ref, node.refines);
	if (kind !== null) return kind;
	if (node.concept_ref === undefined) return null;
	const chain = [node.concept_ref, ...(node.refines ?? [])];
	if (chain.some((concept) => concept.startsWith(NATIVE_PREFIX))) return null;
	return node.kind === 'prose' || node.kind === 'text' ? 'text' : null;
}

// ── The node at each path ────────────────────────────────────────────

/**
 * The descriptor node of a run's main output, from the run's own artifacts: the main stuff's
 * concept, which the working memory names, and that concept's structure, which the first
 * `output_form` or `input_form` node naming it states. A list content is walked item by item,
 * whether it comes as the `{ items: [...] }` envelope the runtime writes (unless the concept has a
 * field called `items`) or as a bare array.
 *
 * `null` when the result carries no working memory, or one naming no main stuff: nothing then
 * says what the output is, and the result is handed on as it is, as the SDK does.
 */
export function mainStuffNode(result: IDataObject): FormNode | null {
	const memory = result.working_memory;
	if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) return null;
	const aliases = (memory as { aliases?: unknown }).aliases;
	const aliased =
		typeof aliases === 'object' && aliases !== null
			? (aliases as Record<string, unknown>)[MAIN_STUFF_ALIAS]
			: undefined;
	const name = typeof aliased === 'string' ? aliased : MAIN_STUFF_ALIAS;
	const root = (memory as { root?: unknown }).root;
	if (typeof root !== 'object' || root === null) return null;
	const stuff = (root as Record<string, unknown>)[name];
	const conceptRef = conceptRefOf((stuff as { concept?: unknown } | undefined)?.concept);
	if (conceptRef === null) return null;
	return contentNode(conceptRef, result.main_stuff, result);
}

/**
 * The node describing the child at `key` of a value described by `node`, or `undefined` when
 * nothing describes it: a field of an object node, an item of a list node (an entry of a bare
 * array), and the `items` of the plural envelope a list content is serialized to, which the list
 * node itself goes on describing.
 */
function childNode(node: FormNode | undefined, parent: unknown, key: string | number): FormNode | undefined {
	if (node === undefined) return undefined;
	if (node.kind === 'list') {
		if (Array.isArray(parent)) return node.item;
		return key === LIST_ITEMS_FIELD ? node : undefined;
	}
	if (node.kind === 'object' && typeof key === 'string' && !Array.isArray(parent)) {
		return node.fields?.find((field) => field.name === key);
	}
	return undefined;
}

/** A stuff's concept as its reference: the string the standard carries, or a pre-0.60 `{ code, domain_code }`. */
function conceptRefOf(concept: unknown): string | null {
	if (typeof concept === 'string') return concept;
	if (typeof concept === 'object' && concept !== null) {
		const fields = concept as Record<string, unknown>;
		const domain = fields.domain_code ?? fields.domain;
		const code = fields.code;
		if (typeof domain === 'string' && typeof code === 'string') return `${domain}.${code}`;
	}
	return null;
}

/** The node a content of `conceptRef` is walked with: the concept's node, wrapped when the content is plural. */
function contentNode(conceptRef: string, content: unknown, source: IDataObject): FormNode {
	const element = nodeForConcept(conceptRef, source);
	if (!Array.isArray(content) && !isPluralEnvelope(content, element)) return element;
	return {
		kind: 'list',
		concept_ref: conceptRef,
		...(element.refines === undefined ? {} : { refines: element.refines }),
		item: element,
	};
}

/**
 * Whether a content is the `{ items: [...] }` envelope a list content is serialized to — the shape
 * the runtime writes for a list output (pipelex's `ListContent` renders its `items` field) — rather
 * than an object of a concept that has a field called `items`.
 */
function isPluralEnvelope(content: unknown, element: FormNode): boolean {
	if (typeof content !== 'object' || content === null || Array.isArray(content)) return false;
	const keys = Object.keys(content);
	if (keys.length !== 1 || keys[0] !== LIST_ITEMS_FIELD) return false;
	if (!Array.isArray((content as Record<string, unknown>)[LIST_ITEMS_FIELD])) return false;
	return !(element.kind === 'object' && (element.fields ?? []).some((field) => field.name === LIST_ITEMS_FIELD));
}

/** The node the forms state for a concept, else the native's own shape, else an opaque node. */
function nodeForConcept(conceptRef: string, source: IDataObject): FormNode {
	for (const form of [source.output_form, source.input_form]) {
		if (form === null || typeof form !== 'object') continue;
		for (const descriptor of Object.values(form as Record<string, unknown>)) {
			for (const root of descriptorRoots(descriptor)) {
				const found = findConceptNode(root, conceptRef);
				if (found !== undefined) return found;
			}
		}
	}
	return nativeNode(conceptRef);
}

/** The top nodes of one form entry: an output's `field`, an input's `fields`. */
function descriptorRoots(descriptor: unknown): FormNode[] {
	if (typeof descriptor !== 'object' || descriptor === null) return [];
	const entry = descriptor as { field?: unknown; fields?: unknown };
	const roots: FormNode[] = [];
	if (isNode(entry.field)) roots.push(entry.field);
	if (Array.isArray(entry.fields)) roots.push(...entry.fields.filter(isNode));
	return roots;
}

function isNode(value: unknown): value is FormNode {
	return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

/** Depth first, the first node that is not a list and names `conceptRef`. */
function findConceptNode(node: FormNode, conceptRef: string): FormNode | undefined {
	if (node.kind !== 'list' && node.concept_ref === conceptRef) return node;
	if (node.kind === 'list' && isNode(node.item)) return findConceptNode(node.item, conceptRef);
	if (node.kind === 'object' && Array.isArray(node.fields)) {
		for (const field of node.fields) {
			if (!isNode(field)) continue;
			const found = findConceptNode(field, conceptRef);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/** A concept no form describes: the shape of a native the walk knows, else an opaque node naming it. */
function nativeNode(conceptRef: string): FormNode {
	const members = NATIVE_MEMBERS[conceptRef];
	if (members !== undefined) {
		return {
			kind: 'object',
			concept_ref: conceptRef,
			fields: Object.entries(members).map(([name, member]) =>
				typeof member === 'string'
					? { ...nativeNode(member), name }
					: { kind: 'list', name, concept_ref: member[0], item: nativeNode(member[0]) },
			),
		};
	}
	const fileKind = NATIVE_FILE_KINDS[conceptRef];
	if (fileKind !== undefined) return { kind: fileKind, concept_ref: conceptRef };
	return { kind: 'unknown', concept_ref: conceptRef };
}

// ── The walk ─────────────────────────────────────────────────────────

/** One step of a path in `main_stuff`: an object key or a list index. */
export type PathSegment = string | number;

/** One stored text the walk found: where it sits, what it holds, and its reference. */
export interface StoredTextSite {
	segments: PathSegment[];
	kind: StoredTextKind;
	url: string;
	reference: Record<string, unknown>;
}

/** A path as the SDK writes it: `$`, `$.items[2]`, `$.text_and_images.text`, `$["odd key"]`. */
export function renderPath(segments: readonly PathSegment[]): string {
	let path = '$';
	for (const segment of segments) {
		if (typeof segment === 'number') path += `[${segment}]`;
		else if (IDENTIFIER_KEY.test(segment)) path += `.${segment}`;
		else path += `[${JSON.stringify(segment)}]`;
	}
	return path;
}

/**
 * The `url` of a stored text's reference, `value` sitting where the concept is a stored text: an
 * object carrying a string `url` and no value field. `null` for anything else, an inline value
 * included.
 */
function storedTextReferenceUrl(value: unknown, kind: StoredTextKind): string | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const reference = value as Record<string, unknown>;
	const url = reference.url;
	if (typeof url !== 'string') return null;
	const inline = reference[STORED_TEXT_VALUE_FIELD[kind]];
	return inline === undefined || inline === null ? url : null;
}

/** Every stored text's reference in `value`, in walk order, the concept at each path read off `node`. */
export function findStoredTexts(value: unknown, node: FormNode): StoredTextSite[] {
	const sites: StoredTextSite[] = [];
	const trail: PathSegment[] = [];
	const visit = (current: unknown, described: FormNode | undefined): void => {
		const kind = storedTextKindOfNode(described);
		if (kind !== null) {
			const url = storedTextReferenceUrl(current, kind);
			if (url !== null) {
				sites.push({ segments: [...trail], kind, url, reference: current as Record<string, unknown> });
			}
			return;
		}
		if (Array.isArray(current)) {
			current.forEach((entry, index) => {
				trail.push(index);
				visit(entry, childNode(described, current, index));
				trail.pop();
			});
			return;
		}
		if (typeof current === 'object' && current !== null) {
			for (const [key, entry] of Object.entries(current)) {
				trail.push(key);
				visit(entry, childNode(described, current, key));
				trail.pop();
			}
		}
	};
	visit(value, node);
	return sites;
}

/** A string that is a storage reference: the scheme, then at least one character. */
function isStorageReference(url: string): boolean {
	return url.startsWith(PIPELEX_STORAGE_SCHEME) && url.length > PIPELEX_STORAGE_SCHEME.length;
}

// ── Decoding ─────────────────────────────────────────────────────────

/** A `data:` URL's bytes, base64 or percent-encoded, or `null` when it does not decode. */
function decodeDataUrl(url: string): Buffer | null {
	const comma = url.indexOf(',');
	if (comma < 0) return null;
	const header = url.slice(DATA_URL_SCHEME.length, comma);
	const payload = url.slice(comma + 1);
	if (/;base64$/i.test(header)) {
		if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(payload)) return null;
		return Buffer.from(payload, 'base64');
	}
	try {
		return Buffer.from(decodeURIComponent(payload), 'utf8');
	} catch {
		return null;
	}
}

/** Why a stored text could not be loaded: a reason in the SDK's vocabulary, and the sentence a person reads. */
interface LoadFailure {
	reason: string;
	detail: string;
}

/** The value one stored text holds: its UTF-8 text, or for a JSON value the object that text serializes. */
function decodeStoredValue(kind: StoredTextKind, bytes: Buffer): { value: unknown } | LoadFailure {
	let text: string;
	try {
		// The bytes as stored, a byte-order mark included: the value is exactly what was stored.
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return { reason: 'not_utf8', detail: 'its bytes are not UTF-8 text.' };
	}
	if (kind !== 'json') return { value: text };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { reason: 'not_json_object', detail: 'its bytes are not JSON.' };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { reason: 'not_json_object', detail: 'its JSON is not a JSON object.' };
	}
	return { value: parsed };
}

/** The inline form of a loaded stored text: its value field first, its other inline fields kept. */
function loadedForm(site: StoredTextSite, value: unknown): Record<string, unknown> {
	const loaded: Record<string, unknown> = { [STORED_TEXT_VALUE_FIELD[site.kind]]: value };
	for (const [key, entry] of Object.entries(site.reference)) {
		if (!STORED_TEXT_REFERENCE_FIELDS.includes(key)) loaded[key] = entry;
	}
	return loaded;
}

/** `root` with the value at `segments` replaced, in place below the root; the new value itself at `$`. */
function replaceAt(root: unknown, segments: readonly PathSegment[], value: unknown): unknown {
	if (segments.length === 0) return value;
	let parent = root as Record<string | number, unknown>;
	for (const segment of segments.slice(0, -1)) {
		parent = parent[segment] as Record<string | number, unknown>;
	}
	parent[segments[segments.length - 1]] = value;
	return root;
}

function formatMiB(bytes: number): string {
	const mib = bytes / (1024 * 1024);
	return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

// ── Loading ──────────────────────────────────────────────────────────

/** What a failed load is told by: the item, the run, and the text that failed. */
interface LoadContext {
	ctx: IExecuteFunctions;
	itemIndex: number;
	runId: string;
}

/**
 * The item error for a stored text that could not be loaded: where it sits and why in the
 * message, the reference and the reason in the description. It names the run, which completed
 * and can be read again.
 */
function loadError(load: LoadContext, site: StoredTextSite, failure: LoadFailure, description?: string): NodeOperationError {
	const path = renderPath(site.segments);
	const facts = [`Reference: ${site.url}`, `Reason: ${failure.reason}`];
	if (description) facts.push(description);
	return new NodeOperationError(
		load.ctx.getNode(),
		`The run completed, but the stored text at ${path} in main_stuff could not be loaded: ${failure.detail} Fetch it again with the "Get Run Result" operation and pipeline_run_id "${load.runId}".`,
		{ itemIndex: load.itemIndex, description: facts.join(' | ') },
	);
}

/** One reference's verdict from the bulk route: its signed link, or the route's refusal. */
type Resolution = { link: string } | LoadFailure;

/**
 * `POST /v1/resolve-storage-url/bulk` for every reference, at most {@link BULK_RESOLVE_MAX_URIS}
 * per request, answering one verdict per reference. A refusal of the whole request (no route on
 * the Base URL, the credential, an org-less caller, a signing failure) fails the item with the
 * platform's problem; a refusal of one reference is that reference's verdict. An answer that is
 * not one item per reference fails the item without its body, which may hold signed links.
 */
async function resolveReferences(
	load: LoadContext,
	conn: ApiConnection,
	uris: string[],
): Promise<Map<string, Resolution>> {
	const { ctx, itemIndex, runId } = load;
	const verdicts = new Map<string, Resolution>();
	for (let start = 0; start < uris.length; start += BULK_RESOLVE_MAX_URIS) {
		const chunk = uris.slice(start, start + BULK_RESOLVE_MAX_URIS);
		const response = (await ctx.helpers.httpRequest({
			method: 'POST' as IHttpRequestMethods,
			url: `${conn.baseUrl}/v1/resolve-storage-url/bulk`,
			headers: apiHeaders(conn),
			body: { uris: chunk },
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			abortSignal: ctx.getExecutionCancelSignal(),
		})) as IN8nHttpFullResponse;

		const statusCode = response.statusCode;
		if (statusCode < 200 || statusCode >= 300) {
			const body =
				response.body !== null && typeof response.body === 'object' && !Array.isArray(response.body)
					? (response.body as IDataObject)
					: {};
			const lead = `The run completed, but its long texts, which Pipelex stores apart from the result, could not be located (HTTP ${statusCode}).`;
			const message =
				statusCode === 404
					? `${lead} The credential's Base URL offers no POST /v1/resolve-storage-url/bulk route; point it at the hosted Pipelex API.`
					: statusCode === 403 && roleRefusalMessage(body)
						? `${lead} ${roleRefusalMessage(body)}`
						: withServerDetail(`${lead} Fetch it again later with the "Get Run Result" operation and pipeline_run_id "${runId}".`, body);
			throw new NodeApiError(ctx.getNode(), body as JsonObject, {
				message,
				httpCode: String(statusCode),
				itemIndex,
			});
		}

		const items = (response.body as { items?: unknown } | null)?.items;
		if (!Array.isArray(items) || items.length !== chunk.length) {
			throw new NodeApiError(ctx.getNode(), {} as JsonObject, {
				message: `Pipelex answered the request to locate the long texts of run "${runId}" with an answer the node cannot read, so they were not loaded. This is a server-side problem — report it to Pipelex support.`,
				httpCode: String(statusCode),
				itemIndex,
			});
		}
		chunk.forEach((uri, index) => verdicts.set(uri, readResolution(items[index])));
	}
	return verdicts;
}

/** One item of the bulk route's answer as a verdict: `{ uri, url, expires_at, content_type, error }`. */
function readResolution(item: unknown): Resolution {
	if (item === null || typeof item !== 'object') {
		return { reason: 'unknown', detail: 'Pipelex gave no verdict for its reference.' };
	}
	const { url, error } = item as { url?: unknown; error?: unknown };
	if (error !== null && error !== undefined) {
		const { code, detail } = (typeof error === 'object' ? error : {}) as { code?: unknown; detail?: unknown };
		const text = typeof detail === 'string' && detail.trim().length > 0 ? detail.trim() : 'Pipelex refused its reference.';
		return {
			reason: typeof code === 'string' && code.length > 0 ? code : 'unknown',
			detail: /[.!?]$/.test(text) ? text : `${text}.`,
		};
	}
	if (typeof url !== 'string' || url.length === 0) {
		return { reason: 'unknown', detail: 'Pipelex resolved its reference to no link.' };
	}
	return { link: url };
}

/**
 * Read a stream to its end, refusing it once it crosses `maxBytes` (the stream is then destroyed,
 * never read further). Answers `undefined` on crossing the cap.
 */
async function readCapped(stream: BodyStream, maxBytes: number): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of stream) {
			const bytes = bodyBytes(chunk);
			total += bytes.length;
			if (total > maxBytes) return undefined;
			chunks.push(bytes);
		}
	} finally {
		if (!stream.destroyed) stream.destroy();
	}
	return Buffer.concat(chunks);
}

/** The verdict for storage's answer when it is not a `2xx`: never the link, nor its body past its code and message. */
function storageFailure(statusCode: number, body: string): LoadFailure {
	const refusal = parseStorageError(body);
	const status = refusal.code ? `${statusCode} ${refusal.code}` : String(statusCode);
	if (statusCode >= 300 && statusCode < 400) {
		return {
			reason: 'redirect_refused',
			detail: `storage answered with a redirect (${status}), which is not followed: a signed link is valid only where it was signed.`,
		};
	}
	if (statusCode === 404 || statusCode === 410 || refusal.code === 'NoSuchKey') {
		return { reason: 'not_found', detail: `storage no longer holds it (${status}).` };
	}
	if (statusCode === 401 || statusCode === 403) {
		return { reason: 'store_refused', detail: `storage refused the signed link (${status}). Retry the item.` };
	}
	return { reason: 'store_error', detail: `storage failed to send it (${status}). Retry the item.` };
}

/**
 * The bytes of one stored text, read from its signed link under the node's own deadline (the
 * upload's, from the size the reference states) linked with `stopSignal`, which fires when the
 * execution is cancelled or another stored text of the item failed: no `Authorization` (the
 * signature in the link is the credential, and a second one makes S3 refuse the request), no
 * redirect followed, the body read as a stream and refused once it crosses
 * {@link STORED_TEXT_MAX_BYTES}. Every failure is described without the link.
 */
async function readSignedLink(
	load: LoadContext,
	site: StoredTextSite,
	link: string,
	stopSignal: AbortSignal,
): Promise<Buffer> {
	const { ctx } = load;
	const origin = storageOrigin(link);
	if (origin === undefined) {
		throw loadError(load, site, {
			reason: 'unsupported_url',
			detail: 'Pipelex resolved its reference to a link that is not an http(s) address, which is not read.',
		});
	}
	const declaredSize = typeof site.reference.size === 'number' && site.reference.size > 0 ? site.reference.size : 0;
	const limitMs = uploadTimeoutMs(declaredSize);
	const cancelSignal = ctx.getExecutionCancelSignal();
	const { deadline, signal, release } = storageReadDeadline(limitMs, stopSignal);

	const failed = (error: unknown): NodeOperationError => {
		const description = `Network failure: ${describeNetworkFailure(error)}.`;
		if (cancelSignal?.aborted) {
			return new NodeOperationError(ctx.getNode(), 'The stored texts were being loaded when the execution was cancelled.', {
				itemIndex: load.itemIndex,
			});
		}
		if (deadline.aborted || isTimeoutFailure(error)) {
			return loadError(load, site, { reason: 'timeout', detail: `reading it from storage did not finish within ${Math.round(limitMs / 1000)} s.` }, description);
		}
		if (stopSignal.aborted) {
			return loadError(load, site, { reason: 'stopped', detail: 'its read was stopped when another stored text failed to load.' });
		}
		return loadError(
			load,
			site,
			{ reason: 'network', detail: `storage at ${origin} could not be reached; this n8n instance must be able to reach it.` },
			description,
		);
	};

	try {
		let response: IN8nHttpFullResponse | undefined;
		let failure: unknown;
		try {
			response = (await ctx.helpers.httpRequest({
				method: 'GET' as IHttpRequestMethods,
				url: link,
				encoding: 'stream',
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				abortSignal: signal,
			})) as IN8nHttpFullResponse;
		} catch (error) {
			failure = error;
		}
		if (response === undefined) throw failed(failure);

		const body: unknown = response.body;
		const guarded = guardBody(body, signal, { stoppedMessage: READ_STOPPED_MESSAGE });
		const stream = guarded.stream;
		try {
			const statusCode = response.statusCode;
			if (statusCode < 200 || statusCode >= 300) {
				const prefix = await readRefusalPrefix(body);
				throw loadError(load, site, storageFailure(statusCode, prefix.toString('utf8')));
			}
			const declared = Number((response.headers ?? {})['content-length']);
			const tooLarge = (): NodeOperationError =>
				loadError(load, site, {
					reason: 'too_large',
					detail: `it is over the ${formatMiB(STORED_TEXT_MAX_BYTES)} a stored text may hold.`,
				});
			if (Number.isFinite(declared) && declared > STORED_TEXT_MAX_BYTES) throw tooLarge();
			let bytes: Buffer | undefined;
			try {
				bytes = stream ? await readCapped(stream, STORED_TEXT_MAX_BYTES) : bodyBytes(body);
			} catch (error) {
				throw failed(error);
			}
			if (bytes === undefined || bytes.length > STORED_TEXT_MAX_BYTES) throw tooLarge();
			return bytes;
		} finally {
			guarded.release();
		}
	} finally {
		release();
	}
}

/**
 * A completed result with every stored text of `main_stuff` loaded: each value the runtime holds
 * by reference, `{ url, size, mime_type, preview }`, replaced by its inline form, `{ text }`,
 * `{ inner_html }` (its `css_class` kept) or `{ json_obj }`. The result passed in is never
 * changed: a new one is returned, or the same one when there is nothing to load. Only
 * `main_stuff` is loaded, as the SDK loads it; `working_memory` is handed on as the run wrote it.
 *
 * A text that cannot be loaded fails the item, naming where it sits, its reference and why.
 */
export async function loadStoredTexts(
	ctx: IExecuteFunctions,
	conn: ApiConnection,
	result: IDataObject,
	itemIndex: number,
): Promise<IDataObject> {
	if (result.main_stuff === undefined || result.main_stuff === null) return result;
	const node = mainStuffNode(result);
	if (node === null) return result;
	const sites = findStoredTexts(result.main_stuff, node);
	if (sites.length === 0) return result;

	const runId = typeof result.pipeline_run_id === 'string' ? result.pipeline_run_id : '';
	const load: LoadContext = { ctx, itemIndex, runId };

	// Refused before anything is sent: a stored text under a URL the node never reads.
	for (const site of sites) {
		if (!isStorageReference(site.url) && !site.url.startsWith(DATA_URL_SCHEME)) {
			throw loadError(load, site, {
				reason: 'unsupported_url',
				detail:
					'its url is neither a pipelex-storage:// reference nor a data: URL, so the node does not read it.',
			});
		}
		const size = site.reference.size;
		if (typeof size === 'number' && size > STORED_TEXT_MAX_BYTES) {
			throw loadError(load, site, {
				reason: 'too_large',
				detail: `it is ${formatMiB(size)}, over the ${formatMiB(STORED_TEXT_MAX_BYTES)} a stored text may hold.`,
			});
		}
	}

	// One read per distinct URL, named by the first place it was found.
	const firstSite = new Map<string, StoredTextSite>();
	for (const site of sites) if (!firstSite.has(site.url)) firstSite.set(site.url, site);
	const urls = [...firstSite.keys()];
	const references = urls.filter(isStorageReference);
	const resolutions = references.length > 0 ? await resolveReferences(load, conn, references) : new Map();

	// The bytes are kept per URL and decoded per place: one URL may sit where a Text is and where a
	// JSON is, and each place holds the value its own concept makes of the bytes.
	const bytesByUrl = new Map<string, Buffer>();
	const readOne = async (url: string, stopSignal: AbortSignal): Promise<Buffer> => {
		const site = firstSite.get(url)!;
		if (url.startsWith(DATA_URL_SCHEME)) {
			const decoded = decodeDataUrl(url);
			if (decoded === null) throw loadError(load, site, { reason: 'unsupported_url', detail: 'its data: URL does not decode.' });
			if (decoded.length > STORED_TEXT_MAX_BYTES) {
				throw loadError(load, site, {
					reason: 'too_large',
					detail: `it is over the ${formatMiB(STORED_TEXT_MAX_BYTES)} a stored text may hold.`,
				});
			}
			return decoded;
		}
		const resolution = resolutions.get(url) as Resolution;
		if (!('link' in resolution)) throw loadError(load, site, resolution);
		return await readSignedLink(load, site, resolution.link, stopSignal);
	};

	// A few reads at a time. The first failure stops new reads from starting and stops the reads in
	// flight, through one signal linked with the execution's cancel signal; the item then fails with
	// that first failure, once every read has settled.
	const stopReads = new AbortController();
	const cancelSignal = ctx.getExecutionCancelSignal();
	const stopping = cancelSignal ? eitherSignal(cancelSignal, stopReads.signal) : undefined;
	const stopSignal = stopping?.signal ?? stopReads.signal;
	let next = 0;
	let failed = false;
	let firstFailure: unknown;
	const worker = async (): Promise<void> => {
		while (!failed && next < urls.length) {
			const url = urls[next];
			next += 1;
			try {
				bytesByUrl.set(url, await readOne(url, stopSignal));
			} catch (error) {
				if (!failed) {
					failed = true;
					firstFailure = error;
					stopReads.abort();
				}
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(STORED_TEXT_CONCURRENCY, urls.length) }, worker));
	} finally {
		stopping?.unlink();
	}
	if (failed) throw firstFailure;

	const values = new Map<string, unknown>();
	let loaded: unknown = structuredClone(result.main_stuff);
	for (const site of sites) {
		const key = `${site.kind} ${site.url}`;
		if (!values.has(key)) {
			const decoded = decodeStoredValue(site.kind, bytesByUrl.get(site.url)!);
			if (!('value' in decoded)) throw loadError(load, site, decoded);
			values.set(key, decoded.value);
		}
		loaded = replaceAt(loaded, site.segments, loadedForm(site, values.get(key)));
	}
	return { ...result, main_stuff: loaded as IDataObject };
}
