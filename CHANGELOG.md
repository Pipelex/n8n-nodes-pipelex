# Changelog

## [v0.0.6] - 2026-05-11

- Applied n8n review feedback: moved `Base URL` to a credential field, added required `Resource`/`Operation` selectors, grouped optional properties under `Additional Fields`, switched inputs/outputs to `NodeConnectionTypes.Main`, replaced raw `Error` throws with `NodeOperationError`, and pointed the credential test at the production API instead of `127.0.0.1`.
- Updated the request payload to the new Pipelex API schema (`mthds_contents` in place of `plx_content`) and made `https://api.pipelex.com` the default credential Base URL (hosted API coming soon — for now point the credential at your self-hosted Pipelex API).
- Removed the `pnpm.overrides` block from `package.json`.

## [v0.0.5] - 2025-11-04

- Updated the documentation.

## [v0.0.4] - 2025-10-26

- Update README and docs

## [v0.0.3] - 2025-10-25

- Update the support email to `oss@pipelex.com`

## [v0.0.2] - 2025-10-25

- Fix the deployment process

## [v0.0.1] - 2025-10-23

- Initial commit!
