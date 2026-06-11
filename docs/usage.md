# Usage Guide

## Operations

The Pipelex node has one **Operation** selector with two operations:

| Operation | What it does | Endpoint |
|---|---|---|
| **Execute Pipeline** (default) | Start a durable run and poll internally until it finishes, then return the result. The polling is invisible — no Wait-node loop to assemble. | `POST /v1/start` → `GET /v1/runs/{pipeline_run_id}/results` |
| **Get Run Result** | Fetch a run's result **once** by `pipeline_run_id` (no polling). `status: "RUNNING"` while still running. | `GET /v1/runs/{pipeline_run_id}/results` |

**Execute Pipeline** covers the common case end to end: it starts the run (a durable, server-side run that survives any gateway timeout) and polls until the result is ready, honoring the server's `Retry-After` (5s cadence when absent). **Max Wait (Seconds)** (default **300**) caps how long the node blocks the n8n execution: on exceed it returns the `pipeline_run_id` + a "still running" message — a usable output, not an error. **Get Run Result** is the escape hatch for exactly that case: paste (or map) the `pipeline_run_id` and fetch the result once, e.g. on a schedule or behind your own wait logic. Setting Max Wait to `0` waits indefinitely (only sensible on self-hosted n8n without execution timeouts).

The start request carries an `Idempotency-Key` derived from the n8n execution, node, and item, so an n8n "Retry On Fail" replays the same run instead of creating a duplicate paid run.

> ℹ️ **Hosted-only:** the run-lifecycle polling routes (`/v1/runs/*`) and the `Method ID` field are hosted-API extensions, not part of the bare MTHDS Protocol — a bare runner does not implement them.

## Credential: Base URL

The Pipelex API base URL is configured on the credential, not on the node. Open your **Pipelex Bearer Token** credential and set:

**Examples:**

- Hosted API (default): `https://api.pipelex.com` — run access is gated for now; join the [waitlist](https://go.pipelex.com/waitlist).
- Your own server exposing the same hosted surface (`/v1/start`, `/v1/runs/{pipeline_run_id}/results`, `/v1/auth/verify`): `https://your-pipelex-host.example.com` (a self-hosting guide is in the works).

> ⚠️ **Running on n8n Cloud or any deployed n8n instance?** `localhost`/`127.0.0.1` URLs won't be reachable from n8n. Use a Base URL that n8n can reach over the network.

The credential test hits `GET <Base URL>/v1/auth/verify` to verify both reachability and the Bearer Token. Note it only checks the token is **valid** — not that it can **start runs**. On the hosted API, running a pipeline currently needs an admin / `runs:execute`-scoped key, so a valid-but-unscoped key passes the test and then returns an actionable "lacks runs access" error on Execute Pipeline.

---

## Understanding `pipe_code` and `mthds_contents`

The Pipelex node offers flexibility in how you define and execute pipelines. You can reference a pre-registered pipeline, provide an inline MTHDS bundle, combine both, or run a **stored method** by ID. These fields apply to **Execute Pipeline** (the operation that submits a pipeline).

Inline bundles are set in the **MTHDS Bundles** field and sent as `mthds_contents` (a `string[]` — add one entry per bundle). Alternatively, set **Method ID** (`method_id`) to run a method stored in your org's catalog on the hosted API — its MTHDS source supplies the bundle. Setting both is allowed: the inline MTHDS Bundles are what runs, and `method_id` links the run to the stored method in your run history.

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

These optional fields are surfaced at the top level on the **Execute Pipeline** operation (they are forwarded verbatim to the runner).

### Output Name (`output_name`)
Specify the name you want to give to the main pipe.

**Example:** `extracted_data`

### Output Multiplicity (`output_multiplicity`)
Controls whether the pipeline returns a single item or multiple items (array).

> **📚 For comprehensive multiplicity documentation**, see **[Understanding Multiplicity](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/understanding-multiplicity/)**.

**Example:** If your pipeline extracts keywords from text and is configured with `output = "Keyword[]"` in the MTHDS bundle, set `output_multiplicity` to `true` to receive an array of all extracted keywords, `n` for a specific number of items.

### Dynamic Output Concept Ref (`dynamic_output_concept_ref`)
Override the output concept. See more [here](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/define_your_concepts/#dynamiccontent).

## Polling control (Execute Pipeline)

### Max Wait (Seconds) (`maxWaitSeconds`)
Maximum seconds to wait for the run to finish (**default 300** — safely under typical n8n Cloud execution caps). If exceeded, the node returns the `pipeline_run_id` with a "still running" message — fetch the result later with the **Get Run Result** operation. `0` waits indefinitely (only sensible on self-hosted n8n without execution timeouts). The poll cadence follows the server's `Retry-After` header (5s when absent).

---

## Learn More

- 📖 [Pipelex API Documentation](https://docs.pipelex.com/pages/api/)
- 📚 [Pipelex Main Docs](https://docs.pipelex.com/)
- 🍳 [Pipelex Cookbook](https://github.com/Pipelex/pipelex-cookbook)
- 💬 [Discord Community](https://go.pipelex.com/discord)

