# Usage Guide

## Operations

The Pipelex node has one **Operation** selector with four operations, mirroring the mthds-js client surface (`start` / `waitForResult` / `getRunResult`):

| Operation | What it does | Endpoint |
|---|---|---|
| **Start & Wait for Result** (default) | Start a durable run and poll internally until it finishes, then return the result. The polling is invisible — no Wait-node loop to assemble. | `POST /v1/start` → `GET /v1/runs/{pipeline_run_id}/results` |
| **Start Pipeline** | Start a durable run and return **immediately** with the StartAck — `{ pipeline_run_id, state, created_at }`, plus `method_version` for a stored method. No waiting. | `POST /v1/start` |
| **Poll & Get Result** | Wait for an **already-started** run by `pipeline_run_id`: poll until it finishes or Max Wait is exceeded. | `GET /v1/runs/{pipeline_run_id}/results` (polled) |
| **Get Run Result** | Fetch a run's result **once** by `pipeline_run_id` (no polling). `status: "RUNNING"` while still running. | `GET /v1/runs/{pipeline_run_id}/results` |

**Which one to use?**

- **Quick runs** → **Start & Wait for Result**: the common case end to end. It starts the run (a durable, server-side run that survives any gateway timeout) and polls until the result is ready, honoring the server's `Retry-After` (5s cadence when absent). **Max Wait (Seconds)** (default **300**) caps how long the node blocks the n8n execution: on exceed it returns the `pipeline_run_id` + a "still running" message — a usable output, not an error. `0` waits indefinitely (only sensible on self-hosted n8n without execution timeouts).
- **Long runs** → **Start Pipeline** now, then **Poll & Get Result** later — in the same workflow after other work, on another workflow branch, or in a different workflow entirely. Poll & Get Result uses the exact same poll loop and Max Wait semantics, just fed by your `pipeline_run_id` instead of a fresh start.
- **Webhook-style / fire-and-collect** → **Start Pipeline**, store the `pipeline_run_id`, and check in with **Get Run Result** on a schedule: it fetches once, returning `status: "RUNNING"` until the run completes — no blocking anywhere.

Both start operations carry an `Idempotency-Key` derived from the n8n execution, the node and its run index, and the item. The run index is what keeps the passes of a node inside a loop (Loop Over Items, a back-edge) apart, since each pass numbers its items from 0 again, while a retry keeps it. n8n's "Retry On Fail" re-runs the whole node, every item of it and not only the one that failed, and the key is what keeps that safe: an item that already started its run sends the same key and the same request again, and the platform answers with that run instead of starting a duplicate paid one. An item with [Binary Inputs](#files-from-earlier-nodes-binary-inputs) replays the same way, because the node reuses the files it stored on the first attempt rather than uploading them again (see [Retries](#retries-reuse-the-stored-files)).

> ℹ️ **Upgrading from 0.0.x?** The old `execute` operation value ("Execute Pipeline") still executes as a hidden alias of **Start & Wait for Result** — saved workflows keep running without edits. And there is no more injected **Custom API Call** entry in the dropdown: the credential no longer declares a generic `authenticate` block (the node sends its own `Authorization` header), which is the trigger n8n uses to inject that raw-HTTP escape hatch.

> ℹ️ **Hosted-only:** the run-lifecycle polling routes (`/v1/runs/*`), the upload route behind **Binary Inputs** (`/v1/upload/grant`) and the `Method ID` field, with its version suffixes, are hosted-API extensions, not part of the bare MTHDS Protocol — a bare runner does not implement them.

## Credential: Base URL

The Pipelex API base URL is configured on the credential, not on the node. Open your **Pipelex Bearer Token** credential and set:

**Examples:**

- Hosted API (default): `https://api.pipelex.com` — run access is gated for now; join the [waitlist](https://go.pipelex.com/waitlist).
- Your own server exposing the same hosted surface (`/v1/start`, `/v1/runs/{pipeline_run_id}/results`, `/v1/auth/verify`): `https://your-pipelex-host.example.com` (a self-hosting guide is in the works).

> ⚠️ **Running on n8n Cloud or any deployed n8n instance?** `localhost`/`127.0.0.1` URLs won't be reachable from n8n. Use a Base URL that n8n can reach over the network.

The credential test hits `GET <Base URL>/v1/auth/verify` to verify both reachability and the Bearer Token. Note it only checks the token is **valid** — not that it can **start runs**. Access to the run API is granted per **account**, not per key, so a perfectly valid key can pass the test and still be refused with a `403` on a real run. That is not a key you can re-scope: ask Pipelex to enable API access for your account.

## Client identification (`User-Agent`)

Every request the node sends to the Pipelex API — the upload grant for a binary input, the start, the result polls, the failed-run status read and the credential test — carries `User-Agent: n8n-nodes-pipelex/<package version>` (for example `n8n-nodes-pipelex/0.2.1`), so the platform can tell traffic from n8n apart from the web app, the SDKs or a hand-written call. The value is a single product token because a community node cannot read the n8n version it runs in. It is self-declared and used only for analytics and diagnostics, never for authorization or rate limits. The one request that does not go to the Pipelex API, a binary input's upload to storage, keeps n8n's own `User-Agent`, as the spec asks for a presigned object-store URL. The convention every first-party Pipelex client follows is the client-identification spec, `conformance/specs/client-identification.md` in the `conformance` repository, which holds the cross-repo interface specs.

---

## What to run: a stored method, or an inline one

These fields apply to the two start operations (**Start & Wait for Result** and **Start Pipeline**). The node asks for the method first, and offers exactly two ways to name it — **they are mutually exclusive**:

| | How |
| --- | --- |
| **A stored method** (default) | put its id in **Method ID**, with a suffix when you want a particular version (see [Which version a Method ID runs](#which-version-a-method-id-runs)). It already carries its own Python. |
| **An inline method** | turn on **Define Method Inline**, then paste the bundle into **MTHDS Bundles** (one entry per bundle file) and add any custom PipeFunc Python under **Python Files**. |

Setting a `Method ID` *and* an inline method is an error — "what is this node running?" must have one answer. (The API itself would accept both, running the inline method and filing the run under the stored one in history; the node refuses it deliberately.)

Turning the toggle **off** also removes whatever it holds from the request, so a bundle you pasted and then abandoned is never sent, and never trips the either/or error from a field you can no longer see.

> **Upgrading from 0.1.0?** A node configured before this toggle existed will refuse to run until you switch it on, with an error saying so. That is deliberate: in 0.1.0 an inline bundle took precedence over a `Method ID`, so quietly defaulting to "toggle off" would have run the *stored* method instead — a different method, with no error. Switch the toggle on to keep running the pasted method, or clear `MTHDS Bundles` to run the stored one.

### Which version a Method ID runs

A stored method keeps a draft, which you edit, and the versions published from it, each fixed once published. The **Method ID** says which of them runs:

| Method ID | What runs |
| --- | --- |
| `mt_abc123` | The latest published version. A method that was never published has none, so the start is refused (`409`, `method_not_published`) with a message naming the `@draft` form: run the draft with `@draft`, or publish the method first. |
| `mt_abc123@3` | Version 3, and still version 3 after later publishes. A version that was never published is refused (`404`, `method_version_not_found`). |
| `mt_abc123@draft` | The draft as it stands when the run starts, published or not. |

A bare id follows the method as it is published, so the workflow picks up each new version on its next run without an edit. Pin a version when the workflow must keep running exactly what it was built against, and use `@draft` while you are still editing the method and want each run to take your latest changes.

The node sends the id exactly as you type it, trimmed of surrounding spaces, and the Pipelex API reads the suffix. After the `@` it accepts a version number without a leading zero, or `draft` in lower case; anything else is refused with a `422`, and the error on the item is the API's own explanation of what a suffix may be.

Both start operations add `method_version` to their item: the number of the version that ran, or `draft`. A workflow that runs a bare id can therefore tell which version it got. **Poll & Get Result** and **Get Run Result** read a run by its `pipeline_run_id` alone, and their items do not carry it.

### Custom PipeFunc Python

`MTHDS Bundles` carries `.mthds` text only. If your method's pipes use custom **PipeFunc Python**, add those files under **Python Files** — one row each — and the node ships them together with the pasted method as a single bundle:

| Path | Content |
| --- | --- |
| `funcs/score.py` | the custom PipeFunc |
| `structures/models.py` | custom structured outputs |
| `requirements.txt` | extra Python deps (may be empty) |

Paths are relative to the bundle root, use forward slashes, and must match what your method references. Leave the field empty unless your method uses PipeFunc.

Checked before anything is sent, so you get an immediate error on the item instead of a server `422`: Python Files with nothing pasted in `MTHDS Bundles` (Python is not a method), and unsafe paths like `../x.py`. An empty row is dropped; **blank content is kept**, since an empty `requirements.txt` is legitimate.

> **Custom Python requires a sandbox-hosted runner.** The hosted Pipelex API is one. A bare self-hosted `pipelex-api` refuses a bundle containing `.py` rather than importing untrusted code into its own process.

Under the hood the node sends one `files` map, with the pasted method folded in as `main.mthds` (then `bundle-2.mthds`, …). That is the same split the server performs on any bundle — `.mthds` entries become the method, everything else is materialized beside it — so the run is identical either way.

### Pipe Code

Optional, and independent of the choice above: **Pipe Code** names which pipe to run. Leave it empty to use the method's declared `main_pipe`; set it to pick a different pipe out of the method (or to name a pipe already registered in a self-hosted server's library, which is a run source on its own).

An inline method with no `main_pipe` and no **Pipe Code** has nothing to run.

---

## Inputs Parameter

> **📚 For comprehensive input format documentation**, including all cases and advanced usage patterns, see the **[Pipelex API Guide: Input Format (PipelineInputs)](https://docs.pipelex.com/pages/api/#input-format-implicitmemory)**.

The `inputs` parameter must be a JSON object where keys match the concept names in your pipeline.

### Basic Example
```json
{
  "invoice_text": "INVOICE #INV-001\nAmount: $500",
  "customer_name": "Acme Corp"
}
```

### Using n8n Expressions
Pass data from previous nodes:

```json
{
  "document_text": "{{ $json.content }}",
  "file_name": "{{ $json.filename }}",
  "timestamp": "{{ $now }}"
}
```

### From Previous Node
```json
{
  "text": "{{ $('HTTP Request').item.json.body }}",
  "metadata": {
    "source": "{{ $json.source }}",
    "user": "{{ $json.user_id }}"
  }
}
```

---

## Files from earlier nodes: Binary Inputs

Files travel through n8n as **binary data** on the item: a Gmail trigger puts each attachment in its own binary field (`attachment_0`, `attachment_1`, …), and the Google Drive **Download** operation puts the file in `data`. A method input whose concept is a `Document` or an `Image` (or refines one) takes a file reference instead, and **Binary Inputs** bridges the two. Each row names a method input and the binary field that fills it:

| Row field | What it is |
| --- | --- |
| **Input Name** | The method input to fill, named as you would key it in **Inputs** (for example `document`). |
| **Input Binary Field** | The binary field on the incoming item that holds the file. Defaults to `data`. |

For each row, on each item, the node uploads the file to Pipelex storage and adds the input to the run's inputs, keeping the file name and MIME type n8n carries:

```json
{
  "document": {
    "url": "pipelex-storage://…/3f2c9a….pdf",
    "filename": "invoice.pdf",
    "mime_type": "application/pdf"
  }
}
```

The other inputs still come from the **Inputs** JSON, and the two are merged into one set of inputs.

### Example: a Gmail attachment into a method's `Document` input

Take a stored method that reads an invoice from its `document` input, a `Document`, and writes its summary in the language given by its `language` input.

1. A **Gmail Trigger** with *Download Attachments* switched on. Each email arrives as one item, with its first attachment in the binary field `attachment_0`.
2. A **Pipelex** node on **Start & Wait for Result**:
    - **Method ID**: the stored method's id, such as `mt_abc123` to run its latest published version
    - **Inputs**: `{"language": "fr"}`
    - **Binary Inputs** → **Add Binary Input**: Input Name `document`, Input Binary Field `attachment_0`

A Google Drive flow is the same, with a **Google Drive** node on **Download** in front of the Pipelex node: the downloaded file lands in `data`, which is the row's default, so only the Input Name needs filling.

### Rules

- **An input is given one way.** An input named in Binary Inputs must not also be a key of Inputs: the node refuses the item rather than picking one, since either choice would silently drop a value you set. The same goes for a row naming an input twice. A row with an empty Input Name is ignored.
- **Everything is checked before anything is sent.** A binary field missing from the item fails it with the list of the binary fields the item does carry, and so does an empty (0-byte) file or one over the size limit; nothing is uploaded and no run is started. The sizes are read from the metadata n8n keeps, so this check loads no file.
- **One file in memory at a time.** The node loads a file only to upload it, and lets it go before loading the next, so an item with several large attachments never holds them all at once.
- **The binary mode.** In a workflow whose binary mode is *separate* (n8n's default), Input Binary Field names a field under the item's binary data; in one whose binary mode is *combined*, where n8n keeps files inside the item's JSON, it is the path to the file there. The node resolves it with n8n's own helper, so either mode works.
- **The file name and type** are n8n's. When the name has no extension, the node adds the one n8n recorded for the file, or failing that the one of its MIME type, since the stored object keeps the extension: a Drive export named `Invoice` is stored as `Invoice.pdf`. When n8n only knows `application/octet-stream`, the file extension decides the type (`.pdf`, `.png`, `.jpg`, …), and when neither knows, `mime_type` is left out of the input so the method is never told the wrong type.
- **Size:** the hosted API accepts files up to 50 MiB. The node refuses a larger one itself, from n8n's metadata, before loading it.
- **Where the bytes go:** the node asks the Pipelex API for an upload grant (`POST /v1/upload/grant`), then sends the file straight to Pipelex storage in one `PUT` to the address the grant names. The n8n instance must therefore reach that storage host as well as the API — worth knowing on a self-hosted n8n behind an egress allowlist. The `PUT` has a deadline of a minute plus a second for every 128 KiB of the file, counted from the start of the request; an upload that runs out of time fails the item saying it is unknown whether storage kept the file, and one whose connection never opened fails it saying storage was not reached.
- **A failed upload fails the item before any run is created.** With *Continue On Fail*, the reason lands in the item's `error` field. An execution cancelled while its files were being stored starts no run either: the node checks for the cancel just before the start.
- **Top-level inputs only.** A file nested inside a structured input, or a list of files, still goes through **Inputs** as JSON, with an `http(s)` URL the runner can fetch.
- **Hosted API only.** A Base URL without the upload route fails the item with a message saying so; on such a server, pass the file as an `http(s)` URL in Inputs.

### Retries reuse the stored files

n8n's *Retry On Fail* runs the whole node again, every item of it, not only the item that failed. A JSON-only item that had already started its run replays it through its `Idempotency-Key`. For an item with binary inputs, the node remembers the reference each file was stored under, and a retry in the same execution reuses it instead of uploading the file again: the request is the same as on the first attempt, so is its key, and the platform answers with the run that attempt started rather than starting a second paid one.

A stored file is reused only for the same execution, node, run of the node (a loop's next pass is a new run and uploads again), item and input, with the same bytes (compared by their SHA-256), file name, MIME type and credential Base URL, and only once storage has accepted it. Anything else uploads the file again and starts a new run, which the node keeps from being refused as a conflicting request by folding the files' references into the `Idempotency-Key`: an item whose file changed between attempts, an upload that failed on the first attempt, or a retry the node no longer remembers.

The memory lives in the n8n process for up to 24 hours, the platform's own idempotency window, and holds a bounded number of files, the oldest leaving first. A retry runs in the same process as its execution, so it finds what it needs; a restarted n8n forgets, and so does a manual *Retry* from the executions list, which is a new execution.

---

## Optional output controls

These optional fields are surfaced at the top level on both start operations (they are forwarded verbatim to the runner).

### Output Name (`output_name`)
Specify the name you want to give to the main pipe.

**Example:** `extracted_data`

### Output Multiplicity (`output_multiplicity`)
Controls whether the pipeline returns a single item or multiple items (array).

> **📚 For comprehensive multiplicity documentation**, see **[Understanding Multiplicity](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/understanding-multiplicity/)**.

**Example:** If your pipeline extracts keywords from text and is configured with `output = "Keyword[]"` in the MTHDS bundle, set `output_multiplicity` to `true` to receive an array of all extracted keywords, `n` for a specific number of items.

### Dynamic Output Concept Ref (`dynamic_output_concept_ref`)
Override the output concept. See more [here](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/define_your_concepts/#dynamiccontent).

## Polling control (Start & Wait for Result / Poll & Get Result)

### Max Wait (Seconds) (`maxWaitSeconds`)
Maximum seconds to wait for the run to finish (**default 300** — safely under typical n8n Cloud execution caps). If exceeded, the node returns the `pipeline_run_id` with a "still running" message — fetch the result later with the **Get Run Result** operation, or keep waiting with **Poll & Get Result**. `0` waits indefinitely (only sensible on self-hosted n8n without execution timeouts). The poll cadence follows the server's `Retry-After` header (5s when absent).

---

## Reading the result

A completed run produces one item:

| Field | What it is |
| --- | --- |
| `status` | always `COMPLETED` on a finished run, or `RUNNING` on a still-running output. This is the **single** completion signal — branch on it, never on anything else |
| `pipeline_run_id` | the run's id — keep it if you may need to re-fetch |
| `main_stuff` | your method's output. Polymorphic: a list output arrives as a top-level array, a structured output as an object |
| `working_memory` | every named value the run produced, not just the main output |
| `tokens_usages` | one record per inference call — see below |
| `usage_assembly_error` | non-null only when usage accounting itself failed |
| `method_version` | which version of a stored method ran: its number, or `draft`. Only on the items of the two start operations, and only for a run started from a **Method ID** (see [Which version a Method ID runs](#which-version-a-method-id-runs)) |
| `pipe_io_contracts`, `input_form`, `output_form` | the run's I/O descriptions from the MTHDS standard, keyed by pipe: each pipe's input and output contracts, and form descriptors for its inputs and its output. `null` for a run that did not write them |

The heavy `graph_spec` visualization artifact (the run graph) is not part of the item. The node does not even download it: its result reads ask the API for every artifact except `graph_spec` (`GET /v1/runs/{pipeline_run_id}/results?artifacts=…`), which keeps each poll light. A server that predates that parameter ignores it and sends the graph anyway, and the node then strips it, so the item is the same either way.

A completed run **always** delivers a `main_stuff` — but not always the instant it turns COMPLETED. The run is marked complete as soon as it finishes, then its artifacts are written to storage, so a fetch landing in that window sees a complete run with no output yet. The node handles the two cases differently:

- **Start & Wait for Result / Poll & Get Result** keep polling through the window and return the result once it lands. Only if the output never arrives do you get an error, and it names the `pipeline_run_id` to report.
- **Get Run Result** cannot wait, so it returns `status: "RUNNING"` with a "result is still being written" message — fetch again with the same `pipeline_run_id`.

Either way you never receive an empty `COMPLETED` item that breaks a later node instead.

### When a run fails

A failed run raises an error on the item (or, with **Continue On Fail**, lands in `error`) carrying the reason, not just the fact:

```
Run FAILED: Live run of PipeSequence 'build_client_quote': missing required
inputs: illustrations. These optional inputs may be omitted: comments.
[PipeRunInputsError]
```

The terminal status is kept because it matters — `TIMED_OUT` and `CANCELLED` read very differently from `FAILED`.

n8n's **Error details → From Pipelex** panel summarises the rest of the report, when Pipelex supplies it:

```
Pipe run inputs
What to do: change input — Provide the illustrations input
Retryable: no — re-running will fail the same way until the cause is fixed.
Error: PipeRunInputsError · pipe_run
Context: run mt_… · pipe build_client_quote · finished 2026-08-17T16:01:54Z
Docs: https://docs.pipelex.com/latest/errors/pipe-run-inputs-error/
```

Expand **Error data** in the same panel for the complete report — every field the runner sent, as an aligned block:

```
title            Pipe run inputs
message          missing required inputs: illustrations
error_type       PipeRunInputsError
type_uri         https://docs.pipelex.com/latest/errors/pipe-run-inputs-error/
pipeline_run_id  run_61fd9c76-f718-4fb3-b5cf-c52b2435538d
pipe_code        build_client_quote
status           FAILED
finished_at      2026-08-17T16:15:45.863069+00:00
```

Two lines in the summary are worth acting on directly: **What to do** is the runner's own advice for this error class, and **Retryable** tells you whether n8n's *Retry On Fail* could ever help — on a `no`, retrying will fail identically until you change something. An inference failure also names the provider and model.

If Pipelex cannot supply a reason — the report has not landed yet, or the extra read fails — you get the generic *"Run finished with status FAILED; no result available"* plus the `pipeline_run_id`. The run still failed; only the explanation is missing.

### Token usage and cost

`tokens_usages` carries one record per inference call — LLM, image generation, extraction and search alike:

```json
{
  "model_type": "llm",
  "inference_model_name": "gpt-4o",
  "pipe_code": "extract_invoice",
  "nb_tokens_by_category": { "input": 1240, "input_cached": 1024, "output": 88 },
  "cost": 0.0031,
  "started_at": "2026-08-17T10:00:00Z",
  "completed_at": "2026-08-17T10:00:04Z"
}
```

Because `pipe_code` is on each record, per-pipe cost attribution works without any extra lookup. Three things to get right:

- **There is no run-level total.** Sum `cost` across the records yourself.
- **`nb_tokens_by_category` is not additive.** `input` is already the joined total and `input_cached` is a *subset* of it — adding the categories together double-counts.
- **`cost: null` and `cost: 0` mean different things.** `null` means the model has no rate table at all (own-GPU, mock, dry run); `0` means it was priced and came to zero.

`tokens_usages` is `null` in three different situations — usage accounting was off, it broke, or the run predates the artifact — and `[]` when it ran but no inference happened. Only `usage_assembly_error` distinguishes "broke" from the others, so branch on that field rather than on the list being empty.

---

## Learn More

- 📖 [Pipelex API Documentation](https://docs.pipelex.com/pages/api/)
- 📚 [Pipelex Main Docs](https://docs.pipelex.com/)
- 🍳 [Pipelex Cookbook](https://github.com/Pipelex/pipelex-cookbook)
- 💬 [Discord Community](https://go.pipelex.com/discord)

