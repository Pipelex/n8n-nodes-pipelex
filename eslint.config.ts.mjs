// TypeScript-only lint config — exercised by the dedicated "Lint" CI job.
// Mirrors the typescript-eslint half of @n8n/node-cli/eslint without any
// n8n-specific rules; pair with eslint.config.n8n.mjs for full coverage.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		// `test/**` holds dev-only vitest specs (mocks, `any`-typed fakes) — they
		// are not part of the published surface or the n8n compliance contract, so
		// they are excluded from both lint passes and validated by `pnpm test`.
		ignores: ['dist/**', 'node_modules/**', '.venv/**', 'site/**', 'test/**'],
	},
	{
		files: ['**/*.ts'],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			'prefer-spread': 'off',
		},
	},
);
