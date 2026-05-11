# Usage Guide

## Resource & Operation

The Pipelex node exposes a single **Pipeline** resource with an **Execute** operation. It calls `POST /api/v1/pipeline/execute` on your Pipelex API server and waits for the result.

## Credential: Base URL

The Pipelex API base URL is configured on the credential, not on the node. Open your **Pipelex Bearer Token** credential and set:

**Examples:**

- Hosted API (default, **Coming Soon**): `https://api.pipelex.com` — join the [waitlist](https://go.pipelex.com/waitlist) for access.
- Local Docker (self-hosted n8n only): `http://localhost:8081` or `http://host.docker.internal:8081`
- Remote self-hosted server: `https://your-pipelex-host.example.com`

> ⚠️ **Running on n8n Cloud or any deployed n8n instance?** `localhost`/`127.0.0.1` URLs won't be reachable. Deploy the [pipelex-api Docker image](https://hub.docker.com/r/pipelex/pipelex-api) somewhere n8n can reach (a small VM, Render/Fly.io/Railway, or a tunnel like ngrok) and use that public URL.

The credential test hits `GET <Base URL>/api/v1/api_version` to verify both reachability and the Bearer Token.

---

## Understanding `pipe_code` and `mthds_contents`

The Pipelex node offers flexibility in how you define and execute pipelines. You can either reference a pre-registered pipeline, provide an inline MTHDS bundle, or combine both approaches.

The inline bundle is set under **Additional Fields → MTHDS Bundle** and is sent to the API as `mthds_contents` (a JSON array — the node wraps your single bundle as `[mthds_content]`).

### Case 1: Only `pipe_code` (Pipeline Library)

Use this when your pipeline is already registered in your Pipelex API server's library.

**n8n Node Configuration:**
- **Pipe Code:** `invoice_extractor`
- **Additional Fields → MTHDS Bundle:** _(leave empty)_
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
- **Additional Fields → MTHDS Bundle:**
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
- **Additional Fields → MTHDS Bundle:**
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

## Additional Fields (optional)

All optional parameters live under the **Additional Fields** collection on the node.

### MTHDS Bundle (`mthds_contents`)
Inline MTHDS bundle content. The node sends it as a one-element `mthds_contents` array. Provide this if you don't use a pre-registered Pipe Code.

### Output Name (`output_name`)
Specify the name you want to give to the main pipe.

**Example:** `extracted_data`

### Output Multiplicity (`output_multiplicity`)
Controls whether the pipeline returns a single item or multiple items (array).

> **📚 For comprehensive multiplicity documentation**, see **[Understanding Multiplicity](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/understanding-multiplicity/)**.

**Example:** If your pipeline extracts keywords from text and is configured with `output = "Keyword[]"` in the MTHDS bundle, set `output_multiplicity` to `true` to receive an array of all extracted keywords, `n` for a specific number of items.

### Dynamic Output Concept Code (`dynamic_output_concept_code`)
Override the output concept. See more [here](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/define_your_concepts/#dynamiccontent).

---

## Learn More

- 📖 [Pipelex API Documentation](https://docs.pipelex.com/pages/api/)
- 📚 [Pipelex Main Docs](https://docs.pipelex.com/)
- 🍳 [Pipelex Cookbook](https://github.com/Pipelex/pipelex-cookbook)
- 💬 [Discord Community](https://go.pipelex.com/discord)

