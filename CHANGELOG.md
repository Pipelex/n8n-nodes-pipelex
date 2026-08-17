# Changelog

## [v0.2.0] - 2026-08-17

### Upgrading

- **A workflow that pastes its method inline must turn on the new `Define Method Inline` toggle.** The toggle defaults to **off** (stored-method-first), and the fields it holds are only read when it is on. A workflow saved before this release therefore has to be switched on once per node — and the node **refuses to run until you do**, rather than guessing. It recognises a pre-0.2.0 configuration by the stored field shape (the old field persisted a bare `string[]`; the current one persists `{ bundle: [{ content }] }`) and raises a migration error naming the toggle. The old shape is still read once the toggle is on, so no pasted method is lost.

  That refusal matters most when the node also carries a `Method ID`. In 0.1.0 both together was legal and **the inline bundle won**, so defaulting such a workflow to "toggle off" would have dropped the inline content and silently run the *stored* method instead — a different method, with no error at all. Leftover content from a user who typed into the field and then switched the toggle back off is still ignored, because that content is in the new shape and the choice was explicit.
- **A workflow that sets both a `Method ID` and an inline method now errors** instead of running the inline one and filing it under the stored method. Clear one of the two.

### Fixed

- **Polling worked on no current n8n: `sleepWithAbort is not a function`.** Every `Start & Wait for Result` and `Poll & Get Result` run died on its first sleep — the node's two headline operations, broken for anyone on a modern n8n. `n8n-workflow` exports `sleepWithAbort` in 1.x and **removed it in 2.x**; it is a `peerDependency` (`"*"`) satisfied by whatever version the host ships, so it compiled clean against the 1.x in this repo's dev tree and threw at runtime against the 2.x n8n actually runs. Lint, `tsc` and the whole test suite stayed green throughout, because the suite *mocked* that very function — mocking a dependency's API asserts the API exists.

  The poll loop now builds its abort handling over `sleep`, which exists in both majors. It is layered rather than owned outright because a community node may not own a timer at all: `no-restricted-globals` bans `setTimeout` (with `process`, `__dirname`, and friends) and `no-restricted-imports` bans `node:timers/promises`, since n8n Cloud runs community nodes without dependencies — so the host has to provide the timer and only the race is ours. Verified by executing the compiled helper against n8n-workflow 2.34.3, not just against this repo's dev copy.
- **A failed run now says WHY, instead of "no result available".** The results route answers a terminal failure with `409` and the body *"Run finished with status FAILED; no result available"* — true, and useless: the actual cause (`missing required inputs: illustrations`, `PipeRunInputsError`) was visible only in Temporal. It is a separate artifact — the runner posts it on the completion callback and the platform stores it as `error` on the run row, "surfaced so the webapp can tell the user WHY a run failed instead of a generic message". So a failure needs a second read to be explicable, and the node now performs it, exactly as `pipelex-app` does (`use-method-runs.ts`, whose comment notes the terminal signal "carries only the terminal status, not the reason").

  The panel's *From Pipelex* block is filled from the report too, across both surfaces it offers. n8n's node-error view builds that block from a fixed set of error properties: `httpCode` → *Error code*, `messages` → *Full message*, **`context.data` → *Error data***, `extra` → *Error extra*, `context.request` → *Request*. Only `httpCode` was ever set, which is why the block held one row.

  *Error data* now carries the **whole report** as an aligned key/value block — and it is the one surface that keeps line breaks, because n8n renders it inside `<pre><code>`. Fields print in a stable reading order (what it is → why → where), nested values as indented JSON, then **any field the report carries that this node does not know about**, so a new `ErrorReport` field surfaces without a node release. The `description` line stays a one-line summary for the opposite reason: it is plain text in an HTML context, where newlines collapse — a `\n`-joined block rendered as a run-on sentence with the title running into the next label.

  The description itself is drawn from the report. `NodeApiError` renders exactly three things — `message`, `description`, `httpCode` — and does not dump the attached body, so anything beyond the one-line reason has to be folded into `description` or it is invisible; left to itself n8n picks `error.message` out of the body and repeats the headline sentence verbatim. It carries what the author can act on: the failure `title`, the **`user_action`** (`change input`, `check billing`, `wait and retry`, … plus its free-form detail — the only line that says what to *do*), whether the failure is **`retryable`** (which decides whether n8n's own *Retry On Fail* could ever help), the `error_type` / `error_domain` for branching, provider and model on an inference failure, a count of structured `validation_errors`, the run/pipe/finished-at context, and the **docs URL** for the error class. Every field is optional, so only what is present is emitted — a bare report adds no description rather than a skeleton one.

  On a `409`, the node reads `GET /v1/runs/{id}/status` — the light run read, chosen over `GET /v1/runs/{id}` because both carry the report but the latter also drags `mthds_contents` + `inputs`, the run's whole source. The message becomes `Run FAILED: <reason> [<error_type>]`, keeping the terminal status (a `TIMED_OUT` run reads very differently from a `FAILED` one) and attaching the run row as the error body, so n8n's *Error details* shows `error_type` / `pipe_code` / `finished_at` beside it. **Best-effort by construction:** a non-2xx, an absent report, or a thrown request all leave the original `409` message in place — a failure to explain a failure must never replace it. Only a terminal `FAILED` triggers the extra read; a `403` or `404` does not.
- **The 403 message no longer names an API-key scope that does not exist.** A refused run told the user their key needed to be "admin / `runs:execute`-scoped". There is no per-key scope system in the platform: the run/build/methods surface is gated **per account** (`require_surface_access`, which fails closed), so a perfectly valid key can still be refused and the old wording sent people hunting for a setting that isn't there. The message now names the real cause, points at Pipelex rather than implying a self-service toggle the user does not have, and appends the server's `problem+json` detail as a supporting fact rather than replacing it.
- **A non-text expression in a file field no longer reaches the wire verbatim.** `Python Files` contents invite being fed from an upstream node, and an expression resolving to an object would have been forwarded as-is into an opaque server `422`. Numbers and booleans are coerced (a formatting accident, not a type error); anything else is rejected locally, naming the offending bundle path.

### Changed

- **Breaking: a completed run that delivers no output is now an error instead of an empty item.** A completed run always delivers a `main_stuff` (the pipelex >= 0.37 invariant), and the node used to emit `{ status: "COMPLETED" }` with no output and no signal, so the failure surfaced in whatever node ran next, far from its cause. Workflows that silently tolerated such an item will now fail on it. The check tests for **absence**, never truthiness — an empty list, `0`, `""` and `false` are all valid outputs.

  It is deliberately **not** terminal on first sight. The platform marks a run COMPLETED and then relays whatever artifacts are in storage, so a poll can legitimately land mid-write and see a null `main_stuff` ("missing files come back `null`; the run may be partial mid-write"). Failing there would break workflows whose runs succeeded, so the polling operations retry through that window — bounded, independently of the sustained-outage ceiling — and report the broken invariant only once the state persists, naming the `pipeline_run_id`. `Get Run Result` cannot poll, so it reports the window as `status: "RUNNING"` with a "still being written" message.
- **`pipelex-sdk-js` is now the source of truth for the replicated wire shapes, and `MthdsShapes.ts` is renamed `PipelexApiShapes.ts`.** The shapes were copied from `mthds-js` v0.10.0, which no longer owns the durable run lifecycle — that moved to `@pipelex/sdk`, leaving every "sync against these files" pointer in the old header dead and the copy adrift for ten SDK releases. The header now names the real sources, the version replicated from, and the manual re-sync procedure. Internal rename with no published entry point change, so nothing breaks for consumers.
- **`StartAck.state` is an open `string`, and `state` / `created_at` are optional.** They were typed as a closed six-value union described as "the MTHDS Protocol `RunState` enum". The protocol defines no such enum — `RunResultStart` guarantees `pipeline_run_id` alone and is extension-open; `state` and `created_at` are hosted extensions, and the server types `state` as a free `str`. `Start Pipeline` now emits them only when the server actually sent them, instead of planting `undefined` keys in the item.

### Added

- **Method-first layout, and one unambiguous run source.** The start operations now ask what to run before anything else: **Method ID**, then a **Define Method Inline** toggle that reveals **MTHDS Bundles** + **Python Files**, then Inputs. The two ways to name a method are **mutually exclusive** — setting a `Method ID` alongside an inline one is now an error rather than a silent precedence rule. The hosted API accepts the combination (it runs the inline method and records `method_id` as run-history linkage), so this is a deliberate node-level refusal: with both set, "what is this node running?" has no single answer in the editor. Turning the toggle off also drops whatever it holds from the request, so an abandoned bundle is never sent and never trips the either/or error from a field the user can no longer see. **`MTHDS Bundles` is now a `fixedCollection`** rather than a multi-value string, so it and `Python Files` render the same compact `+ Add …` control — they hold the two halves of one inline method, and as a wide button beside a small one they read as unrelated widgets. Breaking for the stored parameter shape (`{ bundle: [{ content }] }` instead of `string[]`), but a workflow saved with the old shape is still read, so an upgrade does not silently drop the pasted method.

- **`Python Files`: run a method whose custom PipeFunc Python travels with it.** Paste the method into `MTHDS Bundles`, add its `funcs/*.py` / `structures/*.py` / `requirements.txt` under `Python Files`, and the node ships them together as one method bundle.

  This needed more than exposing the wire field, because the protocol makes a bundle **mutually exclusive** with `mthds_contents` — a bundle carries its own `.mthds`. Taken literally, a user with their method in the inline field could not attach a single `.py`. So when Python is attached the node folds the pasted contents into the bundle as generated `.mthds` entries (`main.mthds`, then `bundle-2.mthds`, …, never overwriting a path you supplied) and sends `files` alone. That is exactly the split the server performs on any bundle — `pipelex-api` pulls `.mthds` entries back out into `mthds_contents` and materializes only the rest as a library directory — so the assembly changes nothing about the run, it just removes a manual step.

  Validated locally rather than by round-trip: `Python Files` with nothing pasted in `MTHDS Bundles` (Python is not a method), a path listed more than once (assigning into the map is last-write-wins, so a duplicate silently dropped a file and shipped a bundle the author never configured), and unsafe paths the runner would reject (absolute, `..` traversal, backslashes, Windows drive forms). **Custom Python requires a sandbox-hosted runner** — the hosted Pipelex API is one; a bare self-hosted `pipelex-api` refuses `.py` rather than importing untrusted code in-process. Stated on the field and in the usage guide.

  The API also accepts arbitrary bundle files and a base64-zip bundle. Both were briefly exposed as `Bundle Files` and `Bundle (Base64 Zip)` and are **deliberately not shipped**: they were extra run sources in the editor, for no capability that a pasted method plus its Python does not already cover. `files` remains the wire transport; `bundle_b64` is documented as intentionally unsupported by this node.
- **`tokens_usages` and `usage_assembly_error` are documented.** Both already reached the n8n item (the node relays the result body), but nothing said so. Per-call token counts, model id, the originating `pipe_code`, and a computed USD `cost` are now typed and documented, including the three traps: there is no run-level total (sum the records), `nb_tokens_by_category` is **not** additive (`input` already contains `input_cached`), and `cost: null` (no rate table) differs from `cost: 0` (priced at zero).

### Dev tooling

- **Wire-contract pins (`test/WireContract.test.ts`).** The node **replicates** the Pipelex API contract and imports `@pipelex/sdk` nowhere — the SDK is not a dependency of any kind, runtime or dev. So no test can detect that the SDK moved; what these pins do instead is assert the exact snake_case field names the node sends, the full result-field set it reads, and the HTTP-status → meaning mapping, so editing the replicated shapes is a deliberate act with a failing test rather than a silent drift. The field-name pin is the one that earns its keep: the only wire bug this node has shipped was `dynamic_output_concept_code` for `..._ref`, which the runner discarded silently, and a snake_case typo raises no error anywhere else.
- **The re-sync procedure is documented in `PipelexApiShapes.ts`** — which files in `pipelex-sdk-js` to diff, the version stamp to bump, the pins to update. Replication has no automation by construction; the stale `mthds-js` pointer in the old header is precisely how the copy drifted for ten SDK releases, so the procedure is written down rather than assumed.
- **A pin on the `n8n-workflow` runtime surface.** `tsc` cannot see the host's version, so value imports from `n8n-workflow` are now restricted to a small allowlist of symbols verified present across the majors this node supports (`NodeApiError`, `NodeConnectionTypes`, `NodeOperationError`, `sleep`); adding to it is a deliberate act. The suite's sleep mock also moved off `n8n-workflow` onto our own module, so it can no longer vouch for a host API that does not exist. `@types/node` joins the devDependencies (dev-only — the published tarball still has zero runtime dependencies) so `AbortSignal` and the guard's file reads typecheck.
- **UI-shape pins.** A `fixedCollection` whose add-button has no `placeholder` renders as *nothing* in the editor — which is how `Python Files` shipped invisible once, past both lint and a green test suite (the node's behaviour is exercised through `getNodeParameter`, which does not care whether a field is reachable in the UI). Tests now pin that every `fixedCollection` has a `placeholder`, that `multipleValueButtonText` is never used on one, and that the start fields keep their order (`methodId` → `inlineMethod` → the inline pair → `inputs`) with the pair gated behind the toggle. Field order is the node's explanation of itself, and property order is display order.
- **`make stop` actually stops the dev server, and `make run` is idempotent.** `stop` matched `pkill -f "n8n start"`, but `n8n-node dev` runs n8n as `.../.bin/n8n` with no arguments — so it never matched, orphaned instances survived, and the next `make run` failed with *"port 5678 is already in use"* **after** a clean compile, which reads like a build error. Both targets now work off the port (`N8N_PORT`, default 5678): `stop` sends TERM, escalates to KILL only if the port is still held, and reports either way; `run` clears the port first so it can be re-run without a manual kill.
- **`pnpm run typecheck:test`, wired into `make check` and the Test workflow.** Vitest runs tests through esbuild, which strips types **without checking them** — so the suite was never type-checked at all and a test could pass while asserting against a shape that does not compile. A dedicated `tsconfig.test.json` compiles it for real (it immediately caught one such error).

## [v0.1.0] - 2026-06-12

- **Breaking — migrated to the unified MTHDS API surface (`/v1/*`).** The legacy `/runner/v1/*` and `/platform/v1/*` prefixes are gone: start → `POST /v1/start` (202 `StartAck { pipeline_run_id, state, created_at }`), result → `GET /v1/runs/{pipeline_run_id}/results` (202 + `Retry-After` while running / 200 result / 409 terminal failure), credential test → `GET /v1/auth/verify`. The wire shapes are copy-pasted from `mthds-js` v0.10.0 into `nodes/Pipelex/MthdsShapes.ts` (n8n community nodes cannot ship runtime dependencies, so the SDK is vendored, not imported — sync against the source files named in that header when the contract moves).
- **Breaking — node is now a four-operation node**, mirroring the mthds-js client surface (`start` / `waitForResult` / `getRunResult` — SDK conveniences over the MTHDS Protocol routes). The blocking `Execute` operation (old `POST /runner/v1/pipeline/execute`, which died at the public API's ~30s gateway ceiling) is **deleted**, superseded by durable runs:
  - **Start & Wait for Result** (`startAndPoll`, default) — starts a durable run and polls internally until it finishes. Paste your method + inputs, run, get the result; no Wait-node loop to assemble. Output is `{ status, pipeline_run_id, main_stuff }` — **not** the old `/execute` `pipe_output`.
  - **Start Pipeline** (`start`) — starts a durable run and returns immediately with the StartAck (`{ pipeline_run_id, state, created_at }`). Feed the `pipeline_run_id` to the two operations below — possibly from another workflow branch or a separate scheduled workflow.
  - **Poll & Get Result** (`poll`) — waits for an already-started run by `pipeline_run_id`: same Retry-After-honoring poll loop and Max Wait cap as Start & Wait for Result (the n8n equivalent of mthds-js `waitForResult`).
  - **Get Run Result** (`getResult`) — fetches a run's result once by `pipeline_run_id` (no polling); returns `status: "RUNNING"` while still running. Use it to collect a run that outlived Max Wait, e.g. on a schedule.
  - The published 0.0.x `execute` operation value still executes as a hidden alias of `startAndPoll` (same semantics), so existing saved workflows keep running without edits — it is just no longer offered in the dropdown.
- **Removed the injected "Custom API Call" operation.** n8n adds that dropdown entry to any node whose credential declares a generic `authenticate` block. The credential no longer does: the node builds its `Authorization: Bearer` header explicitly per request, and the credential test request now carries its own auth header — credential verification (`GET /v1/auth/verify`) is unchanged.
- **Max Wait defaults to 300s** (safe under typical n8n Cloud execution caps). On exceed, the polling operations return the `pipeline_run_id` + a "still running" message — a usable output, not an error. `0` waits indefinitely (self-hosted n8n). The poll cadence honors the server's `Retry-After` (5s when absent); a transient 503 mid-poll reads as "still running" (mirroring mthds-js), never a lost run.
- **Breaking — removed the `Poll Interval (Seconds)` field.** Poll cadence is now driven solely by the server's `Retry-After` (5s when absent), so the manual interval knob is gone. Saved workflows that set it will ignore the value after upgrade.
- **Sustained-outage ceiling on polling.** A 503 mid-poll still reads as "still running", but the loop now bounds **consecutive** 503s: after several in a row (a healthy 202 resets the count) it surfaces an actionable "backend unavailable" error carrying the `pipeline_run_id`, instead of polling forever when `Max Wait` is `0`.
- **`method_id` support.** Run a stored method from your org's catalog (hosted-API extension) as an alternative to pasting MTHDS bundles inline. Both together is allowed: the inline bundles run, `method_id` links the run to the stored method in run history.
- **Result output strips `graph_spec` and `done`.** The n8n output drops the heavy `graph_spec` visualization artifact (it just cluttered the item view) and the redundant `done` boolean — `status` (`RUNNING` / `COMPLETED`) is the single completion signal. This is n8n-only: the server's results response still relays `graph_spec` verbatim.
- **Idempotency on start.** Both start operations send an `Idempotency-Key` (n8n execution id + node id + item index) on `POST /v1/start`, so an n8n "Retry On Fail" replays the same run instead of creating a duplicate paid run.
- **Actionable 403.** A run rejected for lack of runs access surfaces a clear "needs an admin / `runs:execute`-scoped key" message — the credential test only validates the token, not run scope.
- **Actionable 404.** A 404 on the results endpoint surfaces a clear message naming both real causes — a bad/expired `pipeline_run_id`, or a credential Base URL pointing at a runner with no durable run lifecycle — instead of a bare "Unexpected response status 404".
- Fixed the runner override field name to `dynamic_output_concept_ref` (the old `_code` spelling was silently discarded by the runner).
- The normalized `status: 'COMPLETED'` literal now wins over any `status` field that a result body might carry — downstream workflow branches always read the node's canonical completion signal.
- Dev tooling: added Vitest unit tests (pure result mapper, request shaping, and both operation flows), wired `pnpm test` into `make check`, and added a Test CI workflow. Vitest is a devDependency only — the node still ships with zero runtime dependencies.
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
