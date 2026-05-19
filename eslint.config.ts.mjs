// TypeScript-only lint config — exercised by the dedicated "Lint" CI job.
// Mirrors the typescript-eslint half of @n8n/node-cli/eslint without any
// n8n-specific rules; pair with eslint.config.n8n.mjs for full coverage.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['dist/**', 'node_modules/**', '.venv/**', 'site/**'],
	},
	{
		files: ['**/*.ts'],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			'prefer-spread': 'off',
		},
	},
);
