/**
 * REPLICATED Pipelex hosted-API wire shapes — hand-copied from `pipelex-sdk-js`
 * v0.10.0. **This file must never import `@pipelex/sdk`, and the SDK must never
 * be a dependency of this package — not runtime, not dev.** n8n community nodes
 * ship with zero dependencies (`@n8n/scan-community-package` rejects any
 * `dependencies` entry), so the minimal wire shapes of the hosted Pipelex API
 * (`/v1/*`) are replicated here instead.
 *
 * **`pipelex-sdk-js` IS THE SOURCE OF TRUTH for this file.** It was previously
 * copied from `mthds-js`, which no longer owns the durable run lifecycle — that
 * moved to `@pipelex/sdk`, and `mthds-js` is the pure MTHDS Protocol only. That
 * stale pointer is exactly how this file drifted for ten SDK releases, so keep
 * the list below accurate.
 *
 * ## How to re-sync (the whole procedure — there is no automation)
 *
 * Nothing in this repo can detect that the SDK moved: replication means no
 * import, and no import means no programmatic comparison. Re-syncing is a
 * deliberate, manual read of the sibling repo:
 *
 * 1. Read `pipelex-sdk-js/CHANGELOG.md` from the version stamped above forward.
 * 2. Diff these files against what is replicated here:
 *    - `pipelex-sdk-js/src/runs.ts`   → `RunStatus`, `RunResults`,
 *      `TokensUsageRecord`, and the result-state semantics adapted in
 *      `GenericFunctions.mapResultResponse` (202/503 → running, 200 →
 *      completed, 409 → failed)
 *    - `pipelex-sdk-js/src/client.ts` → `start` / `getRunResult` (incl. the
 *      `main_stuff` invariant and `DEFAULT_DEGRADED_RETRY_SECONDS`)
 *    - `mthds/protocol` (`options.ts`, `models.ts`) → the `RunRequest` /
 *      `StartRequest` field set, `RunResultStart`, and the run-source
 *      exclusivity rules replicated in `GenericFunctions.runSourceError`
 * 3. Port the changes, **bump the version stamped in the first paragraph**, and
 *    update the pins in `test/WireContract.test.ts` (they fail on purpose when a
 *    wire field name or status mapping changes, so the edit is never silent).
 * 4. Note it in `CHANGELOG.md`.
 *
 * The server is the final authority where the SDK and the platform disagree —
 * see `working_memory` on `RunResults` for the one case where they do.
 *
 * ## Deliberate divergences from the SDK — do NOT "fix" these on a sync
 *
 * The SDK is a library; this is a workflow node running under n8n's execution
 * caps, where a usable item beats a thrown exception. These differences are
 * intentional:
 *
 * | | `@pipelex/sdk` | this node |
 * |---|---|---|
 * | poll base interval | 2s, raised by `Retry-After` | none — purely `Retry-After` (5s when absent) |
 * | wait ceiling | 20 min (`DEFAULT_WAIT_TIMEOUT_MS`) | `Max Wait`, default 300s; `0` = unbounded |
 * | on ceiling exceeded | throws `RunTimeoutError` | returns a "still running" ITEM carrying the run id |
 * | sustained 503 | no ceiling | bounded by `MAX_CONSECUTIVE_DEGRADED` |
 * | `/v1/version` handshake | gates the lifecycle, throws `RunLifecycleUnavailableError` | skipped; folded into `NOT_FOUND_MESSAGE` |
 */

import type { IDataObject } from 'n8n-workflow';

/**
 * Hosted run lifecycle status — mirrors `@pipelex/sdk`'s `RunStatus` (which
 * mirrors `pipelex_shared.schemas.run.RunStatus`). Run states are a
 * hosted-implementation concept; the MTHDS Protocol defines none. This is the
 * vocabulary of RunPublic-shaped payloads, which carry `status` (the ack
 * carries `state`). `STARTED` is deprecated server-side, kept for historical rows.
 */
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
 * Body of `POST /v1/start` — the subset of the protocol's `StartRequest` (plus
 * the hosted `method_id` extension) this node sends. Field names are the
 * protocol's snake_case, forwarded verbatim.
 *
 * Deliberately NOT included:
 * - `pipeline_run_id` — the hosted API rejects a client-supplied run id with a
 *   422 by design (the StartAck's id is always authoritative).
 * - `callback_urls` — webhooks need a receivable endpoint; the node polls instead.
 * - `bundle_b64` — the API accepts the method bundle as a base64 zip as well as
 *   a `files` map, but the node exposes ONE way to send a method (paste it, plus
 *   Python files if it needs them). A second encoding is a third run source in
 *   the editor for no user-visible gain.
 *
 * `method_id` is the HOSTED extension (a stored method in the active org's
 * catalog).
 *
 * `files` is the PIPELEX-API method-bundle extension: the whole method (the
 * `.mthds` plus its `funcs/*.py`, `structures/*.py` and an optional
 * `requirements.txt`) rather than only inline `.mthds` text — the only way to
 * run a method whose custom PipeFunc Python must travel with it. The node
 * assembles it from the pasted method + Python files; see `assembleRunSources`.
 */
export interface HostedStartBody {
	pipe_code?: string;
	mthds_contents?: string[];
	method_id?: string;
	inputs?: Record<string, unknown>;
	output_name?: string;
	output_multiplicity?: string;
	dynamic_output_concept_ref?: string;
	/** Method bundle as a `{ relativePath: text }` map. Never sent beside `mthds_contents`. */
	files?: Record<string, string>;
}

/**
 * Ack of a started execution — `POST /v1/start` 202.
 *
 * The protocol's `RunResultStart` guarantees `pipeline_run_id` ONLY and is
 * extension-open; `state` and `created_at` are hosted extension fields the
 * platform's `StartAck` adds (`platform/routers/v1/execution.py`). They are
 * typed optional here to match that contract, and `state` is an open `string`
 * rather than a closed union because the server types it `str` — the protocol
 * has no `RunState` enum to close it against.
 */
export interface StartAck {
	pipeline_run_id: string;
	/** Hosted extension — the runner's ack vocabulary (e.g. `STARTED`). Open string server-side. */
	state?: string;
	/** Hosted extension — ISO timestamp the run row was created. */
	created_at?: string;
	/** Further server-specific fields, preserved rather than dropped. */
	[extension: string]: unknown;
}

/**
 * One inference call's token usage — mirrors `@pipelex/sdk`'s `TokensUsageRecord`.
 *
 * Every field is optional and the index signature is open on purpose: records
 * the current runtime emits carry the full key set, but durable artifacts
 * written before the contract shipped are relayed verbatim and never migrated
 * (such a record arrives with no `cost` and no `pipe_code`, keeping its legacy
 * `job_metadata` / `unit_costs`). The enum-ish fields stay `string` — open sets
 * on the wire — so runtime enum churn is non-breaking.
 */
export interface TokensUsageRecord {
	/** Kind of inference. Known values: `llm`, `img_gen`, `extract`, `search`. */
	model_type?: string | null;
	/** Human model name (e.g. `gpt-4o`). */
	inference_model_name?: string | null;
	/** Provider/platform model id (e.g. `gpt-4o-2024-11-20`). */
	inference_model_id?: string | null;
	/** The pipe that made the call — what makes per-pipe cost attribution possible. */
	pipe_code?: string | null;
	job_category?: string | null;
	unit_job_id?: string | null;
	/**
	 * Raw provider-reported token counts by category (`input`, `input_cached`,
	 * `output`, `output_reasoning`, …). NOT additive — `input` is the joined
	 * total and `input_cached` a subset of it, so summing them double-counts.
	 */
	nb_tokens_by_category?: Record<string, number> | null;
	/**
	 * Computed USD cost of this call. `null` when the model has no rate table at
	 * all (own-GPU, mock, dry run); `0` means a rate table existed and priced the
	 * call at zero. There is no run-level aggregate — sum the records.
	 */
	cost?: number | null;
	started_at?: string | null;
	completed_at?: string | null;
	/** Legacy fields on a pre-contract artifact relayed verbatim. */
	[extension: string]: unknown;
}

/**
 * Result artifacts for a completed run — `GET /v1/runs/{pipeline_run_id}/results`
 * 200. Mirrors `@pipelex/sdk`'s `RunResults`, with the hosted route's
 * `working_memory` (see below).
 */
export interface RunResults {
	pipeline_run_id: string;
	/**
	 * The resolved main output content — **always present for a completed run**
	 * (the pipelex >= 0.37 main-stuff invariant, enforced in
	 * `GenericFunctions.mapResultResponse`; the SDK raises `MissingMainStuffError`
	 * for the same case). Typed `unknown` because the content is polymorphic (a
	 * list output renders to a top-level array, a structured output to an object)
	 * and may be a valid falsy value (`[]`, `0`) — it is never absent.
	 */
	main_stuff: unknown;
	/** Method graph spec (`graphspec.json`); null if missing mid-write. The n8n
	 * node strips this from its output (heavy visualization artifact). */
	graph_spec?: unknown;
	/**
	 * Full working memory of the run — every named stuff, not just the main
	 * output (`working_memory.json`); null if missing mid-write. Relayed to the
	 * n8n output (unlike `graph_spec`).
	 *
	 * NOTE: the hosted route returns this (`RunResultsResponse` in
	 * `platform/routers/v1/runs.py`) but `@pipelex/sdk`'s `RunResults` does not
	 * declare it — it declares the bare-runner `pipe_output` instead. The server
	 * is authoritative, so the field stays; this is the one place the vendored
	 * shape is deliberately WIDER than the SDK.
	 */
	working_memory?: unknown;
	/**
	 * Per-call usage records — token counts by category, computed `cost` in USD,
	 * model id — for LLM and img-gen/extract/search calls alike. `null` whenever
	 * assembly produced no list: it was off, it broke (see
	 * `usage_assembly_error`), or the run was delivered before the artifact
	 * existed. `[]` when assembly ran and no inference happened.
	 */
	tokens_usages?: TokensUsageRecord[] | null;
	/**
	 * Non-null when the runner's usage assembly failed for the run. The ONLY
	 * field that separates "usage broke" from "usage was off" / "pre-artifact
	 * run" — all three leave `tokens_usages` null, so a caller that cares must
	 * branch on this, not on the list.
	 */
	usage_assembly_error?: string | null;
}

/** Default poll backoff when the server sends no `Retry-After` — matches the
 * platform's `_DEGRADE_RETRY_AFTER_SECONDS` (and the SDK's
 * `DEFAULT_DEGRADED_RETRY_SECONDS`). */
export const DEFAULT_DEGRADED_RETRY_SECONDS = 5;

/** Parse the `Retry-After` header (seconds form, which the platform uses).
 * Adapted from the SDK's `parseRetryAfter` for n8n's plain-object headers —
 * n8n/axios lowercases header keys, but tolerate either casing. */
export function parseRetryAfter(headers: IDataObject): number | undefined {
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (raw === undefined || raw === null) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
