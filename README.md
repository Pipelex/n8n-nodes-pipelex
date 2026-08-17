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

This node runs your pipelines through the **hosted Pipelex API's durable run lifecycle**: it starts a run via `POST /v1/start` and polls `GET /v1/runs/{pipeline_run_id}/results` internally until the result is ready. The credential's **Base URL** defaults to the hosted API at **`https://api.pipelex.com`**.

> 🔑 **On the hosted API (`api.pipelex.com`), run access is gated for now.** It is granted per **account**, not per key — there is no key scope to set. The credential **Test** only checks that your token is valid, so a key on an account without run access tests green and then returns a clear `403` when you actually run a pipeline. Join the [waitlist](https://go.pipelex.com/waitlist) to be notified when self-serve run access opens up.

> ℹ️ **Hosted-only:** the run-lifecycle polling routes (`/v1/runs/*`) and the `Method ID` field are hosted-API extensions, not part of the bare MTHDS Protocol — a bare runner does not implement them. To use your own backend, point the Base URL at a server exposing the same hosted surface (`/v1/start`, `/v1/runs/{pipeline_run_id}/results`, `/v1/auth/verify`).

### Install the n8n Community Node

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

---

## Credentials

This node requires a **Pipelex API credential** to authenticate with your Pipelex API server. The credential carries both the **Base URL** and the **Bearer Token**.

### Setting up credentials:

1. In your n8n workflow, add a Pipelex node
2. Click on **Credential to connect with** → **Create New Credential**
3. Fill in:
   - **Base URL** — defaults to `https://api.pipelex.com` (the hosted Pipelex API). Point it at your own server if you self-host the hosted run surface.
   - **Bearer Token** — your Pipelex API token (sent as `Authorization: Bearer <token>`)
4. (Optional) Click **Test** — the credential is verified against `GET /v1/auth/verify` on your base URL.

> ⚠️ The credential Test only confirms your token is **valid**, not that it can **start runs**. Run access is granted per account (see above), so a valid key on an account without it passes the Test and then returns an actionable `403` on Run — it is not something you can fix by re-scoping the key.

**Where to get your Bearer Token:** create one at [app.pipelex.com](https://app.pipelex.com/). Hosted run access is gated for now — join the [waitlist](https://go.pipelex.com/waitlist).

---

## Node Configuration

The Pipelex node has one **Operation** selector with four operations, mirroring the mthds-js client surface (`start` / `waitForResult` / `getRunResult` — SDK conveniences over the MTHDS Protocol routes):

| Operation | What it does | Endpoint | Returns |
|---|---|---|---|
| **Start & Wait for Result** (default) | Starts a durable run and polls internally until it finishes — paste, run, get the result. The polling is invisible: no Wait-node loop to assemble. If **Max Wait** (default 300s) is exceeded, returns the `pipeline_run_id` with a "still running" message instead of failing. | `POST /v1/start` then `GET /v1/runs/{pipeline_run_id}/results` | `{ status, pipeline_run_id, main_stuff }` |
| **Start Pipeline** | Starts a durable run and returns **immediately** — no waiting. The output's `pipeline_run_id` is the point: feed it to Poll & Get Result or Get Run Result later, even from another workflow branch or a separate scheduled workflow. | `POST /v1/start` | `{ pipeline_run_id, state, created_at }` (the StartAck) |
| **Poll & Get Result** | Waits for an **already-started** run by `pipeline_run_id`: polls until it finishes or Max Wait is exceeded (then the same "still running" output, not an error). | `GET /v1/runs/{pipeline_run_id}/results` (polled) | `{ status, pipeline_run_id, main_stuff }` |
| **Get Run Result** | Fetches a run's result **once** by `pipeline_run_id` — no polling. Returns `status: "RUNNING"` while still in flight, the result when `COMPLETED`. | `GET /v1/runs/{pipeline_run_id}/results` | `{ status, pipeline_run_id, main_stuff }` |

**Which one to use?**

- **Quick runs** → **Start & Wait for Result**: one node, start to result.
- **Long runs** → **Start Pipeline**, then **Poll & Get Result** later (or on another workflow branch) when you actually need the result.
- **Webhook-style / fire-and-collect** → **Start Pipeline**, then **Get Run Result** on a schedule until it reports `COMPLETED`.

> ℹ️ The published 0.0.x `execute` operation value (the old "Execute Pipeline") still executes as a hidden alias of **Start & Wait for Result** — existing saved workflows keep running without edits.

**Pipeline-definition fields** (Start & Wait for Result / Start Pipeline):

| Parameter | API Field | Description |
|---|---|---|
| **Method ID** | `method_id` | ID of a stored method to run (hosted API only). It already carries its own Python. |
| **Define Method Inline** | — | Toggle. Turn on to paste the method here instead of running a stored one; it reveals the two fields below. **Mutually exclusive with Method ID.** |
| **MTHDS Bundles** | `mthds_contents` | Your method, pasted inline — one entry per bundle file. |
| **Python Files** | `files` | Custom PipeFunc Python for the pasted method (`funcs/*.py`, `structures/*.py`, `requirements.txt`). Shipped together with the bundle as one method bundle; requires a sandbox-hosted runner. |
| **Inputs** | `inputs` | JSON object whose keys match your pipeline's expected inputs. Defaults to `{}`. |
| **Pipe Code** | `pipe_code` | Which pipe to run. Empty = the method's `main_pipe`. |
| **Output Name** | `output_name` | Optional name of the output variable. |
| **Output Multiplicity** | `output_multiplicity` | Optional output multiplicity. |
| **Dynamic Output Concept Ref** | `dynamic_output_concept_ref` | Optional override for the dynamic output concept ref. |

**Run target** (Poll & Get Result / Get Run Result): **Pipeline Run ID** — the `pipeline_run_id` returned by Start Pipeline (or by a "still running" output).

**Polling control** (Start & Wait for Result / Poll & Get Result): **Max Wait (Seconds)** — max seconds to wait for the run to finish (**default 300**, safe under typical n8n Cloud execution caps). On exceed, the node returns the `pipeline_run_id` + a "still running" message so you can fetch it later with **Get Run Result**. `0` waits indefinitely (only sensible on self-hosted n8n without execution timeouts). The server's `Retry-After` drives the poll cadence (5s when absent).

**Note:** name the method exactly one way — a `Method ID`, **or** an inline method (`Define Method Inline` + `MTHDS Bundles`). Setting both is an error. Learn more about the Pipelex API [here](https://docs.pipelex.com/pages/api/).

**No "Custom API Call" entry:** n8n injects that raw-HTTP operation into nodes whose credential declares a generic `authenticate` block. This node's credential doesn't (the node builds its `Authorization` header itself), so the dropdown contains only the four curated operations above.

---

## Usage

### Quick Start

1. **Add the Pipelex node** to your n8n workflow
2. **Configure the credential** (Base URL + Bearer Token) — defaults to `https://api.pipelex.com`
3. **Pick the operation:**
   - **Start & Wait for Result** (default) — start the run and get the result in one node; the polling happens internally
   - **Start Pipeline** — start the run and return immediately with its `pipeline_run_id` (collect the result later)
   - **Poll & Get Result** — wait for an already-started run by `pipeline_run_id` until it finishes (or Max Wait)
   - **Get Run Result** — a one-shot, non-blocking fetch by `pipeline_run_id` (returns `status: "RUNNING"` while still running)
4. **Name the method:** a stored `Method ID`, or turn on `Define Method Inline` and paste it into `MTHDS Bundles`
5. **Set Inputs** as a JSON object matching your pipeline's expected inputs
6. **Run** the workflow

Long-running pipelines: **Max Wait** (default 300s) caps how long the polling operations block the n8n execution. If a run outlives it, the node returns the `pipeline_run_id` with a "still running" message — feed that id to **Get Run Result** later (e.g. on a schedule) or to **Poll & Get Result** to keep waiting. Or skip the first wait entirely: **Start Pipeline** now, collect later. Learn more about the output format [here](https://docs.pipelex.com/pages/api/).

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

