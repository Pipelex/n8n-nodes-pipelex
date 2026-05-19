import { config } from '@n8n/node-cli/eslint';

export default [
	{
		ignores: ['dist/**', 'node_modules/**', '.venv/**', 'site/**'],
	},
	...config,
];
