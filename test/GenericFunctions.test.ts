import type { IBinaryData, IDataObject } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	FORBIDDEN_MESSAGE,
	MISSING_MAIN_STUFF_MESSAGE,
	NOT_FOUND_MESSAGE,
	RESULT_MID_WRITE_MESSAGE,
	ROLE_NOT_PERMITTED_MESSAGE,
	UPLOAD_UNAVAILABLE_MESSAGE,
	base64FileEntry,
	binaryByteSize,
	binaryFieldNames,
	binaryInputConflictError,
	binarySizeError,
	buildApiConnection,
	buildStartBody,
	describeBinaryFile,
	describeNetworkFailure,
	eitherSignal,
	idempotencyKey,
	isTimeoutFailure,
	mapResultResponse,
	missingBinaryMessage,
	parseStorageError,
	planMethodFiles,
	problemMessage,
	readBinaryInputMappings,
	readMethodBinaryFileRows,
	readUploadGrant,
	roleRefusalMessage,
	runFailureData,
	runFailureDescription,
	runFailureMessage,
	runSourceError,
	startRefusalMessage,
	storageRefusalMessage,
	storedFileInput,
	storedFileReferences,
	treePathError,
	uploadGrantRefusalMessage,
	withRunId,
} from '../nodes/Pipelex/GenericFunctions';
import {
	DEFAULT_DEGRADED_RETRY_SECONDS,
	MAX_UPLOAD_BYTES,
	extensionForContentType,
	guessContentType,
	parseRetryAfter,
	uploadTimeoutMs,
} from '../nodes/Pipelex/PipelexApiShapes';

describe('buildApiConnection (manual auth — credential has no authenticate block)', () => {
	it('builds the Bearer Authorization header from the credential', () => {
		const conn = buildApiConnection({ baseUrl: 'https://api.test', apiKey: 'tok-1' });
		expect(conn).toEqual({ baseUrl: 'https://api.test', authorization: 'Bearer tok-1' });
	});

	it('strips a trailing slash from the base URL', () => {
		const conn = buildApiConnection({ baseUrl: 'https://api.test/', apiKey: 'tok-1' });
		expect(conn.baseUrl).toBe('https://api.test');
	});
});

describe('buildStartBody', () => {
	it('maps pipe_code only', () => {
		const body = buildStartBody({ pipeCode: 'my-pipe', inputs: { a: 1 } });
		expect(body).toEqual({ pipe_code: 'my-pipe', inputs: { a: 1 } });
	});

	it('allows both pipe_code and files (a method + a chosen pipe)', () => {
		const body = buildStartBody({ pipeCode: 'p', files: { 'main.mthds': 'b' } });
		expect(body.pipe_code).toBe('p');
		expect(body.files).toEqual({ 'main.mthds': 'b' });
	});

	it('maps method_id (hosted stored-method extension)', () => {
		const body = buildStartBody({ methodId: 'method-42' });
		expect(body).toEqual({ method_id: 'method-42' });
	});

	it('maps overrides to snake_case', () => {
		const body = buildStartBody({
			pipeCode: 'p',
			outputName: 'out',
			outputMultiplicity: '3',
			dynamicOutputConceptRef: 'concept.ref',
		});
		expect(body.output_name).toBe('out');
		expect(body.output_multiplicity).toBe('3');
		expect(body.dynamic_output_concept_ref).toBe('concept.ref');
	});

	it('omits empty strings and an empty files map', () => {
		const body = buildStartBody({
			pipeCode: '',
			methodId: '',
			files: {},
			outputName: '',
			outputMultiplicity: '',
			dynamicOutputConceptRef: '',
		});
		expect(body).toEqual({});
	});

	it('keeps an explicit empty inputs object (undefined check, not truthiness)', () => {
		const body = buildStartBody({ pipeCode: 'p', inputs: {} });
		expect(body.inputs).toEqual({});
	});

	it('omits inputs when undefined', () => {
		const body = buildStartBody({ pipeCode: 'p' });
		expect('inputs' in body).toBe(false);
	});

	it('maps the method files to files, text and Base64 entries as they are', () => {
		const files = {
			'main.mthds': 'domain = "d"',
			'funcs/f.py': 'def go(): ...',
			'templates/letter.docx': { base64: 'UEsDBA==' },
		};
		const body = buildStartBody({ files });
		expect(body).toEqual({ files });
	});

	it('drops an empty files map entirely (it carries no method)', () => {
		const body = buildStartBody({ pipeCode: 'p', files: {} });
		expect(body).toEqual({ pipe_code: 'p' });
	});
});

describe("treePathError (the standard's tree path, and the names no tree admits)", () => {
	it.each([
		['main.mthds'],
		['funcs/score.py'],
		['structures/models/invoice.py'],
		['requirements.txt'],
		// The root's own manifest is the one METHODS.toml a tree holds.
		['METHODS.toml'],
		// Spaces and accents are ordinary in a tree path; it is a name, never a storage key.
		['templates/Lettre à en-tête.docx'],
		// The defaults exclude a DIRECTORY of these names; a file of that name is ordinary.
		['node_modules'],
		['funcs/__pycache__'],
		// Run inputs files match byte for byte, so another case is an ordinary member.
		['examples/Inputs.json'],
		// A directory named pyvenv.cfg marks nothing: only a file of that name does.
		['pyvenv.cfg/notes.txt'],
		['a'.repeat(255)],
	])('accepts %s', (path) => {
		expect(treePathError(path)).toBeNull();
	});

	it.each([
		['/etc/passwd', /starts with "\/"/],
		['funcs/', /ends with "\/"/],
		['funcs//score.py', /empty segment/],
		['../escape.py', /"\.\."/],
		['funcs/../../escape.py', /"\.\."/],
		['./main.mthds', /"\."/],
		['funcs\\score.py', /backslash/],
		['C:funcs.py', /":"/],
		['funcs/a\u0007.py', /control character/],
		// "é" written decomposed: a key is never normalized, so it must already be NFC.
		['templates/é.txt', /NFC/],
		['a\uD800.txt', /cannot encode/],
		[`${'a'.repeat(256)}`, /255 bytes/],
		[`${'a/'.repeat(512)}b`, /1024 bytes/],
		['.env', /starts with a dot/],
		['funcs/.secret.py', /starts with a dot/],
		['__pycache__/score.pyc', /__pycache__/],
		['web/node_modules/lib.js', /node_modules/],
		['pyvenv.cfg', /pyvenv\.cfg/],
		['inputs.json', /run's inputs/],
		['examples/inputs.toml', /run's inputs/],
		['vendor/METHODS.toml', /METHODS\.toml/],
	])('refuses %s, saying why', (path, expected) => {
		const error = treePathError(path);
		expect(error).toMatch(expected);
		// Every message names the path it refuses, so a row is easy to find.
		expect(error).toContain('Method file path "');
	});
});

describe('planMethodFiles (an inline method becomes one files map)', () => {
	const NONE = { bundles: [], textFiles: [], binaryFiles: [] };

	it('names the pasted bundles main.mthds, then bundle-2.mthds, deterministically', () => {
		const plan = planMethodFiles({ ...NONE, bundles: ['one', 'two', 'three'] });
		expect(plan.error).toBeUndefined();
		expect(plan.textEntries).toEqual({
			'main.mthds': 'one',
			'bundle-2.mthds': 'two',
			'bundle-3.mthds': 'three',
		});
		expect(plan.binaryFiles).toEqual([]);
	});

	it('sends the pasted method and its text files as one map of text entries', () => {
		// The headline flow: paste the method, add its Python, run. The bundles are
		// files of the tree like any other, so they travel in the same map.
		const plan = planMethodFiles({
			...NONE,
			bundles: ['domain = "d"'],
			textFiles: [
				{ path: 'funcs/score.py', content: 'def score(): ...' },
				{ path: 'requirements.txt', content: '' },
			],
		});
		expect(plan.textEntries).toEqual({
			'main.mthds': 'domain = "d"',
			'funcs/score.py': 'def score(): ...',
			'requirements.txt': '',
		});
	});

	it('keeps the binary rows for loading, at their paths', () => {
		const plan = planMethodFiles({
			...NONE,
			bundles: ['m'],
			binaryFiles: [{ path: 'templates/letter.docx', binaryPropertyName: 'data' }],
		});
		expect(plan.error).toBeUndefined();
		expect(plan.textEntries).toEqual({ 'main.mthds': 'm' });
		expect(plan.binaryFiles).toEqual([{ path: 'templates/letter.docx', binaryPropertyName: 'data' }]);
	});

	it('never lets a generated name clobber a path the author chose, whatever its case', () => {
		// A tree never holds two paths that differ only by case, so the generated
		// name steps aside from `Main.mthds` as it does from `main.mthds`.
		const exact = planMethodFiles({
			...NONE,
			bundles: ['inline'],
			textFiles: [{ path: 'main.mthds', content: 'theirs' }],
		});
		expect(exact.textEntries['main.mthds']).toBe('theirs');
		expect(Object.values(exact.textEntries)).toContain('inline');

		const cased = planMethodFiles({
			...NONE,
			bundles: ['inline'],
			binaryFiles: [{ path: 'Main.mthds', binaryPropertyName: 'data' }],
		});
		expect(Object.keys(cased.textEntries)).toEqual(['bundle-2.mthds']);
	});

	it('refuses a path given twice, within one field or across both, naming it', () => {
		// A map holds one entry per path; keeping the last would silently drop a
		// file the author configured.
		const within = planMethodFiles({
			...NONE,
			bundles: ['m'],
			textFiles: [
				{ path: 'funcs/score.py', content: '1' },
				{ path: 'funcs/score.py', content: '2' },
			],
		});
		expect(within.error).toContain('funcs/score.py');
		expect(within.error).toMatch(/more than once/);

		const across = planMethodFiles({
			...NONE,
			bundles: ['m'],
			textFiles: [{ path: 'templates/letter.html', content: '<p/>' }],
			binaryFiles: [{ path: 'templates/letter.html', binaryPropertyName: 'data' }],
		});
		expect(across.error).toContain('templates/letter.html');
		expect(across.error).toMatch(/more than once/);
	});

	it('refuses files with no method, saying what to do', () => {
		// Files alone are not runnable; the runner refuses a tree with no bundle.
		for (const params of [
			{ ...NONE, textFiles: [{ path: 'funcs/a.py', content: 'a' }] },
			{ ...NONE, binaryFiles: [{ path: 'templates/a.docx', binaryPropertyName: 'data' }] },
		]) {
			const plan = planMethodFiles(params);
			expect(plan.error).toMatch(/need the method/);
			expect(plan.error).toMatch(/MTHDS Bundles/);
			expect(plan.error).toMatch(/Method ID/);
		}
	});

	it('takes a .mthds file among the method files as the method', () => {
		// A method kept as files elsewhere (a Drive folder, an HTTP download) need
		// not be pasted: its bundle can arrive as a file like the rest.
		expect(
			planMethodFiles({ ...NONE, textFiles: [{ path: 'methods/main.mthds', content: 'm' }] }).error,
		).toBeUndefined();
		expect(
			planMethodFiles({ ...NONE, binaryFiles: [{ path: 'main.mthds', binaryPropertyName: 'data' }] })
				.error,
		).toBeUndefined();
	});

	it('refuses a path no tree admits, before anything is loaded', () => {
		const text = planMethodFiles({ ...NONE, bundles: ['m'], textFiles: [{ path: '../x.py', content: 'x' }] });
		expect(text.error).toMatch(/"\.\."/);
		const binary = planMethodFiles({
			...NONE,
			bundles: ['m'],
			binaryFiles: [{ path: '.env', binaryPropertyName: 'data' }],
		});
		expect(binary.error).toMatch(/starts with a dot/);
	});

	it('refuses text UTF-8 cannot encode, naming its path', () => {
		const plan = planMethodFiles({
			...NONE,
			bundles: ['m'],
			textFiles: [{ path: 'notes.txt', content: 'broken \uD800 text' }],
		});
		expect(plan.error).toContain('notes.txt');
		expect(plan.error).toMatch(/cannot be sent as text/);
	});

	it('keeps a path spelled like an object prototype as a file of its own', () => {
		// `files[path] = …` with the path `__proto__` would set the map's prototype
		// and send nothing; the entry must be an own property like any other.
		const plan = planMethodFiles({
			...NONE,
			bundles: ['m'],
			textFiles: [{ path: '__proto__', content: 'x' }],
		});
		expect(Object.keys(plan.textEntries)).toEqual(['main.mthds', '__proto__']);
		expect(JSON.stringify(plan.textEntries)).toBe('{"main.mthds":"m","__proto__":"x"}');
	});

	it('plans nothing, and refuses nothing, when no field holds a file', () => {
		expect(planMethodFiles(NONE)).toEqual({ textEntries: {}, binaryFiles: [] });
	});

	it('produces a body that passes the run-source rules', () => {
		const plan = planMethodFiles({ ...NONE, bundles: ['m'], textFiles: [{ path: 'f.py', content: 'x' }] });
		const body = buildStartBody({ files: plan.textEntries });
		expect(runSourceError(body)).toBeNull();
		expect(body).not.toHaveProperty('mthds_contents');
	});
});

describe('base64FileEntry (a binary method file as the standard carries bytes)', () => {
	it('encodes the bytes in padded standard Base64, with no line break', () => {
		expect(base64FileEntry(Buffer.from([0xff, 0xfe, 0x00]))).toEqual({ base64: '//4A' });
		expect(base64FileEntry(Buffer.from([0xfb]))).toEqual({ base64: '+w==' });
		expect(base64FileEntry(Buffer.from([0xfb, 0xef]))).toEqual({ base64: '++8=' });
		const large = base64FileEntry(Buffer.alloc(100_000, 0xab));
		expect(large.base64).not.toMatch(/\s/);
		expect(Buffer.from(large.base64, 'base64')).toEqual(Buffer.alloc(100_000, 0xab));
	});

	it('carries an empty file, which is a member of a tree like any other', () => {
		expect(base64FileEntry(Buffer.alloc(0))).toEqual({ base64: '' });
	});

	it('is canonical: its pad bits are zero, so it encodes back to itself', () => {
		for (const length of [1, 2, 3, 4, 5]) {
			const { base64 } = base64FileEntry(Buffer.alloc(length, 0xff));
			expect(Buffer.from(base64, 'base64').toString('base64')).toBe(base64);
		}
	});
});

describe('readMethodBinaryFileRows (the Method Binary Files rows)', () => {
	it('reads each row as a path and the binary field that holds the file', () => {
		expect(
			readMethodBinaryFileRows({
				file: [
					{ path: 'templates/letter.docx', binaryPropertyName: 'data' },
					{ path: '  assets/logo.png ', binaryPropertyName: 'attachment_0' },
				],
			}),
		).toEqual({
			rows: [
				{ path: 'templates/letter.docx', binaryPropertyName: 'data' },
				{ path: 'assets/logo.png', binaryPropertyName: 'attachment_0' },
			],
		});
	});

	it('reads an empty or absent collection as no file', () => {
		expect(readMethodBinaryFileRows(undefined)).toEqual({ rows: [] });
		expect(readMethodBinaryFileRows({})).toEqual({ rows: [] });
	});

	it('drops a row whose path is blank (the editor persists a row on add)', () => {
		expect(readMethodBinaryFileRows({ file: [{ path: '  ', binaryPropertyName: 'data' }] })).toEqual({
			rows: [],
		});
	});

	it('falls back to the "data" field when the stored row has none', () => {
		expect(readMethodBinaryFileRows({ file: [{ path: 'a.docx' }] })).toEqual({
			rows: [{ path: 'a.docx', binaryPropertyName: 'data' }],
		});
	});

	it('refuses a binary field explicitly cleared, rather than guessing one', () => {
		const { error } = readMethodBinaryFileRows({ file: [{ path: 'a.docx', binaryPropertyName: ' ' }] });
		expect(error).toContain('a.docx');
		expect(error).toMatch(/names no binary field/);
	});
});

describe('runSourceError (the run-source rules, judged on the built body)', () => {
	it.each([
		['pipe_code alone', { pipe_code: 'p' }],
		['method_id alone', { method_id: 'm' }],
		['a method sent as files', { files: { 'a.mthds': 'x' } }],
		['method_id + pipe_code (pick a pipe inside the stored method)', { method_id: 'm', pipe_code: 'p' }],
		['pipe_code + files (a method plus a chosen pipe)', { pipe_code: 'p', files: { 'a.mthds': 'x' } }],
	])('accepts %s', (_label, body) => {
		expect(runSourceError(body)).toBeNull();
	});

	it('rejects a stored method together with an inline one', () => {
		// The hosted API would accept this and treat method_id as run-history
		// linkage; the node refuses it so "what does this node run?" has one answer.
		expect(runSourceError({ method_id: 'm', files: { 'a.mthds': 'x' } })).toMatch(/Choose one/);
	});

	it('rejects a body with no run source at all', () => {
		expect(runSourceError({})).toMatch(/Nothing to run/);
		expect(runSourceError({ inputs: { a: 1 } })).toMatch(/Nothing to run/);
	});

	it('does not count an empty files map as a source', () => {
		expect(runSourceError({ files: {} })).toMatch(/Nothing to run/);
	});
});

describe("startRefusalMessage (a refused start, in the node's words where the API's are not enough)", () => {
	it("reads the gateway's bare 413 as a request too large to carry the method's files", () => {
		const message = startRefusalMessage(413, { message: 'Request Entity Too Large' });
		expect(message).toMatch(/too large/);
		expect(message).toMatch(/Method ID/);
	});

	it("reads the platform's inline limit the same way, keeping its detail", () => {
		const message = startRefusalMessage(422, {
			code: 'method_tree_too_large',
			detail: "This request's method tree takes 8000000 bytes of its body, past this deployment's limit of 7340032 bytes.",
			limit: { name: 'max_inline_bytes', value: 7340032, reached: 8000000 },
		});
		expect(message).toMatch(/Method ID/);
		expect(message).toContain('(Server: This request');
	});

	it("leaves a tree past the deployment's other limits to the API's own sentence", () => {
		// Saving the method would not help a tree over the file-count or total-size
		// limit, which every holder of a tree applies; the API names the limit.
		const detail = "This request's method tree holds 2000 files, past this deployment's limit of 1000 files in a method tree.";
		expect(
			startRefusalMessage(422, {
				code: 'method_tree_too_large',
				detail,
				limit: { name: 'max_files', value: 1000, reached: 2000 },
			}),
		).toBe(detail);
	});

	it("shows the API's refusal of a files map as it wrote it, naming the key", () => {
		const detail = "The method's files are not a method tree: the keys 'README.md' and 'readme.md' collide.";
		expect(startRefusalMessage(422, { code: 'invalid_method_files', detail })).toBe(detail);
	});

	it('falls back to a generic sentence when the body says nothing', () => {
		expect(startRefusalMessage(500, {})).toBe('Failed to start run');
	});
});

describe('idempotencyKey', () => {
	it('joins execution id, node id, run index, and item index', () => {
		expect(idempotencyKey('exec-abc', 'node-1', 0, 0)).toBe('exec-abc:node-1:0:0');
		expect(idempotencyKey('exec-abc', 'node-1', 0, 7)).toBe('exec-abc:node-1:0:7');
	});

	it('differs across nodes in the same execution + item (no collision)', () => {
		expect(idempotencyKey('exec-abc', 'node-1', 0, 0)).not.toBe(
			idempotencyKey('exec-abc', 'node-2', 0, 0),
		);
	});

	it("differs across a loop's passes of the same node and item", () => {
		// Each pass numbers its items from 0 again; the run index tells them apart.
		expect(idempotencyKey('exec-abc', 'node-1', 1, 0)).not.toBe(idempotencyKey('exec-abc', 'node-1', 0, 0));
	});
});

describe('parseRetryAfter (vendored from mthds-js)', () => {
	it('parses the lowercased header', () => {
		expect(parseRetryAfter({ 'retry-after': '7' })).toBe(7);
	});

	it('tolerates the title-cased header', () => {
		expect(parseRetryAfter({ 'Retry-After': '12' })).toBe(12);
	});

	it('returns undefined for absent / non-numeric / negative values', () => {
		expect(parseRetryAfter({})).toBeUndefined();
		expect(parseRetryAfter({ 'retry-after': 'soon' })).toBeUndefined();
		expect(parseRetryAfter({ 'retry-after': '-3' })).toBeUndefined();
	});
});

describe('mapResultResponse (mirrors mthds-js getRunResult)', () => {
	it('200 → completed, passes the body through', () => {
		const body = { pipeline_run_id: 'r1', main_stuff: { x: 1 }, graph_spec: { nodes: [] } };
		const outcome = mapResultResponse(200, body, {});
		expect(outcome).toEqual({ kind: 'completed', body });
	});

	it('202 with Retry-After → running (not degraded) with parsed seconds', () => {
		const outcome = mapResultResponse(202, {}, { 'retry-after': '8' });
		expect(outcome).toEqual({ kind: 'running', retryAfterSeconds: 8, degraded: false });
	});

	it('202 without Retry-After → running with the 5s degraded default', () => {
		const outcome = mapResultResponse(202, {}, {});
		expect(outcome).toEqual({
			kind: 'running',
			retryAfterSeconds: DEFAULT_DEGRADED_RETRY_SECONDS,
			degraded: false,
		});
	});

	it('202 with a non-numeric Retry-After → running with the default', () => {
		const outcome = mapResultResponse(202, {}, { 'retry-after': 'soon' });
		expect(outcome).toEqual({
			kind: 'running',
			retryAfterSeconds: DEFAULT_DEGRADED_RETRY_SECONDS,
			degraded: false,
		});
	});

	it('503 → running but flagged degraded (transient blip never fails a poller; loop bounds consecutive 503s)', () => {
		expect(mapResultResponse(503, {}, { 'retry-after': '10' })).toEqual({
			kind: 'running',
			retryAfterSeconds: 10,
			degraded: true,
		});
		expect(mapResultResponse(503, {}, {})).toEqual({
			kind: 'running',
			retryAfterSeconds: DEFAULT_DEGRADED_RETRY_SECONDS,
			degraded: true,
		});
	});

	it('403 → forbidden, leading with our guidance and appending the server detail', () => {
		const body = { detail: 'nope' };
		const outcome = mapResultResponse(403, body, {});
		expect(outcome).toEqual({
			kind: 'forbidden',
			message: `${FORBIDDEN_MESSAGE} (Server: nope)`,
			body,
		});
	});

	it('403 with no problem body → the bare actionable message', () => {
		expect(mapResultResponse(403, {}, {})).toEqual({
			kind: 'forbidden',
			message: FORBIDDEN_MESSAGE,
			body: {},
		});
	});

	it('200 with a null main_stuff → missingMainStuff, not an empty COMPLETED item', () => {
		// The completed-run invariant (pipelex >= 0.37): a 200 always carries a main
		// stuff. Emitting a bare `{status: "COMPLETED"}` item would push the failure
		// downstream. NOT terminal, though — it carries a retry hint, because the
		// platform relays a null artifact while the result is still mid-write.
		const body = { pipeline_run_id: 'r1', main_stuff: null };
		expect(mapResultResponse(200, body, {})).toEqual({
			kind: 'missingMainStuff',
			retryAfterSeconds: DEFAULT_DEGRADED_RETRY_SECONDS,
			body,
		});
		expect(mapResultResponse(200, { pipeline_run_id: 'r1' }, {})).toMatchObject({
			kind: 'missingMainStuff',
		});
	});

	it('honors an explicit Retry-After on the mid-write 200', () => {
		expect(mapResultResponse(200, { main_stuff: null }, { 'retry-after': '9' })).toMatchObject({
			kind: 'missingMainStuff',
			retryAfterSeconds: 9,
		});
	});

	it('MISSING_MAIN_STUFF_MESSAGE is only reported once the state has persisted', () => {
		// Wording guard: the message claims the node already waited, so it must not
		// be used for a first mid-write reading. RESULT_MID_WRITE_MESSAGE covers that.
		expect(MISSING_MAIN_STUFF_MESSAGE).toMatch(/even after waiting/);
		expect(RESULT_MID_WRITE_MESSAGE).toMatch(/still being written/);
	});

	it('withRunId appends the run id, and degrades gracefully without one', () => {
		// The message promises the caller a run id to report; interpolate it rather
		// than describing one that is only reachable through the attached body.
		expect(withRunId('boom', { pipeline_run_id: 'run-9' })).toBe('boom (Run: run-9)');
		expect(withRunId('boom', {})).toBe('boom');
		expect(withRunId('boom', { pipeline_run_id: '' })).toBe('boom');
	});

	it.each<[string, IDataObject['x']]>([
		['an empty list output', []],
		['a zero output', 0],
		['an empty-string output', ''],
		['a false output', false],
	])('200 with %s → completed (falsy is a VALID main_stuff, absence is not)', (_label, value) => {
		// The invariant must test for absence, never truthiness — a list pipe that
		// legitimately produced nothing would otherwise be reported as broken.
		const body = { pipeline_run_id: 'r1', main_stuff: value };
		expect(mapResultResponse(200, body, {})).toEqual({ kind: 'completed', body });
	});

	it('relays the usage artifacts the hosted route returns', () => {
		const body = {
			pipeline_run_id: 'r1',
			main_stuff: { answer: 7 },
			tokens_usages: [{ pipe_code: 'p', cost: 0.0012 }],
			usage_assembly_error: null,
		};
		const outcome = mapResultResponse(200, body, {});
		expect(outcome).toEqual({ kind: 'completed', body });
	});

	it('404 → notFound with the actionable message (bad run_id or non-hosted Base URL)', () => {
		const body = { detail: 'not found' };
		const outcome = mapResultResponse(404, body, {});
		expect(outcome).toEqual({ kind: 'notFound', message: NOT_FOUND_MESSAGE, body });
	});

	it('409 with a problem detail → failed using detail', () => {
		const body = { detail: 'Run finished with status FAILED; no result available' };
		const outcome = mapResultResponse(409, body, {});
		expect(outcome).toEqual({
			kind: 'failed',
			message: 'Run finished with status FAILED; no result available',
			body,
		});
	});

	it('409 falls back to title, then to a default message', () => {
		expect(mapResultResponse(409, { title: 'Conflict' }, {})).toMatchObject({
			kind: 'failed',
			message: 'Conflict',
		});
		expect(mapResultResponse(409, {}, {})).toMatchObject({
			kind: 'failed',
			message: 'Run finished with a non-completed status',
		});
	});

	it('other 5xx (502/504) → unexpected, not silently "running"', () => {
		expect(mapResultResponse(502, {}, {})).toMatchObject({ kind: 'unexpected', statusCode: 502 });
		expect(mapResultResponse(504, {}, {})).toMatchObject({ kind: 'unexpected', statusCode: 504 });
	});

	it('other non-2xx → unexpected, carries status code', () => {
		const body = { detail: 'boom' };
		const outcome = mapResultResponse(500, body, {});
		expect(outcome).toEqual({ kind: 'unexpected', statusCode: 500, message: 'boom', body });
	});

	it('unexpected falls back to a generic message when no detail/title', () => {
		const outcome = mapResultResponse(418, {}, {});
		expect(outcome).toMatchObject({
			kind: 'unexpected',
			statusCode: 418,
			message: 'Unexpected response status 418',
		});
	});
});

describe("roleRefusalMessage (a 403 that refuses the caller's role, not the credential)", () => {
	// The platform's refusal of a role, as an RFC 9457 problem: one code for every
	// role gate, and a `detail` each gate writes, naming the caller's actual role.
	const runnerRefused = {
		type: 'https://pipelex.com/errors/role_not_permitted',
		title: 'Role not permitted',
		status: 403,
		code: 'role_not_permitted',
		error_domain: 'config',
		retryable: false,
		detail:
			"Your role in this organization is runner: it runs the organization's published versions and changes no method.",
	};

	it('leads with the role-neutral headline, then the server detail as it is', () => {
		expect(ROLE_NOT_PERMITTED_MESSAGE).toBe('Your role in this organization does not allow this.');
		expect(roleRefusalMessage(runnerRefused)).toBe(
			"Your role in this organization does not allow this. Your role in this organization is runner: it runs the organization's published versions and changes no method.",
		);
	});

	it('shows a member refused an admin action the same way, assuming no role of its own', () => {
		const memberRefused = {
			...runnerRefused,
			detail: 'Your role in this organization is member: this action needs the admin role.',
		};
		expect(roleRefusalMessage(memberRefused)).toBe(
			`${ROLE_NOT_PERMITTED_MESSAGE} Your role in this organization is member: this action needs the admin role.`,
		);
	});

	it('is the headline alone when the server sends no detail', () => {
		expect(roleRefusalMessage({ code: 'role_not_permitted' })).toBe(ROLE_NOT_PERMITTED_MESSAGE);
		expect(roleRefusalMessage({ code: 'role_not_permitted', detail: '   ' })).toBe(
			ROLE_NOT_PERMITTED_MESSAGE,
		);
	});

	it('reads only the role_not_permitted code', () => {
		expect(roleRefusalMessage({ code: 'forbidden', detail: 'nope' })).toBeUndefined();
		expect(roleRefusalMessage({ detail: 'nope' })).toBeUndefined();
		expect(roleRefusalMessage({})).toBeUndefined();
	});

	it('never names a role, nor sends the person to Pipelex for access', () => {
		expect(ROLE_NOT_PERMITTED_MESSAGE).not.toMatch(/runner|member|admin/i);
		expect(ROLE_NOT_PERMITTED_MESSAGE).not.toMatch(/API access|discord|support/i);
		expect(roleRefusalMessage(runnerRefused)).not.toContain(FORBIDDEN_MESSAGE);
	});

	it('comes before the generic 403 on a result read', () => {
		expect(mapResultResponse(403, runnerRefused, {})).toEqual({
			kind: 'forbidden',
			message: roleRefusalMessage(runnerRefused),
			body: runnerRefused,
		});
	});

	it('comes before the generic 403 on an upload grant, keeping the file name', () => {
		const file = { inputName: 'document', filename: 'scan.pdf', size: 1024 };
		expect(uploadGrantRefusalMessage(403, runnerRefused, file)).toBe(
			`Pipelex refused to store "scan.pdf" for input "document". ${roleRefusalMessage(runnerRefused)}`,
		);
	});
});

describe('problemMessage (the text a platform error is shown with)', () => {
	// The hosted API's refusal of a malformed Method ID version suffix, as the
	// platform's validation handler renders it: the useful sentence is the field
	// error's, the `detail` only points at the list.
	const MALFORMED_SUFFIX = {
		type: 'https://docs.pipelex.com/errors/validation_failed',
		title: 'Validation failed',
		status: 422,
		code: 'validation_failed',
		detail: 'Request body failed validation. See `errors` for the per-field breakdown.',
		errors: [
			{
				field: 'method_id',
				code: 'malformed_version_suffix',
				detail:
					"method_id 'mt_abc' carries a version suffix that names no version. After the `@`, write a published version's number (a positive number without a leading zero, as in `@3`) or `draft` in lower case; leave the suffix out to name the latest published version.",
			},
		],
	};

	it("leads with the field errors, since a 422's detail only points at them", () => {
		expect(problemMessage(MALFORMED_SUFFIX)).toBe(
			"method_id: method_id 'mt_abc' carries a version suffix that names no version. After the `@`, write a published version's number (a positive number without a leading zero, as in `@3`) or `draft` in lower case; leave the suffix out to name the latest published version.",
		);
	});

	it('names each field, leaves a whole-request error unnamed, and ends every sentence', () => {
		const body = {
			detail: 'Request body failed validation.',
			errors: [
				{ field: 'inputs', code: 'dict_type', detail: 'Input should be a valid dictionary' },
				{ field: '<root>', code: 'value_error', detail: 'Provide pipe_code or method_id.' },
				{ field: 'output_name', code: 'string_too_long' },
			],
		};
		expect(problemMessage(body)).toBe(
			'inputs: Input should be a valid dictionary. Provide pipe_code or method_id. output_name: string_too_long.',
		);
	});

	it('skips field errors with nothing to say, and falls back to the detail when none is left', () => {
		const body = {
			detail: 'Request body failed validation.',
			errors: [{ field: 'method_id', detail: '  ' }, null, 'not an object'],
		};
		expect(problemMessage(body as unknown as IDataObject)).toBe('Request body failed validation.');
	});

	it('reads the two method-selector errors by their detail, which says what to do', () => {
		expect(
			problemMessage({
				title: 'Method not published',
				status: 409,
				code: 'method_not_published',
				detail:
					"Method 'mt_abc' has no published version. Address its draft as `mt_abc@draft`, or publish it first.",
			}),
		).toBe(
			"Method 'mt_abc' has no published version. Address its draft as `mt_abc@draft`, or publish it first.",
		);
		expect(
			problemMessage({
				title: 'Method version not found',
				status: 404,
				code: 'method_version_not_found',
				detail: "Method 'mt_abc' has no version 7.",
			}),
		).toBe("Method 'mt_abc' has no version 7.");
	});

	it('falls back to the title, then to nothing', () => {
		expect(problemMessage({ title: 'Conflict', errors: [] })).toBe('Conflict');
		expect(problemMessage({ errors: 'not a list' })).toBeUndefined();
	});
});

describe('runFailureMessage (recovering WHY a run failed)', () => {
	it('builds the message from the run row\'s stored error report', () => {
		// The real shape, taken from a Temporal failure the results 409 reduced to
		// "Run finished with status FAILED; no result available".
		const message =
			"Live run of PipeSequence 'build_client_quote': missing required inputs: illustrations. These optional inputs may be omitted: comments.";
		expect(
			runFailureMessage({ status: 'FAILED', error: { message, error_type: 'PipeRunInputsError' } }),
		).toBe(`Run FAILED: ${message} [PipeRunInputsError]`);
	});

	it('keeps the terminal status, which distinguishes a timeout from a failure', () => {
		expect(runFailureMessage({ status: 'TIMED_OUT', error: { message: 'took too long' } })).toBe(
			'Run TIMED_OUT: took too long',
		);
	});

	it('does not repeat an error_type already named in the message', () => {
		expect(
			runFailureMessage({
				status: 'FAILED',
				error: { message: 'PipeRunInputsError: bad inputs', error_type: 'PipeRunInputsError' },
			}),
		).toBe('Run FAILED: PipeRunInputsError: bad inputs');
	});

	it('returns undefined when there is no usable report, so the caller keeps its fallback', () => {
		expect(runFailureMessage({})).toBeUndefined();
		expect(runFailureMessage({ error: null })).toBeUndefined();
		expect(runFailureMessage({ error: {} })).toBeUndefined();
		expect(runFailureMessage({ error: { message: '' } })).toBeUndefined();
		expect(runFailureMessage({ error: 'boom' })).toBeUndefined();
		expect(runFailureMessage({ error: ['boom'] })).toBeUndefined();
	});

	it('defaults the status when the run read omits it', () => {
		expect(runFailureMessage({ error: { message: 'why' } })).toBe('Run FAILED: why');
	});
});

describe('runFailureDescription (the rest of the failure report)', () => {
	it('renders one labelled line — n8n collapses newlines in a description', () => {
		// A `\n`-joined block came out as a run-on sentence in the editor, with the
		// title running straight into the next label. Every fact carries its own
		// label and the separators survive collapsing.
		const description = runFailureDescription({
			pipeline_run_id: 'run-1',
			pipe_code: 'build_client_quote',
			finished_at: '2026-08-17T16:01:54Z',
			error: {
				message: 'missing required inputs: illustrations',
				error_type: 'PipeRunInputsError',
				error_domain: 'pipe_run',
				title: 'Pipe run inputs',
				type_uri: 'https://docs.pipelex.com/latest/errors/pipe-run-inputs-error/',
				retryable: false,
				user_action: { kind: 'change_input', detail: 'Provide the illustrations input' },
			},
		});

		expect(description).not.toContain('\n');
		expect(description?.split(' | ')).toEqual([
			'Pipe run inputs',
			// The action leads — the only fact that says what to DO.
			'What to do: change input — Provide the illustrations input',
			'Retryable: no (re-running will fail identically)',
			'Error: PipeRunInputsError · pipe_run',
			'Run: run-1',
			'Pipe: build_client_quote',
			'Finished: 2026-08-17T16:01:54Z',
			'Docs: https://docs.pipelex.com/latest/errors/pipe-run-inputs-error/',
		]);
	});

	it('never lets a nested list collide with the top-level separator', () => {
		// Sub-lists join with " · " precisely so they cannot be mistaken for facts.
		const description = runFailureDescription({
			error: { message: 'm', error_type: 'A', error_domain: 'B', error_category: 'C' },
		});
		expect(description).toBe('Error: A · B · C');
	});

	it('says plainly when retrying could help', () => {
		expect(runFailureDescription({ error: { message: 'rate limited', retryable: true } })).toBe(
			'Retryable: yes (re-running may succeed)',
		);
	});

	it('reports provider and model for an inference failure', () => {
		expect(
			runFailureDescription({
				error: { message: 'bad model', provider: 'openai', model: 'gpt-4o' },
			}),
		).toBe('Model: openai / gpt-4o');
	});

	it('counts structured validation errors', () => {
		expect(
			runFailureDescription({
				error: { message: 'invalid', validation_errors: [{ category: 'dry_run' }, {}] },
			}),
		).toBe('Validation errors: 2');
	});

	it('emits nothing rather than a skeleton when the report is bare', () => {
		// An older report may carry only a message — already the headline, so there
		// is no description to add.
		expect(runFailureDescription({ error: { message: 'just a message' } })).toBeUndefined();
		expect(runFailureDescription({})).toBeUndefined();
		expect(runFailureDescription({ error: null })).toBeUndefined();
	});

	it('ignores blank and non-string fields instead of printing empty labels', () => {
		expect(
			runFailureDescription({ error: { message: 'm', title: '   ', error_type: 42 } }),
		).toBeUndefined();
	});
});

describe('runFailureData (the "Error data" row — rendered in <pre>, so multi-line)', () => {
	const REPORT = {
		pipeline_run_id: 'run-1',
		pipe_code: 'build_client_quote',
		status: 'FAILED',
		finished_at: '2026-08-17T16:01:54Z',
		error: {
			message: 'missing required inputs: illustrations',
			error_type: 'PipeRunInputsError',
			title: 'Pipe run inputs',
			type_uri: 'https://docs.pipelex.com/latest/errors/pipe-run-inputs-error/',
		},
	};

	it('emits an aligned key/value block in a stable, readable order', () => {
		const block = runFailureData(REPORT);
		const keys = (block ?? '').split('\n').map((line) => line.split(/\s{2,}/)[0]);
		// Curated order: what it is → why → where. Not object order.
		expect(keys).toEqual([
			'title',
			'message',
			'error_type',
			'type_uri',
			'pipeline_run_id',
			'pipe_code',
			'status',
			'finished_at',
		]);
		// Aligned: every value starts at the same column.
		const columns = (block ?? '')
			.split('\n')
			.filter((line) => !line.startsWith(' '))
			.map((line) => line.indexOf(line.trimStart().split(/\s{2,}/)[1] ?? ''));
		expect(new Set(columns).size).toBe(1);
	});

	it('keeps newlines — this row is the one surface that preserves them', () => {
		expect(runFailureData(REPORT)).toContain('\n');
	});

	it('never drops a report field this node does not know about', () => {
		// A new ErrorReport field must show up without a node release.
		const block = runFailureData({
			error: { message: 'm', a_brand_new_field: 'surprise' },
		});
		expect(block).toContain('a_brand_new_field');
		expect(block).toContain('surprise');
	});

	it('renders nested values as indented JSON rather than [object Object]', () => {
		const block = runFailureData({
			error: { message: 'm', user_action: { kind: 'change_input', detail: 'fix it' } },
		});
		expect(block).not.toContain('[object Object]');
		expect(block).toContain('"kind": "change_input"');
	});

	it('returns undefined when there is no report at all', () => {
		expect(runFailureData({})).toBeUndefined();
		expect(runFailureData({ error: null })).toBeUndefined();
		expect(runFailureData({ error: 'boom' })).toBeUndefined();
	});

	it('skips empty values instead of printing bare labels', () => {
		const block = runFailureData({ error: { message: 'm', title: '', model: null } });
		expect(block).toBe('message  m');
	});
});

describe('idempotencyKey with uploaded files', () => {
	it('is the bare key when the body carries no uploaded file', () => {
		expect(idempotencyKey('exec-abc', 'node-1', 0, 0, [])).toBe('exec-abc:node-1:0:0');
	});

	it('covers the uploaded references, so a retry that re-uploads never collides with the first attempt', () => {
		// The platform answers a reused key with a different body with a 409. Every
		// attempt uploads afresh, so its references — and its body — differ.
		const first = idempotencyKey('exec-abc', 'node-1', 0, 0, ['document=pipelex-storage://a.pdf']);
		const retry = idempotencyKey('exec-abc', 'node-1', 0, 0, ['document=pipelex-storage://b.pdf']);
		expect(first).toMatch(/^exec-abc:node-1:0:0:files-[0-9a-f]{32}$/);
		expect(retry).not.toBe(first);
	});

	it('does not depend on the order the files were uploaded in', () => {
		const refs = ['invoice=pipelex-storage://a.pdf', 'receipt=pipelex-storage://b.png'];
		expect(idempotencyKey('e', 'n', 0, 0, refs)).toBe(idempotencyKey('e', 'n', 0, 0, [...refs].reverse()));
	});

	it('pairs each reference with its input', () => {
		expect(
			storedFileReferences({
				document: { url: 'pipelex-storage://a.pdf', filename: 'a.pdf' },
			}),
		).toEqual(['document=pipelex-storage://a.pdf']);
	});
});

describe('readBinaryInputMappings (the Binary Inputs rows)', () => {
	it('reads each row as an input name and the binary field that fills it', () => {
		expect(
			readBinaryInputMappings({
				input: [
					{ name: 'document', binaryPropertyName: 'attachment_0' },
					{ name: ' photo ', binaryPropertyName: ' data ' },
				],
			}),
		).toEqual({
			mappings: [
				{ inputName: 'document', binaryPropertyName: 'attachment_0' },
				{ inputName: 'photo', binaryPropertyName: 'data' },
			],
		});
	});

	it('reads an empty or absent collection as no binary inputs', () => {
		expect(readBinaryInputMappings({})).toEqual({ mappings: [] });
		expect(readBinaryInputMappings(undefined)).toEqual({ mappings: [] });
		expect(readBinaryInputMappings({ input: 'not rows' })).toEqual({ mappings: [] });
	});

	it('drops a row whose input name is blank (the editor persists a row on add)', () => {
		expect(
			readBinaryInputMappings({ input: [{ name: '   ', binaryPropertyName: 'data' }, {}] }),
		).toEqual({ mappings: [] });
	});

	it('falls back to the "data" field when the stored row has none', () => {
		expect(readBinaryInputMappings({ input: [{ name: 'document' }] }).mappings).toEqual([
			{ inputName: 'document', binaryPropertyName: 'data' },
		]);
	});

	it('refuses a binary field explicitly cleared, rather than guessing one', () => {
		const { error } = readBinaryInputMappings({
			input: [{ name: 'document', binaryPropertyName: '  ' }],
		});
		expect(error).toContain('Binary input "document" names no binary field');
	});

	it('refuses an input named twice, instead of silently keeping one file', () => {
		const { error } = readBinaryInputMappings({
			input: [
				{ name: 'document', binaryPropertyName: 'attachment_0' },
				{ name: 'document', binaryPropertyName: 'attachment_1' },
			],
		});
		expect(error).toContain('Binary input "document" is listed more than once');
	});
});

describe('binaryInputConflictError (no precedence between Inputs and Binary Inputs)', () => {
	const mappings = [{ inputName: 'document', binaryPropertyName: 'data' }];

	it('refuses an input given both ways', () => {
		expect(binaryInputConflictError(mappings, { document: { url: 'https://x/y.pdf' } })).toContain(
			'Input "document" is set twice',
		);
	});

	it('accepts disjoint inputs', () => {
		expect(binaryInputConflictError(mappings, { language: 'fr' })).toBeNull();
	});
});

describe('missingBinaryMessage', () => {
	const mapping = { inputName: 'document', binaryPropertyName: 'data' };

	it('names the binary fields the item does carry', () => {
		expect(missingBinaryMessage(mapping, ['attachment_0', 'attachment_1'])).toBe(
			'Binary input "document" reads the binary field "data", but this item has no such field. Its binary fields are: attachment_0, attachment_1.',
		);
	});

	it('says when the item carries no binary data at all', () => {
		expect(missingBinaryMessage(mapping, [])).toContain('It carries no binary data at all');
	});
});

describe('describeBinaryFile (the name and type a binary is stored under)', () => {
	const binary = (fields: Partial<IBinaryData>): IBinaryData =>
		({ data: '', mimeType: '', ...fields }) as IBinaryData;

	it('keeps the file name and MIME type n8n carries', () => {
		expect(describeBinaryFile(binary({ fileName: 'invoice.pdf', mimeType: 'application/pdf' }))).toEqual({
			filename: 'invoice.pdf',
			contentType: 'application/pdf',
		});
	});

	it('asks the extension when n8n typed the file as unknown', () => {
		for (const mimeType of ['', 'application/octet-stream']) {
			expect(describeBinaryFile(binary({ fileName: 'scan.PNG', mimeType })).contentType).toBe(
				'image/png',
			);
		}
	});

	it('keeps octet-stream when neither n8n nor the extension knows the type', () => {
		expect(
			describeBinaryFile(binary({ fileName: 'blob.xyz', mimeType: 'application/octet-stream' })),
		).toEqual({ filename: 'blob.xyz', contentType: 'application/octet-stream' });
	});

	it('names a nameless file as the SDK does, keeping a known extension', () => {
		expect(describeBinaryFile(binary({ fileExtension: 'pdf', mimeType: 'application/pdf' })).filename).toBe(
			'upload.pdf',
		);
		// n8n's MIME type names the extension when n8n kept none.
		expect(describeBinaryFile(binary({ mimeType: 'application/pdf' })).filename).toBe('upload.pdf');
		expect(describeBinaryFile(binary({ mimeType: 'application/octet-stream' })).filename).toBe('upload.bin');
		expect(describeBinaryFile(binary({ mimeType: 'application/x-unknown' })).filename).toBe('upload.bin');
	});

	it("gives a name without an extension n8n's fileExtension, and types it from that", () => {
		// A Drive export or a mail attachment named "Invoice", typed octet-stream:
		// before, it was stored without an extension and with no mime_type.
		expect(
			describeBinaryFile(
				binary({ fileName: 'Invoice', fileExtension: 'pdf', mimeType: 'application/octet-stream' }),
			),
		).toEqual({ filename: 'Invoice.pdf', contentType: 'application/pdf' });
		expect(describeBinaryFile(binary({ fileName: 'scan', fileExtension: '.PNG', mimeType: '' }))).toEqual({
			filename: 'scan.PNG',
			contentType: 'image/png',
		});
	});

	it("gives a name without an extension the one of n8n's MIME type, keeping that type", () => {
		expect(describeBinaryFile(binary({ fileName: 'Invoice', mimeType: 'application/pdf' }))).toEqual({
			filename: 'Invoice.pdf',
			contentType: 'application/pdf',
		});
		expect(describeBinaryFile(binary({ fileName: 'photo', mimeType: 'image/jpeg; q=1' }))).toEqual({
			filename: 'photo.jpg',
			contentType: 'image/jpeg; q=1',
		});
	});

	it('leaves a name that has an extension, or that no source can extend, as n8n gave it', () => {
		expect(
			describeBinaryFile(binary({ fileName: 'report.final', fileExtension: 'pdf', mimeType: 'application/pdf' }))
				.filename,
		).toBe('report.final');
		expect(describeBinaryFile(binary({ fileName: 'Invoice', mimeType: 'application/octet-stream' }))).toEqual({
			filename: 'Invoice',
			contentType: 'application/octet-stream',
		});
	});
});

describe('binaryFieldNames (what a missing-field message lists)', () => {
	const file = { data: 'JVBERg==', mimeType: 'application/pdf' };

	it('lists the fields under item.binary, the separate binary mode', () => {
		expect(binaryFieldNames({ json: {}, binary: { attachment_0: file, attachment_1: file } })).toEqual([
			'attachment_0',
			'attachment_1',
		]);
	});

	it("lists the binary values at the top of the item's JSON, the combined binary mode", () => {
		expect(
			binaryFieldNames({
				json: { subject: 'Invoice', data: file, stored: { id: 'filesystem-v2:abc', mimeType: 'image/png' }, n: 3 },
			}),
		).toEqual(['data', 'stored']);
	});

	it('lists nothing for an item with no file, or no item', () => {
		expect(binaryFieldNames({ json: { subject: 'Invoice' } })).toEqual([]);
		expect(binaryFieldNames(undefined)).toEqual([]);
	});
});

describe('binaryByteSize (a file measured without loading it)', () => {
	const binary = (fields: Partial<IBinaryData>): IBinaryData =>
		({ data: '', mimeType: 'application/pdf', ...fields }) as IBinaryData;

	it('prefers the bytes n8n recorded when it stored the binary', async () => {
		const getMetadata = vi.fn();
		expect(await binaryByteSize(binary({ bytes: 1234, id: 'filesystem-v2:a' }), getMetadata)).toBe(1234);
		expect(getMetadata).not.toHaveBeenCalled();
	});

	it("asks n8n's metadata for a binary kept outside memory", async () => {
		const getMetadata = vi.fn(async () => ({ fileSize: 4321 }));
		expect(await binaryByteSize(binary({ id: 'filesystem-v2:a', data: 'filesystem-v2' }), getMetadata)).toBe(4321);
		expect(getMetadata).toHaveBeenCalledWith('filesystem-v2:a');
	});

	it('answers nothing when that metadata is missing, fails or is not a size', async () => {
		const stored = binary({ id: 'filesystem-v2:a', data: 'filesystem-v2' });
		expect(await binaryByteSize(stored, undefined)).toBeUndefined();
		expect(await binaryByteSize(stored, async () => Promise.reject(new Error('gone')))).toBeUndefined();
		expect(await binaryByteSize(stored, async () => ({ fileSize: Number.NaN }))).toBeUndefined();
	});

	it('measures the base64 of a binary kept in memory without decoding it', async () => {
		const bytes = Buffer.from('%PDF-1.7 a fake invoice');
		expect(await binaryByteSize(binary({ data: bytes.toString('base64') }), undefined)).toBe(bytes.length);
		expect(await binaryByteSize(binary({ data: '' }), undefined)).toBe(0);
	});
});

describe('binarySizeError (the sizes the node does not send)', () => {
	const subject = { inputName: 'document', binaryPropertyName: 'data', filename: 'scan.pdf' };

	it('refuses an empty file and one over the 50 MiB limit, and nothing in between', () => {
		expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
		expect(binarySizeError(subject, 0)).toBe(
			'The file "scan.pdf" in binary field "data" for input "document" is empty (0 bytes), so there is nothing to give the method. Check the node that produced it.',
		);
		expect(binarySizeError(subject, 1)).toBeNull();
		expect(binarySizeError(subject, MAX_UPLOAD_BYTES)).toBeNull();
		expect(binarySizeError(subject, MAX_UPLOAD_BYTES + 1)).toBe(
			'The file "scan.pdf" in binary field "data" for input "document" is 52428801 bytes, over the 50 MiB Pipelex accepts for one file, so it was not uploaded. Pass a smaller file.',
		);
	});
});

describe('storedFileInput (the value a binary-fed input takes)', () => {
	it('is the compact Document/Image content: url, filename and mime_type', () => {
		expect(storedFileInput('pipelex-storage://a.pdf', 'a.pdf', 'application/pdf')).toEqual({
			url: 'pipelex-storage://a.pdf',
			filename: 'a.pdf',
			mime_type: 'application/pdf',
		});
	});

	it('leaves mime_type out when the type is unknown, rather than asserting octet-stream', () => {
		expect(storedFileInput('pipelex-storage://a.bin', 'a.bin', 'application/octet-stream')).toEqual({
			url: 'pipelex-storage://a.bin',
			filename: 'a.bin',
		});
	});
});

describe('readUploadGrant (the answer of POST /v1/upload/grant)', () => {
	const grant = {
		uri: 'pipelex-storage://orgs/o/assets/f.pdf',
		url: 'https://bucket.s3.amazonaws.com/orgs/o/assets/f.pdf?X-Amz-Signature=x',
		headers: { 'If-None-Match': '*', 'Content-Type': 'application/pdf' },
		expires_at: '2026-09-28T12:05:00Z',
		max_bytes: 52428800,
	};

	it('reads a grant', () => {
		expect(readUploadGrant(grant)).toEqual(grant);
	});

	it('refuses a grant whose reference is not a storage reference', () => {
		expect(readUploadGrant({ ...grant, uri: 'https://elsewhere/f.pdf' })).toBeUndefined();
	});

	it('refuses a URL the node must not send a file to', () => {
		for (const url of ['/relative/path', 'ftp://bucket/f', 'https://user:pass@bucket/f', 'not a url']) {
			expect(readUploadGrant({ ...grant, url }), url).toBeUndefined();
		}
	});

	it('refuses headers that are not strings, and a body that is not an object', () => {
		expect(readUploadGrant({ ...grant, headers: { 'Content-Length': 12 } })).toBeUndefined();
		expect(readUploadGrant({ ...grant, headers: null })).toBeUndefined();
		expect(readUploadGrant('grant')).toBeUndefined();
		expect(readUploadGrant(null)).toBeUndefined();
	});
});

describe('uploadGrantRefusalMessage (after the SDK mapUploadError)', () => {
	const file = { inputName: 'document', filename: 'scan.pdf', size: 73400320 };

	it('reads a 413 as a file over the limit, with the server detail', () => {
		expect(
			uploadGrantRefusalMessage(413, { detail: 'Declared file size exceeds the 50 MiB limit.' }, file),
		).toBe(
			'The file "scan.pdf" for input "document" is too large for Pipelex (73400320 bytes). (Server: Declared file size exceeds the 50 MiB limit.)',
		);
	});

	it('reads a 404 as a Base URL without the upload route', () => {
		expect(uploadGrantRefusalMessage(404, {}, file)).toBe(UPLOAD_UNAVAILABLE_MESSAGE);
	});

	it('reads a 401 and a 403 as authorization failures', () => {
		expect(uploadGrantRefusalMessage(401, {}, file)).toContain('did not accept the credential');
		expect(uploadGrantRefusalMessage(403, {}, file)).toContain('refused to store "scan.pdf"');
	});

	it('advises a retry on a server fault only', () => {
		expect(uploadGrantRefusalMessage(502, {}, file)).toContain('Retry the item.');
		expect(uploadGrantRefusalMessage(422, { detail: 'bad content type' }, file)).toBe(
			'Pipelex could not prepare the upload of "scan.pdf" for input "document" (HTTP 422). (Server: bad content type)',
		);
	});
});

describe('parseStorageError + storageRefusalMessage (after the SDK uploadWithGrant)', () => {
	const file = { inputName: 'document', filename: 'scan.pdf' };
	const s3 = (code: string, message: string) =>
		`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>r</RequestId></Error>`;

	it("reads S3's code and message and nothing else", () => {
		expect(parseStorageError(s3('AccessDenied', 'Request has expired &amp; is gone'))).toEqual({
			code: 'AccessDenied',
			message: 'Request has expired & is gone',
		});
		expect(parseStorageError('')).toEqual({});
		expect(parseStorageError(undefined)).toEqual({});
	});

	it('classifies each refusal the SDK names', () => {
		const message = (status: number, body: string) =>
			storageRefusalMessage(status, parseStorageError(body), file);
		expect(message(412, s3('PreconditionFailed', 'At least one of the pre-conditions failed'))).toContain(
			'the upload grant was already used',
		);
		expect(message(403, s3('SignatureDoesNotMatch', 'no match'))).toContain(
			'differs from what the upload grant signed',
		);
		expect(message(403, s3('AccessDenied', 'Request has expired'))).toContain('grant expired');
		expect(message(403, s3('AccessDenied', 'There were headers present in the request which were not signed'))).toContain(
			'did not sign',
		);
		expect(message(400, s3('RequestTimeout', 'Your socket connection timed out'))).toContain(
			'stopped waiting for the bytes',
		);
		expect(message(409, s3('ConditionalRequestConflict', 'conflict'))).toContain(
			'whether the file was stored is unknown',
		);
		expect(message(307, '')).toContain('the redirect was refused');
		expect(message(400, s3('EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size.'))).toBe(
			'Storage refused the upload of "scan.pdf" for input "document" (400 EntityTooLarge): Your proposed upload exceeds the maximum allowed size. Retry the item.',
		);
		expect(message(500, s3('InternalError', 'We encountered an internal error.'))).toBe(
			'Storage failed to store "scan.pdf" for input "document" (500 InternalError): We encountered an internal error. Whether the file was stored is unknown; retry the item.',
		);
	});
});

describe('describeNetworkFailure (never the runtime message, which can hold the grant URL)', () => {
	it('keeps the names and codes along the cause chain', () => {
		const cause = Object.assign(new Error('getaddrinfo ENOTFOUND bucket'), { code: 'ENOTFOUND' });
		const error = Object.assign(new TypeError('fetch failed https://bucket/?X-Amz-Signature=s', { cause }), {});
		expect(describeNetworkFailure(error)).toBe('TypeError, caused by Error ENOTFOUND');
	});

	it('drops a code that is not a bare identifier', () => {
		const error = Object.assign(new Error('x'), { code: 'https://bucket/?X-Amz-Signature=s' });
		expect(describeNetworkFailure(error)).toBe('Error');
		expect(describeNetworkFailure('not an error')).toBe('a non-Error rejection');
	});
});

describe('isTimeoutFailure (out of time once storage could be receiving)', () => {
	it("reads axios's own timeout codes as out of time", () => {
		expect(isTimeoutFailure(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))).toBe(true);
		expect(isTimeoutFailure(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
	});

	it('reads a connection that never opened as unreachable, wherever axios put the syscall', () => {
		// A wrapper that lifts the cause's fields onto the error.
		expect(isTimeoutFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT', syscall: 'connect' }))).toBe(false);
		// axios itself (1.15 and 1.18) keeps them on the cause.
		const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect' });
		expect(isTimeoutFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT', cause }))).toBe(false);
	});

	it('reads any other failure as not a timeout', () => {
		expect(isTimeoutFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(false);
		expect(isTimeoutFailure(undefined)).toBe(false);
	});
});

describe('eitherSignal (the PUT aborts on the cancel signal or its deadline)', () => {
	afterEach(() => vi.restoreAllMocks());

	it('aborts when either signal does', () => {
		for (const which of [0, 1]) {
			const controllers = [new AbortController(), new AbortController()];
			const { signal } = eitherSignal(controllers[0].signal, controllers[1].signal);
			expect(signal.aborted).toBe(false);
			controllers[which].abort('why');
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toBe('why');
		}
	});

	it('links by hand on a Node without AbortSignal.any, and unlinks after the request', () => {
		const original = (AbortSignal as { any?: unknown }).any;
		(AbortSignal as { any?: unknown }).any = undefined;
		try {
			const cancel = new AbortController();
			const deadline = new AbortController();
			const removed = vi.spyOn(cancel.signal, 'removeEventListener');
			const linked = eitherSignal(cancel.signal, deadline.signal);
			deadline.abort('late');
			expect(linked.signal.aborted).toBe(true);
			expect(linked.signal.reason).toBe('late');
			linked.unlink();
			expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));

			const already = new AbortController();
			already.abort('done');
			expect(eitherSignal(already.signal, new AbortController().signal).signal.aborted).toBe(true);
		} finally {
			(AbortSignal as { any?: unknown }).any = original;
		}
	});
});

describe('guessContentType + uploadTimeoutMs (replicated from the SDK)', () => {
	it("maps the SDK's extensions, case-insensitively, and nothing else", () => {
		expect(guessContentType('a.PDF')).toBe('application/pdf');
		expect(guessContentType('a.jpeg')).toBe('image/jpeg');
		expect(guessContentType('a.docx')).toBe('application/octet-stream');
		expect(guessContentType('noextension')).toBe('application/octet-stream');
		expect(guessContentType('trailing.')).toBe('application/octet-stream');
	});

	it('names the extension of a MIME type the table knows, for a name that has none', () => {
		expect(extensionForContentType('application/pdf')).toBe('pdf');
		expect(extensionForContentType('IMAGE/JPEG; charset=binary')).toBe('jpg');
		expect(extensionForContentType('application/octet-stream')).toBeUndefined();
		expect(extensionForContentType('application/vnd.ms-excel')).toBeUndefined();
		expect(extensionForContentType('')).toBeUndefined();
	});

	it('allows a minute plus a second per started 128 KiB', () => {
		expect(uploadTimeoutMs(0)).toBe(60_000);
		expect(uploadTimeoutMs(1)).toBe(61_000);
		expect(uploadTimeoutMs(128 * 1024 + 1)).toBe(62_000);
		expect(uploadTimeoutMs(50 * 1024 * 1024)).toBe(460_000);
	});
});
