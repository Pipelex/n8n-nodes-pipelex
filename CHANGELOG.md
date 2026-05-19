# Changelog

## [v0.0.9] - 2026-05-19

- Adopt official `@n8n/node-cli` ESLint config (enforces `n8n-nodes-base` + `@n8n/eslint-plugin-community-nodes` rules in CI).
- Switch node and credentials icon from PNG to SVG.
- Mark `Pipelex` node as `usableAsTool: true` — node is now exposed to n8n AI Agent workflows.
- Append "API" to `PiplexApi` credential `displayName` per n8n convention.

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
