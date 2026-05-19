// Mirrors the exact ESLint configuration used by @n8n/scan-community-package.
// The scanner downloads the published tarball from npm and runs ESLint on
// `**/*.js` + `**/*.json` inside it. Running this config locally against
// `dist/` (after `pnpm run build`) gives us pre-publish confidence that the
// published artifact will also pass the scanner.
//
// Source we are mirroring (verbatim, as of @n8n/scan-community-package@0.x):
//   defineConfig(
//     n8nCommunityNodesPlugin.configs.recommended,
//     { rules: { 'no-console': 'error' } },
//     { files: ['**/*.json'], languageOptions: { parser: tsParser } }
//   )
import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import tseslint from 'typescript-eslint';

export default [
	{
		ignores: ['node_modules/**', '**/package-lock.json', '**/pnpm-lock.yaml'],
	},
	n8nCommunityNodesPlugin.configs.recommended,
	{
		rules: { 'no-console': 'error' },
	},
	{
		files: ['**/*.json'],
		languageOptions: { parser: tseslint.parser },
	},
];
