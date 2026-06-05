# Pipelex n8n Community Node

Execute Pipelex AI pipelines directly in your n8n workflows.

## Prerequisites

**⚠️ Important:** You must understand Pipelex before using this node!

- 📚 **[Read the Pipelex Documentation](https://docs.pipelex.com/)** first
- 🚀 **[Try the Quick Start Guide](https://docs.pipelex.com/pages/quick-start/)**
- 🍳 **[Explore the Cookbook Examples](https://docs.pipelex.com/pages/cookbook-examples/)**

## What You'll Need

1. **Access to a Pipelex API**
   - Hosted Pipelex platform at `https://api.pipelex.com` (default) — run access is gated for now; join the [waitlist](https://go.pipelex.com/waitlist)
   - Or your own server exposing the platform run surface (self-hosting guide in the works)

## Installation

Here is some n8n documentation about [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/).

## Quick Start

1. **Get API access** — the node defaults to the hosted Pipelex platform at `https://api.pipelex.com`. Run access there is gated for now (admin / `runs:execute`-scoped key) — create a key at [app.pipelex.com](https://app.pipelex.com/) and join the [waitlist](https://go.pipelex.com/waitlist). You can also point the Base URL at your own server that exposes the platform run surface (a self-hosting guide is in the works).

2. **Add credentials in n8n**:
   - Node → **Credential to connect with** → **Create New**
   - Set **Base URL** (defaults to `https://api.pipelex.com`; point it at your own server if you self-host)
   - Paste your **Bearer Token**

3. **Configure the node**:
   - Pick an **Operation**: `Start & Poll` (default — starts a run and waits for the result), `Execute (One-Shot)` (blocking, ~30s public-API cap), `Start Run` → `Poll for Result` (start now, wait later by `pipeline_run_id`), or `Get Result` (one-shot, non-blocking status check)
   - Provide either a `Pipe Code` **or** inline `MTHDS Bundles`
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

