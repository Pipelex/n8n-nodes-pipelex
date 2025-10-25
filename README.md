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

**[Pipelex](https://github.com/Pipelex/pipelex)** is an open-source language for AI Agents to create and run repeatable AI workflows **with modular, composable pipelines**.

Build modular "pipes" where each uses different LLMs and guarantees structured outputs. Connect them like LEGO blocks — sequentially, in parallel, or conditionally — to build complex knowledge transformations from simple, reusable components.

Learn more about Pipelex:

- 📖 [Manifesto: Why Pipelex?](https://go.pipelex.com/manifesto)
- 📚 [Pipelex Documentation](https://docs.pipelex.com/)
- 🚀 [Live Demo](https://go.pipelex.com/demo)
- 🍳 [Cookbook: Ready-to-run Examples](https://github.com/Pipelex/pipelex-cookbook)

---

## Installation

### Prerequisites

Before installing this node, you'll need a **Pipelex API server** running. Choose one option:

#### Option A: Use Pipelex Cloud API (Coming Soon)
The hosted Pipelex API will be available soon. Join the [waitlist](https://go.pipelex.com/waitlist).

#### Option B: Self-host with Docker (Recommended)
Run your own Pipelex API server using Docker (See more here [Pipelex-api](https://github.com/Pipelex/pipelex-api))

```bash
# Pull the official Docker image
% docker pull pipelex/pipelex-api

# Run with your API key and LLM provider key
% docker run --name pipelex-api -p 8081:8081 \
  -e API_KEY=your-bearer-token-here \
  -e PIPELEX_INFERENCE_API_KEY=your-pipelex-inference-key \
  pipelex/pipelex-api:latest
```

Get a free PIPELEX_INFERENCE_API_KEY ($20 free credits) in our [Discord # 🔑・free-api-key channel](https://go.pipelex.com/discord) or by filling this [form](https://go.pipelex.com/discord/1418228010431025233).

For detailed setup instructions, see the [Pipelex API documentation](https://docs.pipelex.com/pages/api/).

### Install the n8n Community Node

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

---

## Credentials

This node requires **Pipelex API credentials** to authenticate with your Pipelex API server.

### Setting up credentials:

1. In your n8n workflow, add a Pipelex node
2. Click on **Credential to connect with**
3. Select **Create New Credential**
4. Enter your **Bearer Token** (the `API_KEY` you configured in your Pipelex API server)
5. (Optional) Test the credential to verify the connection

**Where to get your API key:**
- If self-hosting: Use the `API_KEY` you set when starting your Pipelex API Docker container
- If using Pipelex Cloud (coming soon): Get it from your Pipelex dashboard

---

## Node Configuration

The Pipelex node supports the following parameters:

### Required Parameters

| Parameter | API Field | Description |
|-----------|-----------|-------------|
| **Base URL** | - | The base URL of your Pipelex API server (e.g., `http://localhost:8081`) (Soon the public API) |
| **Inputs** | `inputs` | JSON object containing the inputs for your pipeline (must match your pipeline's expected inputs) |
| **Pipe Code** | `pipe_code` | The code of a pre-registered pipeline to execute |
| **Pipelex Bundle** | `plx_content` | Inline PLX code to execute (if not using a pre-registered pipeline) |

**Note:** You must provide **either** Pipe Code **or** Pipelex Bundle (or both). Learn more about the Pipelex API [here](https://docs.pipelex.com/pages/api/).

### Optional Parameters

| Parameter | API Field | Description |
|-----------|-----------|-------------|
| **Output Name** | `output_name` | Specify a particular output name to retrieve |
| **Output Multiplicity** | `output_multiplicity` | Control the multiplicity of outputs |
| **Dynamic Output Concept Code** | `dynamic_output_concept_code` | Code for dynamic output concepts |

---

## Usage

### Quick Start

1. **Add the Pipelex node** to your n8n workflow
2. **Configure credentials** (Bearer Token)
3. **Set the Base URL** (e.g., `http://localhost:8081` for local Docker)
4. **Choose execution mode:**
   - **Option A**: Provide `Pipe Code` (for pre-registered pipelines)
   - **Option B**: Provide inline `Pipelex Bundle` (PLX syntax)
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

