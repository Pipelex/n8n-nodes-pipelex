/**
 * Vendored MTHDS API shapes — COPY-PASTED from **mthds-js v0.10.0**, never
 * imported: n8n community nodes cannot ship runtime dependencies
 * (`@n8n/scan-community-package` rejects any `dependencies` entry), so the
 * minimal wire shapes of the hosted Pipelex API (`/v1/*`) are duplicated here.
 *
 * Copy sources — sync against these files when the SDK contract moves:
 * - `mthds-js/src/client/pipeline.ts` → `RunState`, `StartRequest` (subset:
 *   `HostedStartBody`), `StartAck`
 * - `mthds-js/src/client/runs.ts`     → `RunStatus`, `RunResults`
 * - `mthds-js/src/client/client.ts`   → `parseRetryAfter`,
 *   `DEFAULT_DEGRADED_RETRY_SECONDS`, and the `getRunResult` status mapping
 *   (202/503 → running, 200 → completed, 409 → failed), adapted in
 *   `GenericFunctions.mapResultResponse`.
 */

import type { IDataObject } from 'n8n-workflow';

/** Run lifecycle state — mirrors the MTHDS Protocol `RunState` enum (the
 * vocabulary of `StartAck.state` and protocol responses). */
export type RunState = 'STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ERROR';

/** Hosted run lifecycle status — mirrors `pipelex_shared.schemas.run.RunStatus`,
 * a superset of the protocol's `RunState` (the hosted store tracks extra states
 * like `PENDING`). This is the vocabulary of RunPublic-shaped payloads, which
 * carry `status` (the protocol responses carry `state`). */
export type RunStatus =
	| 'PENDING'
	| 'STARTED'
	| 'RUNNING'
	| 'COMPLETED'
	| 'FAILED'
	| 'CANCELLED'
	| 'TERMINATED'
	| 'TIMED_OUT';

/**
 * Body of `POST /v1/start` — the subset of mthds-js's `StartRequest` this node
 * sends. Field names are the protocol's snake_case, forwarded verbatim.
 *
 * Deliberately NOT included from `StartRequest`:
 * - `pipeline_run_id` — bare-runner-only; the hosted API rejects a
 *   client-supplied run id with 422 (the StartAck's id is always authoritative).
 * - `callback_urls` — webhooks need a receivable endpoint; the node polls instead.
 *
 * `method_id` is the HOSTED extension (a stored method in the active org's
 * catalog), mutually exclusive with `mthds_contents`.
 */
export interface HostedStartBody {
	pipe_code?: string;
	mthds_contents?: string[];
	method_id?: string;
	inputs?: Record<string, unknown>;
	output_name?: string;
	output_multiplicity?: string;
	dynamic_output_concept_ref?: string;
}

/** Ack of a started execution — `POST /v1/start` 202. Mirrors the protocol's
 * `StartAck`. `pipeline_run_id` is always authoritative (server-generated). */
export interface StartAck {
	pipeline_run_id: string;
	created_at: string;
	state: RunState;
}

/**
 * Result artifacts for a completed run — `GET /v1/runs/{pipeline_run_id}/results`
 * 200. Mirrors mthds-js's `RunResults` (hosted fields only — the node never
 * talks to a bare runner, so the `pipe_output` blocking-fallback field is
 * omitted). `main_stuff` is polymorphic (a list output renders to a top-level
 * array) and `graph_spec` is an opaque artifact, so both are `unknown`.
 */
export interface RunResults {
	pipeline_run_id: string;
	/** Method graph spec (`graphspec.json`); null if missing mid-write. */
	graph_spec?: unknown;
	/** Main output stuff (`main_stuff.json`); null if missing mid-write. */
	main_stuff?: unknown;
}

/** Default poll backoff when the server sends no `Retry-After` — matches the
 * platform's `_DEGRADE_RETRY_AFTER_SECONDS` (and mthds-js's
 * `DEFAULT_DEGRADED_RETRY_SECONDS`). */
export const DEFAULT_DEGRADED_RETRY_SECONDS = 5;

/** Parse the `Retry-After` header (seconds form, which the platform uses).
 * Adapted from mthds-js `client.ts` for n8n's plain-object headers — n8n/axios
 * lowercases header keys, but tolerate either casing. */
export function parseRetryAfter(headers: IDataObject): number | undefined {
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (raw === undefined || raw === null) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
