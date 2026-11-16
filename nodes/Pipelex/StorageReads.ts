/**
 * Storage reads — the plumbing every read of bytes from storage through a signed link shares.
 *
 * Two reads use it: the File resource's Download (`downloadFromLink` in `FileFunctions.ts`), which
 * streams a file into n8n's binary data, and the stored texts' loading (`readSignedLink` in
 * `StoredTexts.ts`), which reads a long text into memory. Each keeps its own request, its own
 * reading of the body and its own messages; what they share is here:
 *
 * - **The bytes of a body**, whichever form n8n hands it in: bytes, or a stream for a request sent
 *   with `encoding: 'stream'`.
 * - **The refusal's prefix**: storage writes its error document at the start of the body, so only
 *   its first {@link STORAGE_ERROR_BODY_MAX_BYTES} are read, the stream destroyed after them.
 * - **The deadline**: an `AbortSignal.timeout` the node owns, linked with whatever else stops the
 *   read (the execution's cancel signal, or a sibling read's failure). With a stream the exchange
 *   outlasts the request: axios answers once storage's headers arrive and its own `timeout` stops
 *   counting then, so the signal stays linked until the body is read.
 * - **The stream's guard**: when the signal fires the node destroys the stream itself, whoever is
 *   reading it, with a stopped-read error; the stream's `error` is always listened to, since an
 *   unheard one is thrown, and axios logs it with its request, the signed link included; and a body
 *   not read to its end is destroyed on release, since it still holds its connection to storage.
 */

import type { IExecuteFunctions } from 'n8n-workflow';

import { eitherSignal } from './GenericFunctions';

/** How much of storage's error body is read — where S3 writes its `<Code>` and `<Message>`. */
export const STORAGE_ERROR_BODY_MAX_BYTES = 16 * 1024;

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

/**
 * The first {@link STORAGE_ERROR_BODY_MAX_BYTES} of a refused answer's body, where storage writes
 * its error document, whether n8n handed the body back as a stream or as bytes.
 */
export async function readRefusalPrefix(body: unknown): Promise<Buffer> {
	return isBodyStream(body)
		? await readStreamPrefix(body, STORAGE_ERROR_BODY_MAX_BYTES)
		: bodyBytes(body).subarray(0, STORAGE_ERROR_BODY_MAX_BYTES);
}

/** The error a read's stream is destroyed with when its deadline passes or something else stops it. */
export function stoppedReadError(message: string): Error {
	return Object.assign(new Error(message), { name: 'AbortError', code: 'ABORT_ERR' });
}

/** A read's deadline, linked with what else stops it. */
export interface StorageReadDeadline {
	/** The deadline alone, which tells a read out of time from one stopped otherwise. */
	deadline: AbortSignal;
	/** The signal the read is sent with: the deadline, or it and the stop signal. */
	signal: AbortSignal;
	/** Unlink the two, once the read is over. */
	release: () => void;
}

/**
 * The deadline of one read, `limitMs` from now, linked with `stop` when there is one (the
 * execution's cancel signal, or one that also fires when a sibling read fails).
 */
export function storageReadDeadline(limitMs: number, stop: AbortSignal | undefined): StorageReadDeadline {
	const deadline = AbortSignal.timeout(limitMs);
	const linked = stop ? eitherSignal(stop, deadline) : undefined;
	return { deadline, signal: linked?.signal ?? deadline, release: () => linked?.unlink() };
}

/** A body under the guard of its read's signal. */
export interface GuardedBody {
	/** The body when it is a stream, else `undefined`. */
	stream: BodyStream | undefined;
	/** Stop guarding, and destroy a stream not read to its end. */
	release: () => void;
}

/**
 * Guard a response body with its read's `signal`: when it fires (at once if it already has), a
 * stream is destroyed with {@link stoppedReadError}`(stoppedMessage)` and `onStop` is called; the
 * stream's `error` is always heard, by `onError` or by nothing. `release` stops the guard and
 * destroys a stream not read to its end, and belongs in a `finally`.
 */
export function guardBody(
	body: unknown,
	signal: AbortSignal,
	options: { stoppedMessage: string; onError?: (error: unknown) => void; onStop?: () => void },
): GuardedBody {
	const stream = isBodyStream(body) ? body : undefined;
	const stop = (): void => {
		if (stream && !stream.destroyed) stream.destroy(stoppedReadError(options.stoppedMessage));
		options.onStop?.();
	};
	// An unheard stream error is thrown, and axios logs it with its request, the link included.
	stream?.on('error', options.onError ?? (() => {}));
	signal.addEventListener('abort', stop, { once: true });
	if (signal.aborted) stop();
	return {
		stream,
		release: () => {
			signal.removeEventListener('abort', stop);
			// A body not read to its end still holds its connection to storage.
			if (stream && !stream.destroyed) stream.destroy();
		},
	};
}
