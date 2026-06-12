import { defineConfig } from 'vitest/config';

// Vitest is a dev-only dependency: it never ships in the published tarball
// (`files: ["dist"]`) and lives under devDependencies, so the n8n
// "no external runtime dependencies" rule stays satisfied. Tests run against
// the TypeScript sources directly via esbuild — no separate build step.
export default defineConfig({
	// Suppress Vite's warn-level "Sourcemap points to missing source files" noise
	// — it originates from n8n-workflow's own published dist, not our code.
	logLevel: 'error',
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
	},
});
