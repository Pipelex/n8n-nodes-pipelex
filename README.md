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

Before installing this node, you'll need access to a **Pipelex API server**. Choose one option:

#### Option A: Use the hosted Pipelex API (Coming Soon)

The hosted API will live at **`https://api.pipelex.com`** — it's the default Base URL on the credential. Public access isn't open yet; join the [waitlist](https://go.pipelex.com/waitlist) to be notified when it launches.

#### Option B: Self-host with Docker (Recommended for now)

Run your own Pipelex API server using the official image (see the [pipelex-api repo](https://github.com/Pipelex/pipelex-api) for full configuration):

```bash
# Pull the official Docker image
docker pull pipelex/pipelex-api

# Run with a Pipelex Gateway API key (get one at https://app.pipelex.com)
docker run --name pipelex-api -p 8081:8081 \
  -e PIPELEX_GATEWAY_API_KEY=your-pipelex-gateway-api-key \
  pipelex/pipelex-api:latest
```

To require authentication on a self-hosted server, add `-e AUTH_MODE=api_key -e API_KEY=your-secret`. See the [pipelex-api `.env.example`](https://github.com/Pipelex/pipelex-api/blob/main/.env.example) and the [Pipelex API documentation](https://docs.pipelex.com/pages/api/) for full setup details.

> ⚠️ **Running on n8n Cloud or a deployed n8n instance?** `http://localhost:8081` is only reachable from the same machine as the API. Host the Docker image somewhere n8n can reach it — a small VM, a managed host like Render/Fly.io/Railway, or expose it via a tunnel such as ngrok — and use that public URL as the credential's **Base URL**. Only self-hosted n8n on the same machine can use `localhost`/`host.docker.internal`.

### Install the n8n Community Node

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

---

## Credentials

This node requires a **Pipelex API credential** to authenticate with your Pipelex API server. The credential carries both the **Base URL** and the **Bearer Token**.

### Setting up credentials:

1. In your n8n workflow, add a Pipelex node
2. Click on **Credential to connect with** → **Create New Credential**
3. Fill in:
   - **Base URL** — defaults to `https://api.pipelex.com` (hosted API, coming soon). For now use `http://localhost:8081` (or `http://host.docker.internal:8081` from Docker) pointing at your self-hosted server.
   - **Bearer Token** — your Pipelex API token (sent as `Authorization: Bearer <token>`)
4. (Optional) Click **Test** — the credential is verified against `GET /me` on your base URL.

**Where to get your Bearer Token:**
- Hosted API (coming soon at `https://api.pipelex.com`): join the [waitlist](https://go.pipelex.com/waitlist)
- Self-hosting with `AUTH_MODE=api_key`: use the `API_KEY` you set when starting the container

---

## Node Configuration

The Pipelex node exposes a **Pipeline** resource with a single **Execute** operation.

### Required Parameters

| Parameter | API Field | Description |
|-----------|-----------|-------------|
| **Resource** | – | `Pipeline` (only resource for now) |
| **Operation** | – | `Execute` — runs the pipeline and waits for the result |
| **Pipe Code** | `pipe_code` | The code of a pre-registered pipeline to execute. Required unless you provide an `MTHDS Bundle` under Additional Fields. |
| **Inputs** | `inputs` | JSON object whose keys match your pipeline's expected inputs |

### Additional Fields (optional)

All optional inputs are grouped under the **Additional Fields** collection:

| Parameter | API Field | Description |
|-----------|-----------|-------------|
| **MTHDS Bundle** | `mthds_contents` | Inline MTHDS bundle content (sent as a single-element `mthds_contents` array). Provide this if you don't use a pre-registered Pipe Code. |
| **Output Name** | `output_name` | Name of the output variable to surface |
| **Output Multiplicity** | `output_multiplicity` | Control the multiplicity of outputs |
| **Dynamic Output Concept Code** | `dynamic_output_concept_code` | Override the output concept dynamically |

**Note:** You must provide **either** `Pipe Code` **or** `MTHDS Bundle` (or both). Learn more about the Pipelex API [here](https://docs.pipelex.com/pages/api/).

---

## Usage

### Quick Start

1. **Add the Pipelex node** to your n8n workflow
2. **Configure the credential** (Base URL + Bearer Token) — defaults to the upcoming hosted API at `https://api.pipelex.com`; point it at your self-hosted server for now
3. **Pick the operation:** Resource `Pipeline` → Operation `Execute`
4. **Choose execution mode:**
   - **Option A**: Provide `Pipe Code` (for pre-registered pipelines)
   - **Option B**: Open **Additional Fields** and paste inline MTHDS code into `MTHDS Bundle`
5. **Set Inputs** as a JSON object matching your pipeline's expected inputs
6. **Execute** the workflow

The node will return the pipeline execution results, which can be passed to subsequent nodes in your workflow. Learn more about the output format [here](https://docs.pipelex.com/pages/api/).

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

