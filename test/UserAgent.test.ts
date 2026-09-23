/**
 * Client identification: every request this node sends to the Pipelex API
 * carries `User-Agent: n8n-nodes-pipelex/<package version>` (workspace spec
 * `docs/specs/client-identification.md`). The expected value is read from the
 * manifest on disk here, independently of the module under test, so a
 * hand-typed or stale version fails.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PiplexApi } from '../credentials/PiplexApi.credentials';
import { apiHeaders, buildApiConnection } from '../nodes/Pipelex/GenericFunctions';
import { USER_AGENT } from '../nodes/Pipelex/UserAgent';

const manifest = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
	name: string;
	version: string;
};
const EXPECTED = `n8n-nodes-pipelex/${manifest.version}`;

describe('USER_AGENT', () => {
	it('is the single product token n8n-nodes-pipelex/<package.json version>', () => {
		expect(manifest.name).toBe('n8n-nodes-pipelex');
		expect(USER_AGENT).toBe(EXPECTED);
	});

	it('is a valid RFC 9110 product token within the spec length cap', () => {
		expect(USER_AGENT).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9.+-]+$/);
		expect(USER_AGENT.length).toBeLessThanOrEqual(512);
	});
});

describe('apiHeaders — the one place request headers are built', () => {
	const conn = buildApiConnection({ baseUrl: 'https://api.test', apiKey: 'tok-1' });

	it('carries Authorization and User-Agent', () => {
		expect(apiHeaders(conn)).toEqual({ Authorization: 'Bearer tok-1', 'User-Agent': EXPECTED });
	});

	it('layers request-specific headers without letting them override the shared ones', () => {
		expect(apiHeaders(conn, { 'Idempotency-Key': 'k', 'User-Agent': 'other/1.0' })).toEqual({
			'Idempotency-Key': 'k',
			Authorization: 'Bearer tok-1',
			'User-Agent': EXPECTED,
		});
	});
});

describe('credential test request', () => {
	it('declares the same User-Agent as the node requests', () => {
		const headers = new PiplexApi().test.request.headers as Record<string, unknown>;
		expect(headers['User-Agent']).toBe(EXPECTED);
		expect(headers.Authorization).toBe('=Bearer {{$credentials.apiKey}}');
	});
});
