# Usage Guide

## Operations

The Pipelex node has one **Operation** selector with four operations, mirroring the mthds-js client surface (`start` / `waitForResult` / `getRunResult`):

| Operation | What it does | Endpoint |
|---|---|---|
| **Start & Wait for Result** (default) | Start a durable run and poll internally until it finishes, then return the result. The polling is invisible — no Wait-node loop to assemble. | `POST /v1/start` → `GET /v1/runs/{pipeline_run_id}/results` |
| **Start Pipeline** | Start a durable run and return **immediately** with the StartAck — `{ pipeline_run_id, state, created_at }`. No waiting. | `POST /v1/start` |
| **Poll & Get Result** | Wait for an **already-started** run by `pipeline_run_id`: poll until it finishes or Max Wait is exceeded. | `GET /v1/runs/{pipeline_run_id}/results` (polled) |
| **Get Run Result** | Fetch a run's result **once** by `pipeline_run_id` (no polling). `status: "RUNNING"` while still running. | `GET /v1/runs/{pipeline_run_id}/results` |

**Which one to use?**

- **Quick runs** → **Start & Wait for Result**: the common case end to end. It starts the run (a durable, server-side run that survives any gateway timeout) and polls until the result is ready, honoring the server's `Retry-After` (5s cadence when absent). **Max Wait (Seconds)** (default **300**) caps how long the node blocks the n8n execution: on exceed it returns the `pipeline_run_id` + a "still running" message — a usable output, not an error. `0` waits indefinitely (only sensible on self-hosted n8n without execution timeouts).
- **Long runs** → **Start Pipeline** now, then **Poll & Get Result** later — in the same workflow after other work, on another workflow branch, or in a different workflow entirely. Poll & Get Result uses the exact same poll loop and Max Wait semantics, just fed by your `pipeline_run_id` instead of a fresh start.
- **Webhook-style / fire-and-collect** → **Start Pipeline**, store the `pipeline_run_id`, and check in with **Get Run Result** on a schedule: it fetches once, returning `status: "RUNNING"` until the run completes — no blocking anywhere.

Both start operations carry an `Idempotency-Key` derived from the n8n execution, node, and item, so an n8n "Retry On Fail" replays the same run instead of creating a duplicate paid run.

> ℹ️ **Upgrading from 0.0.x?** The old `execute` operation value ("Execute Pipeline") still executes as a hidden alias of **Start & Wait for Result** — saved workflows keep running without edits. And there is no more injected **Custom API Call** entry in the dropdown: the credential no longer declares a generic `authenticate` block (the node sends its own `Authorization` header), which is the trigger n8n uses to inject that raw-HTTP escape hatch.

> ℹ️ **Hosted-only:** the run-lifecycle polling routes (`/v1/runs/*`) and the `Method ID` field are hosted-API extensions, not part of the bare MTHDS Protocol — a bare runner does not implement them.

## Credential: Base URL

The Pipelex API base URL is configured on the credential, not on the node. Open your **Pipelex Bearer Token** credential and set:

**Examples:**

- Hosted API (default): `https://api.pipelex.com` — run access is gated for now; join the [waitlist](https://go.pipelex.com/waitlist).
- Your own server exposing the same hosted surface (`/v1/start`, `/v1/runs/{pipeline_run_id}/results`, `/v1/auth/verify`): `https://your-pipelex-host.example.com` (a self-hosting guide is in the works).

> ⚠️ **Running on n8n Cloud or any deployed n8n instance?** `localhost`/`127.0.0.1` URLs won't be reachable from n8n. Use a Base URL that n8n can reach over the network.

The credential test hits `GET <Base URL>/v1/auth/verify` to verify both reachability and the Bearer Token. Note it only checks the token is **valid** — not that it can **start runs**. Access to the run API is granted per **account**, not per key, so a perfectly valid key can pass the test and still be refused with a `403` on a real run. That is not a key you can re-scope: ask Pipelex to enable API access for your account.

---

## What to run: a stored method, or an inline one

These fields apply to the two start operations (**Start & Wait for Result** and **Start Pipeline**). The node asks for the method first, and offers exactly two ways to name it — **they are mutually exclusive**:

| | How |
| --- | --- |
| **A stored method** (default) | put its id in **Method ID**. It already carries its own Python. |
| **An inline method** | turn on **Define Method Inline**, then paste the bundle into **MTHDS Bundles** (one entry per bundle file) and add any custom PipeFunc Python under **Python Files**. |

Setting a `Method ID` *and* an inline method is an error — "what is this node running?" must have one answer. (The API itself would accept both, running the inline method and filing the run under the stored one in history; the node refuses it deliberately.)

Turning the toggle **off** also removes whatever it holds from the request, so a bundle you pasted and then abandoned is never sent, and never trips the either/or error from a field you can no longer see.

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

The heavy `graph_spec` visualization artifact is stripped from the n8n item (it only cluttered the item view); the API still returns it.

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

