// Combined config — runs both the typescript-eslint base rules AND the
// n8n-specific rule packs (n8n-nodes-base + @n8n/eslint-plugin-community-nodes).
//
// Used for local dev (`pnpm run lint` / `make check`) so a single command
// catches everything. CI runs the two halves separately via the dedicated
// configs (eslint.config.ts.mjs, eslint.config.n8n.mjs) so the GitHub status
// checks clearly attribute failures to either "TypeScript lint" or
// "n8n compliance".
import { config } from '@n8n/node-cli/eslint';

export default [
	{
		ignores: ['dist/**', 'node_modules/**', '.venv/**', 'site/**'],
	},
	...config,
];
