import { createHash } from 'crypto';

import type { StoredFileInput } from './PipelexApiShapes';

// ── Stored uploads: what a retry of the same item may reuse ─────────────────
//
// n8n's "Retry On Fail" re-runs the WHOLE node, every item of it, within the
// same execution (`workflow-execute.ts` calls `runNode` again with the same
// input). An item that only carries JSON replays its run for free: same body,
// same `Idempotency-Key`, and the platform answers with the run the first attempt
// started. An item with binary inputs did not, because every attempt stored its
// files afresh under new `pipelex-storage://` references, which changed its body
// and therefore its key — so a retry started a second paid run for every item
// that had already started one.
//
// So the node remembers, in this process, the reference each file was stored
// under, and a later attempt at the same item reuses it. The key is everything
// that makes two uploads the same upload: the execution, the node and its run
// index, the item, the input, the SHA-256 of the bytes, the file name, the MIME
// type and the Base URL. The run index is what keeps a node inside a loop from
// reusing one pass's file in the next: each pass is a new run of the node, and a
// retry is not (see `idempotencyKey`).
// A file whose bytes changed, or that a different execution sends, is uploaded
// again; a reference is recorded only once storage has answered the `PUT` with a
// `2xx`, so the memory never names an object that does not exist.
//
// Bounded in both directions. An entry lives at most a day, the platform's
// idempotency window (`TTL_SECONDS` in `middleware/idempotency.py`): past it the
// key no longer replays anything, so a remembered reference would buy nothing.
// And the memory holds at most `STORED_UPLOADS_MAX_ENTRIES` entries, the oldest
// leaving first: an entry is a few hundred bytes, so the bound holds the memory
// to a few megabytes on an instance shared by many workflows. An entry evicted
// before its retry only costs what every retry cost before: a fresh upload and a
// new run, never a refused one, since the references stay folded into the key.
//
// The memory is per process, which is where a retry runs: n8n executes the whole
// of an execution, retries included, in one process (one worker in queue mode).
// A restarted instance forgets, and so does a manual "Retry execution" from the
// executions list, which is a new execution with a new id.

/** How long a stored reference is reused: the platform's idempotency window, 24 h. */
export const STORED_UPLOADS_TTL_MS = 24 * 60 * 60 * 1000;

/** How many stored references the process remembers at most, oldest evicted first. */
export const STORED_UPLOADS_MAX_ENTRIES = 10_000;

/** Everything that makes two uploads the same upload — see the header of this file. */
export interface StoredUploadIdentity {
	executionId: string;
	nodeId: string;
	runIndex: number;
	itemIndex: number;
	inputName: string;
	bytes: Buffer;
	filename: string;
	contentType: string;
	baseUrl: string;
}

/**
 * The memory key of an upload: a SHA-256 over its identity, the bytes counted by
 * their own SHA-256. Hashed so a key has a fixed size whatever the file name, and
 * holds neither the name nor the bytes. `undefined` when the execution has no id,
 * since a key without one would match the same item of another execution.
 */
export function storedUploadKey(identity: StoredUploadIdentity): string | undefined {
	if (typeof identity.executionId !== 'string' || identity.executionId.length === 0) return undefined;
	const contentDigest = createHash('sha256').update(identity.bytes).digest('hex');
	return createHash('sha256')
		.update(
			JSON.stringify([
				identity.executionId,
				identity.nodeId,
				identity.runIndex,
				identity.itemIndex,
				identity.inputName,
				contentDigest,
				identity.filename,
				identity.contentType,
				identity.baseUrl,
			]),
		)
		.digest('hex');
}

/**
 * A bounded, expiring map from an upload's key to the input value naming its
 * stored file. Entries are kept in the order they were written, which is also
 * the order they expire in, so pruning reads from the oldest and stops at the
 * first live one. The clock is injected for tests.
 */
export class StoredUploadCache {
	private readonly entries = new Map<string, { value: StoredFileInput; storedAt: number }>();

	constructor(
		private readonly maxEntries: number,
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now,
	) {}

	/** The reference stored under `key`, or `undefined` when there is none or it expired. */
	get(key: string): StoredFileInput | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (this.now() - entry.storedAt >= this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		return { ...entry.value };
	}

	/** Remember `value` under `key`; call only once storage has accepted the file. */
	set(key: string, value: StoredFileInput): void {
		const now = this.now();
		this.prune(now);
		this.entries.delete(key);
		this.entries.set(key, { value: { ...value }, storedAt: now });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}

	private prune(now: number): void {
		for (const [key, entry] of this.entries) {
			if (now - entry.storedAt < this.ttlMs) break;
			this.entries.delete(key);
		}
	}
}

/** The process's memory of stored uploads. */
export const storedUploads = new StoredUploadCache(STORED_UPLOADS_MAX_ENTRIES, STORED_UPLOADS_TTL_MS);
