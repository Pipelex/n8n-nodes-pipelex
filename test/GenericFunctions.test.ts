import type { IDataObject } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import {
	FORBIDDEN_MESSAGE,
	MISSING_MAIN_STUFF_MESSAGE,
	NOT_FOUND_MESSAGE,
	RESULT_MID_WRITE_MESSAGE,
	assembleRunSources,
	buildApiConnection,
	buildStartBody,
	idempotencyKey,
	mapResultResponse,
	runFailureData,
	runFailureDescription,
	runFailureMessage,
	runSourceError,
	withRunId,
} from '../nodes/Pipelex/GenericFunctions';
import { DEFAULT_DEGRADED_RETRY_SECONDS, parseRetryAfter } from '../nodes/Pipelex/PipelexApiShapes';

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

	it('maps mthds_contents only and drops nothing', () => {
		const body = buildStartBody({ mthdsContents: ['bundle-1', 'bundle-2'] });
		expect(body).toEqual({ mthds_contents: ['bundle-1', 'bundle-2'] });
	});

	it('allows both pipe_code and mthds_contents (a bundle + a chosen pipe)', () => {
		const body = buildStartBody({ pipeCode: 'p', mthdsContents: ['b'] });
		expect(body.pipe_code).toBe('p');
		expect(body.mthds_contents).toEqual(['b']);
	});

	it('maps method_id (hosted stored-method extension)', () => {
		const body = buildStartBody({ methodId: 'method-42' });
		expect(body).toEqual({ method_id: 'method-42' });
	});

	it('passes method_id + mthds_contents through together (hosted precedence rule: inline runs)', () => {
		const body = buildStartBody({ methodId: 'm', mthdsContents: ['b'] });
		expect(body.method_id).toBe('m');
		expect(body.mthds_contents).toEqual(['b']);
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

	it('omits empty strings and empty arrays', () => {
		const body = buildStartBody({
			pipeCode: '',
			methodId: '',
			mthdsContents: [],
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

	it('maps a method bundle to files (custom PipeFunc Python travels with the run)', () => {
		const files = { 'main.mthds': 'domain = "d"', 'funcs/f.py': 'def go(): ...' };
		const body = buildStartBody({ files });
		expect(body).toEqual({ files });
	});

	it('drops an empty files map entirely (it carries no method)', () => {
		const body = buildStartBody({ pipeCode: 'p', files: {} });
		expect(body).toEqual({ pipe_code: 'p' });
	});
});

describe('assembleRunSources (inline method + custom Python travel together)', () => {
	const NONE = { mthdsContents: [], pythonFiles: {} };

	it('leaves inline contents alone when there is no bundle', () => {
		expect(assembleRunSources({ ...NONE, mthdsContents: ['bundle'] })).toEqual({
			mthdsContents: ['bundle'],
		});
	});

	it('folds inline contents into the bundle when Python is attached', () => {
		// The point of the whole helper: `mthds_contents` is mutually exclusive with
		// a bundle, so without folding, "paste the method + attach Python" would be
		// rejected and the user would have to re-type the method as a file row.
		const result = assembleRunSources({
			...NONE,
			mthdsContents: ['domain = "d"'],
			pythonFiles: { 'funcs/score.py': 'def score(): ...' },
		});
		expect(result).toEqual({
			mthdsContents: [],
			files: { 'main.mthds': 'domain = "d"', 'funcs/score.py': 'def score(): ...' },
		});
	});

	it('names multiple inline bundles deterministically', () => {
		const result = assembleRunSources({
			...NONE,
			mthdsContents: ['one', 'two', 'three'],
			pythonFiles: { 'f.py': 'x' },
		});
		expect(Object.keys(result.files ?? {}).sort()).toEqual([
			'bundle-2.mthds',
			'bundle-3.mthds',
			'f.py',
			'main.mthds',
		]);
		expect(result.files?.['main.mthds']).toBe('one');
		expect(result.files?.['bundle-2.mthds']).toBe('two');
	});

	it('never lets a generated name clobber a Python path', () => {
		// Contrived, but the collision is real: a user could name a Python file
		// `main.mthds`. The generated name must step aside rather than overwrite.
		const result = assembleRunSources({
			mthdsContents: ['inline'],
			pythonFiles: { 'main.mthds': 'theirs' },
		});
		expect(result.files?.['main.mthds']).toBe('theirs');
		expect(Object.values(result.files ?? {})).toContain('inline');
	});

	it('rejects Python with no method, saying what to do', () => {
		// Python alone is not runnable; the runner answers 422. Catch it locally.
		const result = assembleRunSources({
			...NONE,
			pythonFiles: { 'funcs/a.py': 'a' },
		});
		expect(result.error).toMatch(/needs the method/);
		expect(result.error).toMatch(/MTHDS Bundles/);
		expect(result.error).toMatch(/Method ID/);
	});

	it.each([
		['/etc/passwd', /absolute/],
		['../escape.py', /escapes the bundle root/],
		['funcs\\score.py', /backslashes/],
		['C:funcs.py', /contains ":"/],
	])('rejects the unsafe path %s locally', (path, expected) => {
		const result = assembleRunSources({
			mthdsContents: ['m'],
			pythonFiles: { [path]: 'x' },
		});
		expect(result.error).toMatch(expected);
	});

	it('accepts nested forward-slash paths', () => {
		const result = assembleRunSources({
			mthdsContents: ['m'],
			pythonFiles: { 'structures/models/invoice.py': 'x' },
		});
		expect(result.error).toBeUndefined();
		expect(result.files?.['structures/models/invoice.py']).toBe('x');
	});

	it('produces a body that passes the run-source rules', () => {
		// End-to-end invariant: whatever the assembler emits must be legal, or the
		// user gets a confusing "cannot be combined" error for something the node
		// itself built.
		const assembled = assembleRunSources({
			...NONE,
			mthdsContents: ['m'],
			pythonFiles: { 'f.py': 'x' },
		});
		const body = buildStartBody({
			mthdsContents: assembled.mthdsContents,
			files: assembled.files,
		});
		expect(runSourceError(body)).toBeNull();
		expect(body).not.toHaveProperty('mthds_contents');
	});
});

describe('runSourceError (ports mthds/protocol assertExclusiveRunSources)', () => {
	it.each([
		['pipe_code alone', { pipe_code: 'p' }],
		['mthds_contents alone', { mthds_contents: ['b'] }],
		['method_id alone', { method_id: 'm' }],
		['an assembled bundle alone (it carries its own .mthds)', { files: { 'a.mthds': 'x' } }],
		['method_id + pipe_code (pick a pipe inside the stored method)', { method_id: 'm', pipe_code: 'p' }],
		['pipe_code + mthds_contents (a bundle plus a chosen pipe)', { pipe_code: 'p', mthds_contents: ['b'] }],
	])('accepts %s', (_label, body) => {
		expect(runSourceError(body)).toBeNull();
	});

	it('rejects a stored method together with an inline one', () => {
		// The hosted API would accept this and treat method_id as run-history
		// linkage; the node refuses it so "what does this node run?" has one answer.
		expect(runSourceError({ method_id: 'm', mthds_contents: ['b'] })).toMatch(/Choose one/);
		expect(runSourceError({ method_id: 'm', files: { 'a.mthds': 'x' } })).toMatch(/Choose one/);
	});

	it('rejects a bundle sent together with mthds_contents (backstop — assembly prevents it)', () => {
		// Unreachable through the node: `assembleRunSources` folds the pasted
		// contents INTO the bundle so the two never travel together. Kept because
		// the failure mode is the method on the wire twice and an opaque 422.
		expect(runSourceError({ files: { 'a.mthds': 'x' }, mthds_contents: ['b'] })).toMatch(
			/cannot be sent together/,
		);
	});

	it('rejects a body with no run source at all', () => {
		expect(runSourceError({})).toMatch(/Nothing to run/);
		expect(runSourceError({ inputs: { a: 1 } })).toMatch(/Nothing to run/);
	});

	it('does not count an empty mthds_contents as a source', () => {
		expect(runSourceError({ mthds_contents: [] })).toMatch(/Nothing to run/);
	});
});

describe('idempotencyKey', () => {
	it('joins execution id, node id, and item index', () => {
		expect(idempotencyKey('exec-abc', 'node-1', 0)).toBe('exec-abc:node-1:0');
		expect(idempotencyKey('exec-abc', 'node-1', 7)).toBe('exec-abc:node-1:7');
	});

	it('differs across nodes in the same execution + item (no collision)', () => {
		expect(idempotencyKey('exec-abc', 'node-1', 0)).not.toBe(
			idempotencyKey('exec-abc', 'node-2', 0),
		);
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
