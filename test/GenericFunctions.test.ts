import { describe, expect, it } from 'vitest';

import {
	FORBIDDEN_MESSAGE,
	buildStartBody,
	idempotencyKey,
	mapResultResponse,
} from '../nodes/Pipelex/GenericFunctions';

describe('buildStartBody', () => {
	it('maps pipe_code only', () => {
		const body = buildStartBody({ pipeCode: 'my-pipe', inputs: { a: 1 } });
		expect(body).toEqual({ pipe_code: 'my-pipe', inputs: { a: 1 } });
	});

	it('maps mthds_contents only and drops nothing', () => {
		const body = buildStartBody({ mthdsContents: ['bundle-1', 'bundle-2'] });
		expect(body).toEqual({ mthds_contents: ['bundle-1', 'bundle-2'] });
	});

	it('allows both pipe_code and mthds_contents (XOR not enforced here)', () => {
		const body = buildStartBody({ pipeCode: 'p', mthdsContents: ['b'] });
		expect(body.pipe_code).toBe('p');
		expect(body.mthds_contents).toEqual(['b']);
	});

	it('forwards method_id', () => {
		const body = buildStartBody({ pipeCode: 'p', methodId: 'method-42' });
		expect(body.method_id).toBe('method-42');
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

describe('mapResultResponse', () => {
	it('200 → completed, passes the body through', () => {
		const body = { pipeline_run_id: 'r1', main_stuff: { x: 1 }, graph_spec: { nodes: [] } };
		const outcome = mapResultResponse(200, body, {});
		expect(outcome).toEqual({ kind: 'completed', body });
	});

	it('202 with Retry-After → running with parsed seconds', () => {
		const outcome = mapResultResponse(202, {}, { 'retry-after': '5' });
		expect(outcome).toEqual({ kind: 'running', retryAfterSeconds: 5 });
	});

	it('202 with title-cased Retry-After header → running with parsed seconds', () => {
		const outcome = mapResultResponse(202, {}, { 'Retry-After': '12' });
		expect(outcome).toEqual({ kind: 'running', retryAfterSeconds: 12 });
	});

	it('202 without Retry-After → running, no seconds', () => {
		const outcome = mapResultResponse(202, {}, {});
		expect(outcome).toEqual({ kind: 'running', retryAfterSeconds: undefined });
	});

	it('202 with a non-numeric Retry-After → running, no seconds', () => {
		const outcome = mapResultResponse(202, {}, { 'retry-after': 'soon' });
		expect(outcome).toEqual({ kind: 'running', retryAfterSeconds: undefined });
	});

	it('502/503/504 → transient (gateway outage, not in-flight)', () => {
		expect(mapResultResponse(503, {}, { 'retry-after': '10' })).toEqual({
			kind: 'transient',
			statusCode: 503,
			retryAfterSeconds: 10,
		});
		expect(mapResultResponse(502, {}, {})).toEqual({
			kind: 'transient',
			statusCode: 502,
			retryAfterSeconds: undefined,
		});
		expect(mapResultResponse(504, {}, {})).toMatchObject({ kind: 'transient', statusCode: 504 });
	});

	it('403 → forbidden with the actionable message', () => {
		const body = { detail: 'nope' };
		const outcome = mapResultResponse(403, body, {});
		expect(outcome).toEqual({ kind: 'forbidden', message: FORBIDDEN_MESSAGE, body });
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
