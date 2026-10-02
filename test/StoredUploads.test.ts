import { describe, expect, it } from 'vitest';

import {
	STORED_UPLOADS_MAX_ENTRIES,
	STORED_UPLOADS_TTL_MS,
	StoredUploadCache,
	storedUploadKey,
	storedUploads,
	type StoredUploadIdentity,
} from '../nodes/Pipelex/StoredUploads';

const IDENTITY: StoredUploadIdentity = {
	executionId: 'exec-1',
	nodeId: 'node-1',
	itemIndex: 0,
	inputName: 'document',
	bytes: Buffer.from('%PDF-1.7 a fake invoice'),
	filename: 'invoice.pdf',
	contentType: 'application/pdf',
	baseUrl: 'https://api.pipelex.com',
};

const REFERENCE = {
	url: 'pipelex-storage://orgs/org-1/assets/file-1.pdf',
	filename: 'invoice.pdf',
	mime_type: 'application/pdf',
};

describe('storedUploadKey (what makes two uploads the same upload)', () => {
	it('is the same for the same identity, and holds neither the name nor the bytes', () => {
		const key = storedUploadKey(IDENTITY);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(storedUploadKey({ ...IDENTITY, bytes: Buffer.from(IDENTITY.bytes) })).toBe(key);
	});

	it('changes with every part of the identity', () => {
		const key = storedUploadKey(IDENTITY);
		const variants: Array<Partial<StoredUploadIdentity>> = [
			{ executionId: 'exec-2' },
			{ nodeId: 'node-2' },
			{ itemIndex: 1 },
			{ inputName: 'receipt' },
			{ bytes: Buffer.from('%PDF-1.7 the corrected invoice') },
			{ filename: 'invoice-2.pdf' },
			{ contentType: 'application/octet-stream' },
			{ baseUrl: 'https://api.dev.pipelex.com' },
		];
		for (const variant of variants) {
			expect(storedUploadKey({ ...IDENTITY, ...variant }), JSON.stringify(Object.keys(variant))).not.toBe(key);
		}
	});

	it('cannot be told apart by moving text between parts', () => {
		expect(storedUploadKey({ ...IDENTITY, nodeId: 'a:b', inputName: 'c' })).not.toBe(
			storedUploadKey({ ...IDENTITY, nodeId: 'a', inputName: 'b:c' }),
		);
	});

	it('is undefined without an execution id, which would match another execution', () => {
		expect(storedUploadKey({ ...IDENTITY, executionId: '' })).toBeUndefined();
		expect(storedUploadKey({ ...IDENTITY, executionId: undefined as unknown as string })).toBeUndefined();
	});
});

describe('StoredUploadCache (bounded, expiring)', () => {
	function clocked(maxEntries = 3, ttlMs = 1000) {
		let now = 0;
		const cache = new StoredUploadCache(maxEntries, ttlMs, () => now);
		return { cache, advance: (ms: number) => (now += ms) };
	}

	it('returns what was stored, as a copy the caller cannot alter it through', () => {
		const { cache } = clocked();
		cache.set('k', REFERENCE);
		const found = cache.get('k');
		expect(found).toEqual(REFERENCE);
		found!.url = 'pipelex-storage://elsewhere';
		expect(cache.get('k')).toEqual(REFERENCE);
		expect(cache.get('other')).toBeUndefined();
	});

	it('forgets an entry once it is as old as the time to live', () => {
		const { cache, advance } = clocked(3, 1000);
		cache.set('k', REFERENCE);
		advance(999);
		expect(cache.get('k')).toEqual(REFERENCE);
		advance(1);
		expect(cache.get('k')).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it('prunes expired entries when it writes, oldest first', () => {
		const { cache, advance } = clocked(10, 1000);
		cache.set('a', REFERENCE);
		advance(600);
		cache.set('b', REFERENCE);
		advance(500);
		cache.set('c', REFERENCE);
		expect(cache.size).toBe(2);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toEqual(REFERENCE);
	});

	it('holds at most its bound, evicting the oldest entry first', () => {
		const { cache } = clocked(2);
		cache.set('a', REFERENCE);
		cache.set('b', REFERENCE);
		cache.set('c', REFERENCE);
		expect(cache.size).toBe(2);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toEqual(REFERENCE);
		expect(cache.get('c')).toEqual(REFERENCE);
	});

	it('moves a rewritten entry to the newest end, with a fresh time to live', () => {
		const { cache, advance } = clocked(2, 1000);
		cache.set('a', REFERENCE);
		cache.set('b', REFERENCE);
		advance(900);
		cache.set('a', { ...REFERENCE, url: 'pipelex-storage://orgs/org-1/assets/file-2.pdf' });
		cache.set('c', REFERENCE);
		expect(cache.get('b')).toBeUndefined();
		advance(500);
		expect(cache.get('a')?.url).toBe('pipelex-storage://orgs/org-1/assets/file-2.pdf');
	});

	it("keeps the process's memory for a day and to a fixed number of entries", () => {
		expect(STORED_UPLOADS_TTL_MS).toBe(24 * 60 * 60 * 1000);
		expect(STORED_UPLOADS_MAX_ENTRIES).toBeGreaterThan(0);
		expect(storedUploads).toBeInstanceOf(StoredUploadCache);
	});
});
