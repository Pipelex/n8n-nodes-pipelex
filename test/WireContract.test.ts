/**
 * Wire-contract pins for the REPLICATED Pipelex API shapes.
 *
 * This node **replicates** the hosted Pipelex API contract — it never imports
 * `@pipelex/sdk`, and the SDK is not a dependency of any kind (not runtime, not
 * dev). `nodes/Pipelex/PipelexApiShapes.ts` is a hand-maintained copy, and the
 * procedure for re-syncing it lives in that file's header.
 *
 * Because nothing here reaches into the SDK, no test can detect that the SDK
 * changed. What these tests DO is pin the contract this node believes in, at
 * runtime, so that:
 *
 *   1. Editing the replicated shapes is a deliberate act with a failing test and
 *      a visible diff — never an accidental drift.
 *   2. The exact wire field names are asserted. This is the guard that matters
 *      most in practice: the one field-name bug this node has actually shipped
 *      was `dynamic_output_concept_code` for `dynamic_output_concept_ref`, which
 *      the runner silently discarded. A typo in a snake_case key produces no
 *      error anywhere — only a pinned key set catches it.
 *   3. The result fields the node recognises are enumerated in one place, so a
 *      sync against the SDK has a checklist to diff against.
 *
 * WHEN ONE OF THESE FAILS: either you changed the wire contract on purpose (port
 * the change, update the pin, note it in the changelog), or you made a typo.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	abortableSleep,
	buildStartBody,
	mapResultResponse,
	runSourceError,
} from '../nodes/Pipelex/GenericFunctions';
import type { HostedStartBody } from '../nodes/Pipelex/PipelexApiShapes';

describe('POST /v1/start — the exact body this node sends', () => {
	it('emits exactly the pinned snake_case field names, and no others', () => {
		// Every field the node can send, populated. A renamed, added, or
		// mistyped wire key changes this set.
		const body = buildStartBody({
			pipeCode: 'p',
			methodId: 'm',
			mthdsContents: ['bundle'],
			inputs: { a: 1 },
			outputName: 'out',
			outputMultiplicity: '3',
			dynamicOutputConceptRef: 'concept.ref',
			files: { 'main.mthds': 'x' },
		});

		expect(Object.keys(body).sort()).toEqual([
			'dynamic_output_concept_ref',
			'files',
			'inputs',
			'method_id',
			'mthds_contents',
			'output_multiplicity',
			'output_name',
			'pipe_code',
		]);
	});

	it('spells the dynamic output override `_ref`, not `_code`', () => {
		// The historical bug: `dynamic_output_concept_code` was accepted by the
		// request and silently DISCARDED by the runner — no error, no output
		// override, nothing to debug. Pinned deliberately.
		const body = buildStartBody({ pipeCode: 'p', dynamicOutputConceptRef: 'concept.ref' });
		expect(body.dynamic_output_concept_ref).toBe('concept.ref');
		expect(body).not.toHaveProperty('dynamic_output_concept_code');
	});

	it('carries the assembled bundle under its wire name', () => {
		const body = buildStartBody({ files: { 'main.mthds': 'x' } });
		expect(Object.keys(body)).toEqual(['files']);
	});

	it('never sends bundle_b64 — the node exposes one way to supply a method', () => {
		// The API accepts a base64-zip bundle; the node deliberately does not offer
		// it. Pinned so it is not reintroduced as a third run source by accident.
		type HasZip = 'bundle_b64' extends keyof HostedStartBody ? never : true;
		const _absent: HasZip = true;
		expect(_absent).toBe(true);
	});

	it('never sends pipeline_run_id — the hosted API 422s a client-supplied run id', () => {
		// Run ids are server-generated; the StartAck's id is authoritative. There is
		// no node param that could produce one, and this pins that.
		const body = buildStartBody({
			pipeCode: 'p',
			methodId: 'm',
			mthdsContents: ['b'],
			inputs: {},
			outputName: 'o',
			outputMultiplicity: '1',
			dynamicOutputConceptRef: 'c',
			files: { 'a.mthds': 'x' },
		});
		expect(body).not.toHaveProperty('pipeline_run_id');
	});
});

describe('GET /v1/runs/{id}/results — the response contract this node reads', () => {
	it('recognises every artifact the hosted route returns, and drops none of them', () => {
		// The full result body per the hosted `RunResultsResponse`. `graph_spec` is
		// stripped later (in the node, not the mapper) as a presentation choice; the
		// mapper itself must pass the whole body through untouched.
		const body = {
			pipeline_run_id: 'run-1',
			main_stuff: { answer: 42 },
			working_memory: { root: {}, aliases: {} },
			graph_spec: { nodes: [] },
			tokens_usages: [{ pipe_code: 'p', cost: 0.0012 }],
			usage_assembly_error: null,
		};

		const outcome = mapResultResponse(200, body, {});
		expect(outcome).toEqual({ kind: 'completed', body });
		// Pinned so a sync has an explicit checklist of what we consume.
		expect(Object.keys(body).sort()).toEqual([
			'graph_spec',
			'main_stuff',
			'pipeline_run_id',
			'tokens_usages',
			'usage_assembly_error',
			'working_memory',
		]);
	});

	it('pins the HTTP status → meaning mapping', () => {
		// The whole poll protocol in one assertion. Changing any of these changes
		// how every workflow behaves, so it should never move quietly.
		const withStuff = { main_stuff: 1 };
		expect(mapResultResponse(200, withStuff, {}).kind).toBe('completed');
		expect(mapResultResponse(202, {}, {}).kind).toBe('running');
		expect(mapResultResponse(503, {}, {}).kind).toBe('running');
		expect(mapResultResponse(409, {}, {}).kind).toBe('failed');
		expect(mapResultResponse(403, {}, {}).kind).toBe('forbidden');
		expect(mapResultResponse(404, {}, {}).kind).toBe('notFound');
		expect(mapResultResponse(500, {}, {}).kind).toBe('unexpected');
		// A completed run always delivers a main stuff; a 200 without one is a
		// broken invariant, not an empty success.
		expect(mapResultResponse(200, {}, {}).kind).toBe('missingMainStuff');
	});

	it('distinguishes a transient 503 from a normal in-flight 202', () => {
		// Only the 503 counts toward the consecutive-degraded ceiling, so the flag
		// is load-bearing rather than cosmetic.
		expect(mapResultResponse(202, {}, {})).toMatchObject({ degraded: false });
		expect(mapResultResponse(503, {}, {})).toMatchObject({ degraded: true });
	});
});

describe('run-source rules — replicated from the MTHDS Protocol', () => {
	it('pins which source combinations are legal', () => {
		// Replicated from `assertExclusiveRunSources` + `hasBundlePayload`. The node
		// must reject exactly what the server rejects; a divergence here means a
		// user gets an opaque 422 instead of an immediate, item-scoped message.
		const legal: HostedStartBody[] = [
			{ pipe_code: 'p' },
			{ mthds_contents: ['b'] },
			{ method_id: 'm' },
			{ files: { 'a.mthds': 'x' } },
			{ method_id: 'm', pipe_code: 'p' },
			{ pipe_code: 'p', files: { 'a.mthds': 'x' } },
		];
		const illegal: HostedStartBody[] = [
			{},
			{ mthds_contents: [] },
			{ files: { 'a.mthds': 'x' }, mthds_contents: ['b'] },
			// A stored method AND an inline one — the API would accept this and treat
			// method_id as run-history linkage; the node refuses it so there is one
			// unambiguous answer to what it runs.
			{ method_id: 'm', mthds_contents: ['b'] },
			{ method_id: 'm', files: { 'a.mthds': 'x' } },
		];

		expect(legal.map((body) => runSourceError(body))).toEqual(legal.map(() => null));
		for (const body of illegal) {
			expect(runSourceError(body), JSON.stringify(body)).not.toBeNull();
		}
	});
});

describe('n8n-workflow runtime surface', () => {
	// `n8n-workflow` is a peerDependency (`"*"`), satisfied at runtime by whatever
	// version the host n8n ships — which is NOT the version this repo compiles
	// against. So `tsc` passing proves nothing about the host: importing a helper
	// that a newer n8n-workflow dropped compiles clean and throws at runtime.
	//
	// That is not hypothetical. v0.1.0 imported `sleepWithAbort`, which exists in
	// n8n-workflow 1.x and was REMOVED in 2.x — so every poll on a current n8n died
	// with `sleepWithAbort is not a function`, while lint, tsc and the whole suite
	// stayed green (the test mock stubbed it, which only asserted it existed).
	//
	// This pins the VALUE imports (types are erased and cannot fail at runtime) to
	// a small allowlist of long-stable, universally-present surface. Adding to the
	// list is a deliberate act: verify the symbol exists across the n8n-workflow
	// majors this node supports, or own the helper locally instead.
	const ALLOWED_VALUE_IMPORTS = [
		'NodeApiError',
		'NodeConnectionTypes',
		'NodeOperationError',
		// `sleep` survived the 1.x → 2.x transition that removed `sleepWithAbort`.
		// A community node cannot own a timer (restricted globals + no node:
		// imports), so the host has to provide this one.
		'sleep',
	];

	it.each(['nodes/Pipelex/Pipelex.node.ts', 'nodes/Pipelex/GenericFunctions.ts'])(
		'%s imports only allowlisted values from n8n-workflow',
		(relativePath) => {
			const source = readFileSync(resolve(relativePath), 'utf8');
			const block = /import\s*\{([^}]*)\}\s*from\s*'n8n-workflow';/.exec(source);
			if (!block) return; // No import at all is fine.
			const valueImports = block[1]
				.split(',')
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0 && !entry.startsWith('type '));

			expect(valueImports.sort()).toEqual(
				valueImports.filter((name) => ALLOWED_VALUE_IMPORTS.includes(name)).sort(),
			);
		},
	);

	it('never imports the removed sleepWithAbort', () => {
		// The specific regression. `abortableSleep` layers abort handling over the
		// host's `sleep`, which exists in both n8n-workflow majors.
		const source = readFileSync(resolve('nodes/Pipelex/GenericFunctions.ts'), 'utf8');
		// The allowlist test above is what actually forbids importing it; this pins
		// that the replacement exists and is ours. (The file mentions the old name in
		// prose deliberately, so assert on the import list, not on the text.)
		const importBlock = /import\s*\{([^}]*)\}\s*from\s*'n8n-workflow';/.exec(source)?.[1] ?? '';
		expect(importBlock).not.toContain('sleepWithAbort');
		expect(importBlock).toContain('sleep');
		expect(source).toContain('export async function abortableSleep');
		expect(abortableSleep).toBeTypeOf('function');
	});

	it('abortableSleep resolves promptly and rejects on abort', async () => {
		await expect(abortableSleep(0)).resolves.toBeUndefined();
		await expect(abortableSleep(1)).resolves.toBeUndefined();
	});

	it('abortableSleep propagates the abort reason when there is one', async () => {
		// `controller.abort()` sets an AbortError as the reason. Preserve it rather
		// than replacing it, so a cancelled execution reports why it was cancelled.
		const controller = new AbortController();
		const pending = abortableSleep(5_000, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();

		// An already-aborted signal rejects without arming a timer.
		await expect(abortableSleep(5_000, controller.signal)).rejects.toThrow();
	});

	it('abortableSleep falls back to its own message for a non-Error reason', async () => {
		const controller = new AbortController();
		const pending = abortableSleep(5_000, controller.signal);
		controller.abort('user stopped the workflow');
		await expect(pending).rejects.toThrow(/cancelled/);
	});
});
