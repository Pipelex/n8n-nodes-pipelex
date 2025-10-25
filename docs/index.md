# Pipelex n8n Community Node

Execute Pipelex AI pipelines directly in your n8n workflows.

## Prerequisites

**⚠️ Important:** You must understand Pipelex before using this node!

- 📚 **[Read the Pipelex Documentation](https://docs.pipelex.com/)** first
- 🚀 **[Try the Quick Start Guide](https://docs.pipelex.com/pages/quick-start/)**
- 🍳 **[Explore the Cookbook Examples](https://docs.pipelex.com/pages/cookbook-examples/)**

## What You'll Need

1. **A running Pipelex API server**
   - Public Pipelex API: (Coming Soon, join the waitlist [here](https://go.pipelex.com/waitlist))
   - Self-hosted: [Pipelex API Docker Image](https://hub.docker.com/r/pipelex/pipelex-api)

## Installation

Here is some n8n documentation about [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

## Quick Start

1. **Set up Pipelex API** (more information [here](https://docs.pipelex.com/pages/api/)):
   ```bash
   docker run -p 8081:8081 \
     -e API_KEY=your-token-here \
     -e PIPELEX_INFERENCE_API_KEY=your-key-here \
     pipelex/pipelex-api
   ```

Get a free PIPELEX_INFERENCE_API_KEY ($20 free credits) in the [Discord # 🔑・free-api-key channel](https://go.pipelex.com/discord) or by filling this [form](https://go.pipelex.com/discord/1418228010431025233).

2. **Add credentials in n8n**:
   - Node → **Credential to connect with** → **Create New**
   - Enter your API Bearer Token

3. **Configure the node**:
   - Base URL: `http://localhost:8081` (or your Pipelex server endpoint)
   - Inputs: Your pipeline inputs as JSON
   - Either provide Pipe Code OR Pipelex Bundle

4. **Copy paste an example from the [Examples](./examples.md) page**

## Learn more on usage

See [Usage Guide](./usage.md) for detailed parameter descriptions and examples.

## Examples

See [Examples](./examples.md) for real-world workflow examples.

## Need Help?

- 💬 [Discord Community](https://go.pipelex.com/discord)
- 📖 [Main Documentation](https://docs.pipelex.com/)
- 🐛 [Report Issues](https://github.com/pipelex/n8n-nodes-pipelex/issues)

