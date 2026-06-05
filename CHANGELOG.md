# Changelog

## [Unreleased]

- **Breaking — node is now a four-operation node.** The single blocking `Execute` operation is replaced by an `Operation` selector:
  - **Start & Poll** (default) — starts a durable run (`POST /platform/v1/runs`) and polls the self-healing result endpoint (`GET /platform/v1/runs/by-id/{run_id}/result`) until it finishes. Survives the public API's ~30s synchronous ceiling. Output is now `{ done, status, pipeline_run_id, main_stuff, graph_spec }` — **not** the old `/execute` `pipe_output`.
  - **Execute (One-Shot)** — keeps the old blocking `POST /runner/v1/pipeline/execute` behavior (returns `pipe_output`). Carries a notice + translates the ~30s public-API gateway timeout into an actionable message pointing at Start & Poll.
  - **Start Run** — starts a durable run and returns its `pipeline_run_id` immediately (no waiting).
  - **Poll for Result** — polls an existing run by `pipeline_run_id` until it finishes, then returns the result.
  - **Get Result** — fetches a run's result once by `pipeline_run_id` (no polling); returns `done: false` while still running.
- **Max Wait defaults to unbounded** (`0` = wait indefinitely) on the polling operations. A positive cap, if exceeded, returns the `pipeline_run_id` + a "still running" message instead of failing, so the run can be fetched later with Poll for Result. The server's `Retry-After` is honored.
- **Idempotency on start.** Start / Start & Poll send an `Idempotency-Key` (n8n execution id + item index) on `POST /runs`, so an n8n "Retry On Fail" replays the same run instead of creating a duplicate paid run.
- **Actionable 403.** A run rejected for lack of runs access surfaces a clear "needs an admin / `runs:execute`-scoped key" message — the credential test only validates the token, not run scope.
- Fixed the runner override field name to `dynamic_output_concept_ref` on every operation (the old `_code` spelling was silently discarded by the runner).
- Dev tooling: added Vitest unit tests (pure result mapper + all four operation flows), wired `pnpm test` into `make check`, and added a Test CI workflow. Vitest is a devDependency only — the node still ships with zero runtime dependencies.
- `make run` now launches the `@n8n/node-cli` dev server (no global `n8n` install required; hot-reloads on save). Note n8n requires Node.js `>=20.19 <= 24.x`.

## [v0.0.10] - 2026-05-21

- Credential test now pings `/platform/v1/auth/verify` (the canonical token-verification endpoint) instead of `/me`.

## [v0.0.9] - 2026-05-19

- Adopt official `@n8n/node-cli` ESLint config (enforces `n8n-nodes-base` + `@n8n/eslint-plugin-community-nodes` rules in CI). CI now runs the TypeScript lint, the n8n compliance lint, and the build as three separate workflows so failures are clearly attributed.
- Switch node and credentials icon from PNG to SVG.
- Mark `Pipelex` node as `usableAsTool: true` — node is now exposed to n8n AI Agent workflows.
- Append "API" to `PiplexApi` credential `displayName` per n8n convention.
- Drop the re-throw guard in the `execute()` catch block; all caught errors are now uniformly wrapped in `NodeApiError`, per the `@n8n/community-nodes/require-node-api-error` rule.
- Add an "n8n Scan Simulation" workflow that runs the exact ESLint config used by `@n8n/scan-community-package` against the compiled `dist/` output — pre-publish equivalent of the post-publish scanner, so failures are caught on the PR instead of after `npm publish`.
- The post-publish scanner step in `publish.yml` no longer swallows failures (`continue-on-error: true` removed) — a failed scan now fails the publish workflow so the maintainer is alerted immediately.

## [v0.0.8] - 2026-05-19

- Updated Pipelex API paths from `/api/v1/...` to `/runner/v1/...` (the `pipeline/execute` endpoint and the doc references for the credential test path).
- Bearer Token credential field description now points users to `https://app.pipelex.com/` to create an API key.

## [v0.0.7] - 2026-05-13

- Credential test now pings `/me` (any authenticated user) instead of `/api/v1/api_version` (admin-only) — non-admin users with valid tokens were seeing the credential check fail with a 403.
- Updated for the new Pipelex API key format (80-char tokens with CRC32 checksum, `plx_sk_..._xxxxxxxx`). The credential field accepts the new format end-to-end.
- Flattened the Pipeline → Execute UI: dropped the `Resource` and `Operation` dropdowns (one option each), removed the `Additional Fields` collection, and surfaced every pipeline-execute field at the top level. New order: `MTHDS Bundles` → `Inputs` → `Pipe Code` → `Output Name` → `Output Multiplicity` → `Dynamic Output Concept Ref`.
- `MTHDS Bundles` is now a true `string[]` (multiple bundles per request) via `multipleValues: true`, matching the API's `list[str]` contract; previously a single textarea was wrapped in `[content]`.
- Fixed the silent-typo bug: the body field is now `dynamic_output_concept_ref` (matches the upstream `PipelineRequest` model). Previously the node sent `dynamic_output_concept_code` which the API silently discarded.
- `Inputs` is no longer marked required — the API defaults it to `{}` server-side.
- CI: removed the dist re-lint step from `make check` (it flagged `tsc`-emitted `require()` calls, structurally unfixable). Source ESLint remains the gate; `make check-dist` is available for manual inspection.

## [v0.0.6] - 2026-05-11

- Applied n8n review feedback: moved `Base URL` to a credential field, added required `Resource`/`Operation` selectors, grouped optional properties under `Additional Fields`, switched inputs/outputs to `NodeConnectionTypes.Main`, replaced raw `Error` throws with `NodeOperationError`, and pointed the credential test at the production API instead of `127.0.0.1`.
- Updated the request payload to the new Pipelex API schema (`mthds_contents` in place of `plx_content`) and made `https://api.pipelex.com` the default credential Base URL (hosted API coming soon — for now point the credential at your self-hosted Pipelex API).
- Removed the `pnpm.overrides` block from `package.json`.

## [v0.0.5] - 2025-11-04

- Updated the documentation.

## [v0.0.4] - 2025-10-26

- Update README and docs

## [v0.0.3] - 2025-10-25

- Update the support email to `oss@pipelex.com`

## [v0.0.2] - 2025-10-25

- Fix the deployment process

## [v0.0.1] - 2025-10-23

- Initial commit!
