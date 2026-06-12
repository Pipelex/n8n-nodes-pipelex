// n8n-specific lint config — exercised by the dedicated "n8n Compliance" CI
// job. Loads only the n8n-nodes-base and @n8n/eslint-plugin-community-nodes
// rule packs (plus the typescript-eslint parser needed to read .ts files).
// Pair with eslint.config.ts.mjs for full coverage.
import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		// `test/**` + `vitest.config.ts` are dev-only and never enter the published
		// tarball (`files: ["dist"]`), so the real `@n8n/scan-community-package`
		// never sees them. Exclude them from the compliance lint too — otherwise the
		// dev `vitest/config` import trips `no-restricted-imports`.
		ignores: ['dist/**', 'node_modules/**', '.venv/**', 'site/**', 'test/**', 'vitest.config.ts'],
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
		},
		extends: [
			n8nCommunityNodesPlugin.configs.recommended,
			importX.configs['flat/recommended'],
		],
	},
	{
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		settings: {
			'import-x/resolver-next': [createTypeScriptImportResolver()],
		},
	},
	{
		files: ['package.json'],
		rules: {
			...n8nNodesBase.configs.community.rules,
		},
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		files: ['./credentials/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.credentials.rules,
			'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
			'n8n-nodes-base/cred-class-field-type-options-password-missing': 'off',
		},
	},
	{
		files: ['./nodes/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.nodes.rules,
			'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
			'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
			'n8n-nodes-base/node-param-type-options-max-value-present': 'off',
		},
	},
);
