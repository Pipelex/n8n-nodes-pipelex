import { version } from '../../package.json';

/**
 * The `User-Agent` this node sends on every request to the Pipelex API — the
 * three run requests in `GenericFunctions.ts` and the credential test in
 * `credentials/PiplexApi.credentials.ts` — so the platform can attribute the
 * traffic to n8n. The convention is the workspace spec
 * `docs/specs/client-identification.md`.
 *
 * It is a single product token, `n8n-nodes-pipelex/<package version>`. The n8n
 * version would belong in front of it, but a community node cannot read it:
 * `process` is banned by the community lint and no helper exposes it. n8n sets
 * its own default `User-Agent` only when a request carries none, so this one wins.
 *
 * The version is imported from `package.json` rather than typed by hand, so it
 * cannot drift from the published package. The import is relative (allowed by
 * `no-restricted-imports`), and the build already emits `dist/package.json`
 * beside `dist/nodes/`, so the compiled `require` resolves in the tarball.
 */
export const USER_AGENT = `n8n-nodes-pipelex/${version}`;
