# Usage Guide

## Node Parameters

### Base URL
The URL of your Pipelex API server.

**Examples:**

- Local Docker: `http://localhost:8081`
- Remote server: `https://api.yourserver.com`
- Public Pipelex API: (Coming Soon, join the waitlist [here](https://go.pipelex.com/waitlist))

---

## Understanding `pipe_code` and `plx_content`

The Pipelex node offers flexibility in how you define and execute pipelines. You can either reference a pre-registered pipeline, provide inline PLX code, or combine both approaches.

### Case 1: Only `pipe_code` (Pipeline Library)

Use this when your pipeline is already registered in your Pipelex API server's library.

**n8n Node Configuration:**
- **Pipe Code:** `invoice_extractor`
- **Pipelex Bundle:** _(leave empty)_
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

### Case 2: Only `plx_content` (Inline Pipeline)

Use this when you want to define the pipeline directly in the n8n node.

**n8n Node Configuration:**
- **Pipe Code:** _(leave empty)_
- **Pipelex Bundle:**
```plx
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
The API will parse your inline PLX code and execute the pipeline specified in `main_pipe`.

**API Request:**
```json
{
  "plx_content": "domain = \"invoice_processing\"\nmain_pipe = \"extract_invoice\"...",
  "inputs": {
    "text": "INVOICE #123..."
  }
}
```

**Important:** You **must** specify `main_pipe` in your PLX content when not providing a `pipe_code`.

**Use this when:**
- You're prototyping or testing pipelines
- You want the pipeline definition visible in n8n
- You don't have access to upload to the server library

---

### Case 3: Both `pipe_code` AND `plx_content` (Inline with Specific Pipe)

Use this when you have multiple pipes in your inline PLX code and want to execute a specific one.

**n8n Node Configuration:**
- **Pipe Code:** `extract_invoice`
- **Pipelex Bundle:**
```plx
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
The API will execute the `extract_invoice` pipe from your inline code, **ignoring** the `main_pipe` setting.

**API Request:**
```json
{
  "pipe_code": "extract_invoice",
  "plx_content": "domain = \"document_processing\"...",
  "inputs": {
    "text": "INVOICE #123..."
  }
}
```

**Use this when:**
- You have a PLX file with multiple pipes
- You want to choose which pipe to execute dynamically
- You want flexibility without modifying the PLX content

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

## Optional Parameters

### Output Name (`output_name`)
Specify the name you want to give to the main pipe

**Example:** `extracted_data`

### Output Multiplicity (`output_multiplicity`)
Controls whether the pipeline returns a single item or multiple items (array).

> **📚 For comprehensive multiplicity documentation**, see **[Understanding Multiplicity](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/understanding-multiplicity/)**.

**Example:** If your pipeline extracts keywords from text and is configured with `output = "Keyword[]"` in the PLX definition, set `output_multiplicity` to `true` to receive an array of all extracted keywords, `n` for a specific number of items.

### Dynamic Output Concept Code (`dynamic_output_concept_code`)
 - `dynamic_output_concept_code` (string, optional): Override output concept. See more [here](https://docs.pipelex.com/pages/build-reliable-ai-workflows-with-pipelex/define_your_concepts/#dynamiccontent).

---

## Learn More

- 📖 [Pipelex API Documentation](https://docs.pipelex.com/pages/api/)
- 📚 [Pipelex Main Docs](https://docs.pipelex.com/)
- 🍳 [Pipelex Cookbook](https://github.com/Pipelex/pipelex-cookbook)
- 💬 [Discord Community](https://go.pipelex.com/discord)

