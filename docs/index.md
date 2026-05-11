# Pipelex n8n Community Node

Execute Pipelex AI pipelines directly in your n8n workflows.

## Prerequisites

**⚠️ Important:** You must understand Pipelex before using this node!

- 📚 **[Read the Pipelex Documentation](https://docs.pipelex.com/)** first
- 🚀 **[Try the Quick Start Guide](https://docs.pipelex.com/pages/quick-start/)**
- 🍳 **[Explore the Cookbook Examples](https://docs.pipelex.com/pages/cookbook-examples/)**

## What You'll Need

1. **Access to a Pipelex API server**
   - Hosted Pipelex API (Coming Soon): will live at `https://api.pipelex.com` — join the [waitlist](https://go.pipelex.com/waitlist)
   - Self-hosted (available now): [Pipelex API Docker Image](https://hub.docker.com/r/pipelex/pipelex-api)

## Installation

Here is some n8n documentation about [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

## Quick Start

1. **Get API access** — until the hosted API (`https://api.pipelex.com`) opens up, you self-host with Docker (see the [pipelex-api repo](https://github.com/Pipelex/pipelex-api)):
   ```bash
   docker run -p 8081:8081 \
     -e PIPELEX_GATEWAY_API_KEY=your-pipelex-gateway-api-key \
     pipelex/pipelex-api
   ```
   Add `-e AUTH_MODE=api_key -e API_KEY=your-token` if you want the server to require a Bearer Token.

   > ⚠️ **Using n8n Cloud or a deployed n8n instance?** `http://localhost:8081` only works from the same machine as the API. Deploy the Docker image on a host that's reachable from n8n (e.g. a small VM, Render/Fly.io/Railway, or expose it via a tunnel like ngrok) and point the credential's **Base URL** at that public URL.

2. **Add credentials in n8n**:
   - Node → **Credential to connect with** → **Create New**
   - Set **Base URL** (defaults to `https://api.pipelex.com`; for self-hosting use the URL where your Docker image is reachable from n8n — `http://localhost:8081` only works for self-hosted n8n on the same machine)
   - Paste your **Bearer Token**

3. **Configure the node**:
   - Resource: `Pipeline`, Operation: `Execute`
   - Provide either a `Pipe Code` **or** an inline `MTHDS Bundle` (under **Additional Fields**)
   - Set `Inputs` as a JSON object matching your pipeline's expected inputs

4. **Copy paste an example from the [Examples](./examples.md) page**

## Learn more on usage

See [Usage Guide](./usage.md) for detailed parameter descriptions and examples.

## Examples

See [Examples](./examples.md) for real-world workflow examples.

## Need Help?

- 💬 [Discord Community](https://go.pipelex.com/discord)
- 📖 [Main Documentation](https://docs.pipelex.com/)
- 🐛 [Report Issues](https://github.com/pipelex/n8n-nodes-pipelex/issues)

