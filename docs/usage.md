# Usage Guide

## Operations

The Pipelex node has one **Operation** selector with four operations:

| Operation | What it does | Endpoint |
|---|---|---|
| **Start & Poll** (default) | Start a durable run and poll internally until it finishes, then return the result. Waits indefinitely by default. | `POST /platform/v1/runs` → `GET …/by-id/{run_id}/result` |
| **Execute (One-Shot)** | Blocking single request that returns the result directly. **Times out at ~30s on the public Pipelex API.** | `POST /runner/v1/pipeline/execute` |
| **Start Run** | Start a durable run and return its `pipeline_run_id` immediately (no waiting). | `POST /platform/v1/runs` |
| **Poll for Result** | Poll an existing run by `pipeline_run_id` until it finishes, then return the result. | `GET …/by-id/{run_id}/result` |
| **Get Result** | Fetch a run's result **once** by `pipeline_run_id` (no polling). `done: false` while still running. | `GET …/by-id/{run_id}/result` |

Use **Execute** for quick pipelines that finish inside the ~30s public-API window. Use **Start & Poll** for anything longer (it polls a durable run, so it never hits that ceiling). Use **Start Run** + **Poll for Result** when you want to kick off a run in one place and collect it elsewhere — the `pipeline_run_id` is the handle. Use **Get Result** for a single non-blocking status check (e.g. on a schedule or behind your own wait logic) — it returns `done: false` while the run is still in flight instead of waiting.

The polling operations honor the server's `Retry-After` and expose a **Max Wait (Seconds)** control: `0` (default) waits indefinitely; a positive value caps the wait and, on exceed, returns the `pipeline_run_id` + a "still running" message so you can fetch the result later with **Poll for Result**.

## Credential: Base URL

The Pipelex API base URL is configured on the credential, not on the node. Open your **Pipelex Bearer Token** credential and set:

**Examples:**

- Hosted platform (default): `https://api.pipelex.com` — run access is gated for now; join the [waitlist](https://go.pipelex.com/waitlist).
- Your own server exposing the platform run surface (`/platform/v1/runs*`) and/or the runner (`/runner/v1/pipeline/*`): `https://your-pipelex-host.example.com` (a self-hosting guide is in the works).

> ⚠️ **Running on n8n Cloud or any deployed n8n instance?** `localhost`/`127.0.0.1` URLs won't be reachable from n8n. Use a Base URL that n8n can reach over the network.

The credential test hits `GET <Base URL>/platform/v1/auth/verify` to verify both reachability and the Bearer Token. Note it only checks the token is **valid** — not that it can **start runs**. On the hosted API, running a pipeline currently needs an admin / `runs:execute`-scoped key, so a valid-but-unscoped key passes the test and then returns an actionable "lacks runs access" error on Start/Execute.

---

## Understanding `pipe_code` and `mthds_contents`

The Pipelex node offers flexibility in how you define and execute pipelines. You can either reference a pre-registered pipeline, provide an inline MTHDS bundle, or combine both approaches. These fields apply to **Execute**, **Start**, and **Start & Poll** (the operations that submit a pipeline).

Inline bundles are set in the **MTHDS Bundles** field and sent as `mthds_contents` (a `string[]` — add one entry per bundle).

### Case 1: Only `pipe_code` (Pipeline Library)

Use this when your pipeline is already registered in your Pipelex API server's library.

**n8n Node Configuration:**
- **Pipe Code:** `invoice_extractor`
- **MTHDS Bundles:** _(leave empty)_
- **Inputs:** `{ "invoice_text": "..." }`

**What happens:**
The API will look for a pipeline named `invoice_extractor` in your server's library and execute it.

**API Request:**
```json
{
  "pipe_code": "invoice_extractor",
  "inputs": {
    "invoice_text": "INVOICE #123..."
  }
}
```

**Use this when:**
- You have pipelines uploaded to your server
- You want to reuse the same pipeline across multiple workflows
- You prefer centralized pipeline management

---

### Case 2: Only `mthds_contents` (Inline Pipeline)

Use this when you want to define the pipeline directly in the n8n node.

**n8n Node Configuration:**
- **Pipe Code:** _(leave empty)_
- **MTHDS Bundles:**
```toml
domain = "invoice_processing"
main_pipe = "extract_invoice"

[concept]
InvoiceText = "Raw invoice text"
InvoiceData = "Structured invoice data"

[pipe.extract_invoice]
type = "PipeLLM"
inputs = { text = "InvoiceText" }
output = "InvoiceData"
model = "llm_to_extract_info"
prompt = """
Extract structured data from:
@text
"""
```
- **Inputs:** `{ "text": "..." }`

**What happens:**
The API will parse your inline MTHDS bundle and execute the pipeline specified in `main_pipe`.

**API Request:**
```json
{
  "mthds_contents": ["domain = \"invoice_processing\"\nmain_pipe = \"extract_invoice\"..."],
  "inputs": {
    "text": "INVOICE #123..."
  }
}
```

**Important:** You **must** specify `main_pipe` in your MTHDS bundle when not providing a `pipe_code`.

**Use this when:**
- You're prototyping or testing pipelines
- You want the pipeline definition visible in n8n
- You don't have access to upload to the server library

---

### Case 3: Both `pipe_code` AND `mthds_contents` (Inline with Specific Pipe)

Use this when you have multiple pipes in your inline MTHDS bundle and want to execute a specific one.

**n8n Node Configuration:**
- **Pipe Code:** `extract_invoice`
- **MTHDS Bundles:**
```toml
domain = "document_processing"
main_pipe = "analyze_document"

[concept]
DocumentText = "Raw document text"
InvoiceData = "Structured invoice data"
AnalysisResult = "Document analysis"

[pipe.extract_invoice]
type = "PipeLLM"
inputs = { text = "DocumentText" }
output = "InvoiceData"
model = "llm_to_extract_info"
prompt = "Extract invoice data from: @text"

[pipe.analyze_document]
type = "PipeLLM"
inputs = { text = "DocumentText" }
output = "AnalysisResult"
model = "llm_for_analysis"
prompt = "Analyze: @text"
```
- **Inputs:** `{ "text": "..." }`

**What happens:**
The API will execute the `extract_invoice` pipe from your inline bundle, **ignoring** the `main_pipe` setting.

**API Request:**
```json
{
  "pipe_code": "extract_invoice",
  "mthds_contents": ["domain = \"document_processing\"..."],
  "inputs": {
    "text": "INVOICE #123..."
  }
}
```

**Use this when:**
- You have an MTHDS bundle with multiple pipes
- You want to choose which pipe to execute dynamically
- You want flexibility without modifying the bundle

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

These optional fields are surfaced at the top level on the **Execute**, **Start**, and **Start & Poll** operations (they are forwarded verbatim to the runner).

### Output Name (`output_name`)
Specify the name you want to give to the main pipe.

**Example:** `extracted_data`

### Output Multiplicity (`output_multiplicity`)
Controls whether the pipeline returns a single item or multiple items (array).

> **📚 For comprehensive multiplicity documentation**, see **[Understanding Multiplicity](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/understanding-multiplicity/)**.

**Example:** If your pipeline extracts keywords from text and is configured with `output = "Keyword[]"` in the MTHDS bundle, set `output_multiplicity` to `true` to receive an array of all extracted keywords, `n` for a specific number of items.

### Dynamic Output Concept Ref (`dynamic_output_concept_ref`)
Override the output concept. See more [here](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/define_your_concepts/#dynamiccontent).

## Polling controls (Poll for Result / Start & Poll)

### Max Wait (Seconds) (`maxWaitSeconds`)
Maximum seconds to wait for the run to finish. **`0` (default) waits indefinitely.** If set above 0 and exceeded, the node returns the `pipeline_run_id` with a "still running" message — fetch the result later with the **Poll for Result** operation.

### Poll Interval (Seconds) (`pollIntervalSeconds`)
How often to check whether the run has finished (default 2). The server's `Retry-After` overrides this when it asks for a longer wait.

---

## Binary file input (Gmail / Drive / HTTP → Pipelex)

On **Execute**, **Start**, and **Start & Poll**, the **Input Source** field switches between two ways to supply `inputs`:

- **JSON** — type the inputs object in the **Inputs** field (the default).
- **Binary File** — build a `Document`/`Image` input directly from a file attached to the incoming item, with no Extract-From-File / Aggregate / Code glue.

Why this exists: n8n keeps attachments in a separate **binary** lane (frequently stored on disk), so `{{ $binary.x.data }}` expressions return a storage pointer, not the bytes. The node reads the binary itself with n8n's binary helper and inlines it as a base64 `data:` URL.

Binary-mode fields:

| Field | Meaning |
|---|---|
| **Input Name** | The method's input key the file(s) go under, e.g. `invoices`. |
| **Concept** | `Document` (PDFs, docs…) or `Image`. |
| **Binary Property** | The binary field on the item, e.g. `attachment_0` (Gmail) or `data`. |
| **Combine All Items Into One Run** | Off → one run per item (one file each). On → gather the property from **every** input item into a single run whose `content` holds one `{ url }` per file. |

**Example:** Gmail *Get Many Messages* (Download Attachments on) → Pipelex *Start & Poll*, Input Source **Binary File**, Input Name `invoices`, Concept `Document`, Binary Property `attachment_0`, Combine **on** — extracts every invoice PDF across all fetched emails in one run.

---

## Learn More

- 📖 [Pipelex API Documentation](https://docs.pipelex.com/pages/api/)
- 📚 [Pipelex Main Docs](https://docs.pipelex.com/)
- 🍳 [Pipelex Cookbook](https://github.com/Pipelex/pipelex-cookbook)
- 💬 [Discord Community](https://go.pipelex.com/discord)

