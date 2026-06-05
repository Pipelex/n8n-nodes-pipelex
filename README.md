<div align="center">
  <a href="https://www.pipelex.com/"><img src="https://raw.githubusercontent.com/Pipelex/pipelex/main/.github/assets/logo.png" alt="Pipelex Logo" width="400" style="max-width: 100%; height: auto;"></a>

  <h1>n8n-nodes-pipelex</h1>
  <h3>Execute Pipelex AI pipelines in your n8n workflows</h3>

  <p>
    <a href="https://www.npmjs.com/package/n8n-nodes-pipelex"><img src="https://img.shields.io/npm/v/n8n-nodes-pipelex.svg" alt="npm version"></a>
    <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
    <a href="https://docs.pipelex.com/"><img src="https://img.shields.io/badge/Docs-03bb95?logo=read-the-docs&logoColor=white&style=flat" alt="Documentation"></a>
  </p>

  <p>
    📦 <a href="https://www.npmjs.com/package/n8n-nodes-pipelex">npm install n8n-nodes-pipelex</a>
  </p>

  <p>
    <a href="#installation">Installation</a> •
    <a href="#what-is-pipelex">What is Pipelex?</a> •
    <a href="#usage">Usage</a> •
    <a href="#examples">Examples</a> •
    <a href="#resources">Resources</a>
  </p>
</div>

---

## What is this?

This is an [n8n](https://n8n.io/) community node that lets you execute [Pipelex](https://github.com/Pipelex/pipelex) AI pipelines directly in your n8n workflows. Transform unstructured data into structured knowledge using repeatable AI operations.

## What is Pipelex?

**[Pipelex](https://github.com/Pipelex/pipelex)** is an open-source runtime to **build and run AI methods**. A *method* is a reusable, typed AI procedure declared in a `.mthds` file and executed by Pipelex — each step is explicit, every output is structured, and every run is repeatable.

Compose "pipes" that route across 60+ models, return structured outputs, and orchestrate sequentially, in parallel, or conditionally — sharing methods with the community via [mthds.sh](https://mthds.sh).

Learn more about Pipelex:

- 📖 [Manifesto: Why Pipelex?](https://go.pipelex.com/manifesto)
- 📚 [Pipelex Documentation](https://docs.pipelex.com/)
- 🚀 [Live Demo](https://go.pipelex.com/demo)
- 🍳 [Cookbook: Ready-to-run Examples](https://github.com/Pipelex/pipelex-cookbook)

---

## Installation

### Prerequisites

This node runs your pipelines through the **Pipelex platform run lifecycle**: it starts a durable run via `POST /platform/v1/runs` and polls for the result internally. The credential's **Base URL** defaults to the hosted platform at **`https://api.pipelex.com`**, but you can point it at any server you run that exposes the same `/platform/v1/runs*` surface.

> 🔑 **On the hosted API (`api.pipelex.com`), run access is gated for now.** Starting runs there currently requires an **admin / `runs:execute`-scoped** key. The credential **Test** only checks that your token is valid, so a non-scoped key will test green but return a clear *"lacks runs access"* error when you actually run a pipeline. Join the [waitlist](https://go.pipelex.com/waitlist) to be notified when self-serve run access opens up.

> ℹ️ **Self-hosting:** running your own backend for this surface is possible — point the credential's Base URL at it. A dedicated self-hosting guide is in the works. Note this node now uses the durable run lifecycle (`/platform/v1/runs` + polling), not the older blocking `/runner/v1/pipeline/execute` endpoint.

### Install the n8n Community Node

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

---

## Credentials

This node requires a **Pipelex API credential** to authenticate with your Pipelex API server. The credential carries both the **Base URL** and the **Bearer Token**.

### Setting up credentials:

1. In your n8n workflow, add a Pipelex node
2. Click on **Credential to connect with** → **Create New Credential**
3. Fill in:
   - **Base URL** — defaults to `https://api.pipelex.com` (the hosted Pipelex platform). Point it at your own server if you self-host the platform run surface.
   - **Bearer Token** — your Pipelex API token (sent as `Authorization: Bearer <token>`)
4. (Optional) Click **Test** — the credential is verified against `GET /platform/v1/auth/verify` on your base URL.

> ⚠️ The credential Test only confirms your token is **valid**, not that it can **start runs**. Running a pipeline needs a key with runs access (admin / `runs:execute` scope, see above). A valid-but-unscoped key passes the Test and then returns an actionable error on Run.

**Where to get your Bearer Token:** create one at [app.pipelex.com](https://app.pipelex.com/). Hosted run access is gated for now — join the [waitlist](https://go.pipelex.com/waitlist).

---

## Node Configuration

The Pipelex node has one **Operation** selector with four operations. Pick based on how long your pipeline runs and whether you want to wait inline:

| Operation | What it does | Endpoint | Returns |
|---|---|---|---|
| **Start & Poll** (default) | Starts a durable run and polls internally until it finishes — paste, run, get the result. Waits indefinitely by default. | `POST /platform/v1/runs` then `GET …/result` | `{ done, status, pipeline_run_id, main_stuff, graph_spec }` |
| **Execute (One-Shot)** | Blocking single request that returns the result directly. **Times out at ~30s on the public Pipelex API** — use Start & Poll for longer runs. | `POST /runner/v1/pipeline/execute` | the runner's `pipe_output` response |
| **Start Run** | Starts a durable run and returns its `pipeline_run_id` immediately (no waiting). Hand the id off anywhere. | `POST /platform/v1/runs` | `{ pipeline_run_id, status, … }` |
| **Poll for Result** | Polls an existing run (by `pipeline_run_id`) until it finishes, then returns the result. The waiting follow-up to Start. | `GET …/by-id/{run_id}/result` | `{ done, status, pipeline_run_id, main_stuff, graph_spec }` |
| **Get Result** | Fetches a run's result **once** by `pipeline_run_id` — no polling. Returns the current state (`done`/`status`); `done: false` while still running. | `GET …/by-id/{run_id}/result` | `{ done, status, pipeline_run_id, main_stuff, graph_spec }` |

**Pipeline-definition fields** (Execute / Start / Start & Poll):

| Parameter | API Field | Description |
|---|---|---|
| **MTHDS Bundles** | `mthds_contents` | One or more inline MTHDS bundles (a `string[]`). Provide at least one **or** a Pipe Code. |
| **Inputs** | `inputs` | JSON object whose keys match your pipeline's expected inputs. Defaults to `{}`. |
| **Pipe Code** | `pipe_code` | Code of the pipe to execute. Provide this **or** MTHDS Bundles (one is required). |
| **Method ID** | `method_id` | *(Start / Start & Poll only)* Optional stored-method reference to associate the run with. |
| **Output Name** | `output_name` | Optional name of the output variable. |
| **Output Multiplicity** | `output_multiplicity` | Optional output multiplicity. |
| **Dynamic Output Concept Ref** | `dynamic_output_concept_ref` | Optional override for the dynamic output concept ref. |

**Polling controls** (Poll for Result / Start & Poll):

| Parameter | Description |
|---|---|
| **Max Wait (Seconds)** | Max seconds to wait for the run to finish. **`0` (default) = wait indefinitely.** If set above 0 and exceeded, the node returns the `pipeline_run_id` + a "still running" message so you can fetch it later with **Poll for Result**. |
| **Poll Interval (Seconds)** | How often to check (default 2). The server's `Retry-After` is honored when it asks for a longer wait. |

**Run target** (Poll for Result / Get Result): **Pipeline Run ID** — the `pipeline_run_id` returned by Start or Start & Poll.

**Note:** You must provide **either** `Pipe Code` **or** `MTHDS Bundles` (or both). Learn more about the Pipelex API [here](https://docs.pipelex.com/pages/api/).

### Input Source: JSON vs Binary File

On Execute / Start / Start & Poll, **Input Source** controls how `inputs` is built:

- **JSON** (default) — type the inputs object in the **Inputs** field.
- **Binary File** — feed a file straight from an upstream node (Gmail, Google Drive, HTTP Request, S3…) with **no converter nodes**. The node reads the item's binary itself and builds a base64 `data:` URL Document/Image input. Fields:
  - **Input Name** — the method's input key (e.g. `invoices`)
  - **Concept** — `Document` or `Image`
  - **Binary Property** — the binary field on the item (e.g. `attachment_0` from the Gmail node, or `data`)
  - **Combine All Items Into One Run** — off = one run per item; on = gather the binary from **every** input item into a single run whose `content` list holds one `{ url }` per file

This is why binary mode matters: n8n stores attachments in a separate binary lane (often on disk), which `{{ }}` expressions can't read. The node uses n8n's binary helper to read the bytes and inline them, so **Gmail → Pipelex** works directly.

**Example — extract every invoice PDF from a batch of Gmail emails in one run:**
1. Gmail → *Get Many Messages* with **Download Attachments** on (invoices arrive as binary `attachment_0`)
2. Pipelex → Start & Poll, **Input Source = Binary File**, Input Name `invoices`, Concept `Document`, Binary Property `attachment_0`, **Combine All Items Into One Run = on**, with your invoice-extraction method in **MTHDS Bundles**

The node sends one request whose `inputs.invoices.content` is `[ {url:data:…pdf1}, {url:data:…pdf2}, … ]`.

---

## Usage

### Quick Start

1. **Add the Pipelex node** to your n8n workflow
2. **Configure the credential** (Base URL + Bearer Token) — defaults to `https://api.pipelex.com`; point it at your own server if you self-host the platform run surface
3. **Pick the operation:**
   - **Start & Poll** (default) — for any pipeline; it waits as long as needed and returns the result
   - **Execute (One-Shot)** — for quick pipelines that finish within the public API's ~30s window
   - **Start Run** → **Poll for Result** — to start a run in one place and collect it in another (the `pipeline_run_id` is the handle)
   - **Get Result** — a one-shot, non-blocking status check by `pipeline_run_id` (returns `done: false` while still running)
4. **Provide the pipeline:** a `Pipe Code` **or** paste inline `MTHDS Bundles`
5. **Set Inputs** as a JSON object matching your pipeline's expected inputs
6. **Run** the workflow

Long-running pipelines: keep **Max Wait** at `0` to wait indefinitely, or set a cap — if it's exceeded you get the `pipeline_run_id` back and fetch the result later with **Poll for Result**. Learn more about the output format [here](https://docs.pipelex.com/pages/api/).

---

## Examples

WIP

---

## Resources

### Documentation
- 📚 **[Pipelex Documentation](https://docs.pipelex.com/)** - Complete guide to building pipelines
- 🔌 **[Pipelex API Documentation](https://docs.pipelex.com/pages/api/)** - API reference and integration guide
- 🔧 **[n8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)** - n8n node development guide

### Community & Support
- 💬 **[Discord Community](https://go.pipelex.com/discord)** - Get help and share your workflows
- 🐛 **[GitHub Issues](https://github.com/pipelex/n8n-nodes-pipelex/issues)** - Bug reports and feature requests
- 🌐 **[Pipelex Homepage](https://www.pipelex.com)** - Learn more about Pipelex

---

## Contributing

We welcome contributions! If you'd like to improve this node:

See [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

Please report bugs and request features via [GitHub Issues](https://github.com/pipelex/n8n-nodes-pipelex/issues).

---

## License

[MIT](LICENSE.md)

This project is licensed under the MIT License. See the LICENSE file for details.

---

## Acknowledgments

Built with ❤️ by the Pipelex team and community.

Special thanks to the [n8n community](https://n8n.io/) for building an amazing automation platform.

---

<div align="center">
  <p>
    <a href="https://go.pipelex.com/discord"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
    <a href="https://www.youtube.com/@PipelexAI"><img src="https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white" alt="YouTube"></a>
    <a href="https://pipelex.com"><img src="https://img.shields.io/badge/Homepage-03bb95?logo=google-chrome&logoColor=white&style=flat" alt="Website"></a>
  </p>

  <p><em>"Pipelex" is a trademark of Evotis S.A.S.</em></p>
  <p><em>© 2025 Evotis S.A.S.</em></p>
</div>

