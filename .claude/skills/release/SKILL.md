---
name: release
description: >
  Automates the n8n-nodes-pipelex release workflow: bumps the version in
  package.json, finalizes the CHANGELOG.md Unreleased section, runs quality
  checks, creates a release/vX.Y.Z branch, commits, pushes, and opens a PR to
  main. Use when user says "release", "cut a release", "bump version",
  "prepare a release", "make a release", "ship it", "create release branch",
  or any variation of shipping a new version of the n8n node. The user can
  optionally provide changelog content inline when invoking the skill (e.g.
  "/release Added MTHDS multi-bundle support"), which will be used as the
  changelog entry for this version.
---

# n8n-nodes-pipelex Release Workflow

This skill handles the full release cycle for the `n8n-nodes-pipelex` npm
package. It is a port of the `pipelex` Python release skill, adapted for a
TypeScript/pnpm project published to npm via GitHub Actions.

## Files touched

- **`package.json`** — the `version` field (line 3)
- **`CHANGELOG.md`** — add `[vX.Y.Z] - YYYY-MM-DD` entry (remove `[Unreleased]` if present)

Notes — there is no lockfile to regenerate here: this is a published npm
package, and the lockfile (`pnpm-lock.yaml`) is only used in CI/dev install.
The publish workflow runs `pnpm publish` against the source after merge.

## Workflow

### 1. Pre-flight checks

- Read the current version from `package.json` (line 3, `"version": "X.Y.Z"`).
- Read `CHANGELOG.md` to understand the current state.
- Run `git status` and `git log origin/main..HEAD` to assess the working tree:
  - If there are **uncommitted changes** (staged or unstaged), warn the user
    and ask whether to commit them as part of the release, stash them, or
    abort.
  - If there are **unpushed commits** on the current branch, list them so the
    user is aware — these will be included in the release branch.

### 2. Determine the bump type

Ask the user which kind of version bump they want — **patch**, **minor**, or
**major** — unless they already specified it. Show the current version and
what the new version would be for each option so the choice is concrete.

The package is still pre-1.0 (`0.x.y`); minor bumps for breaking changes are
acceptable, patch bumps for fixes/small additions are typical.

### 3. Run quality checks

Run `make check`. This is the gate — if it fails, stop and report the errors
so they can be fixed before retrying. Do not proceed past this step on
failure.

`make check` runs `pnpm run lint` (source ESLint) and `pnpm run build` (TypeScript
compilation). Both must pass. The optional `make check-dist` re-lints the
compiled JS but is intentionally NOT part of `make check` (see Makefile
comment) — do not run it unless investigating dist-specific issues.

### 4. Ensure we're on the right branch

The release branch must be named `release/vX.Y.Z` where X.Y.Z is the **new**
version. All file modifications (changelog, version bump) must happen on this
branch.

- If already on `release/vX.Y.Z` matching the new version, stay on it.
- If on `dev`, `main`, or any other branch, create and switch to
  `release/vX.Y.Z` from the current HEAD.
- If on a `release/` branch for a **different** version, warn the user and
  ask how to proceed.

The `version-check.yml` and `changelog-check.yml` workflows in this repo
specifically gate on this branch shape — they extract the version from the
branch name and verify it matches `package.json` and `CHANGELOG.md`.

### 5. Finalize the changelog

Add a new version entry at the top of the changelog for the release.

1. If there is an `## [Unreleased]` section, **remove it** (including any
   blank lines that follow it) and replace it with the new version heading.
   Any content that was under `[Unreleased]` becomes the content of the new
   version.
2. If there is no `[Unreleased]` section, insert the new version heading
   directly after the `# Changelog` title.
3. **Never add an `[Unreleased]` heading.** The changelog should only contain
   concrete version entries.
4. If the user provided changelog content when invoking the skill (e.g.
   `/release Added new extract backend`), **merge** that content with any
   existing `[Unreleased]` content (do not discard either source).
5. If the release has no changelog content yet (neither from an `[Unreleased]`
   section nor from inline user input), ask the user what to include before
   proceeding.
6. The existing entries in this repo use plain bullet lists rather than
   `### Added`/`### Changed`/`### Fixed` subheadings — match that style for
   consistency unless the user asks otherwise. Example:

```markdown
# Changelog

## [vX.Y.Z] - YYYY-MM-DD

- One-line summary of the change.
- Another change.

## [vPREVIOUS] - PREVIOUS-DATE
...
```

### 6. Bump the version in package.json

Edit `package.json` line 3 to the new version string. Only change the version
field — don't touch anything else.

Verify the result with: `node -p "require('./package.json').version"` — must
print the new version exactly.

### 7. Commit and push

Stage all release-related changes. This includes at minimum `package.json`
and `CHANGELOG.md`, plus any other files the user chose to include in step 1
(e.g. previously uncommitted work that belongs in this release).

Commit with the message:

```
Release vX.Y.Z
```

Push the branch to origin with `-u` to set up tracking:

```
git push -u origin release/vX.Y.Z
```

### 8. Open a PR

Create a pull request targeting `main` with:

- **Title:** `Release vX.Y.Z`
- **Body:** Include:
  - The changelog entries for this version (copied from CHANGELOG.md)
  - A note about the version bump from old to new

Use this format for the PR body:

```markdown
## Release vX.Y.Z

Bumps version from `A.B.C` to `X.Y.Z`.

### Changelog

<paste the changelog entries for this version here>
```

Report the PR URL back to the user.

## Important details

- The version follows semver: `MAJOR.MINOR.PATCH`.
- Always confirm the bump type with the user before making changes.
- If `make check` fails, the release is blocked — help the user fix the
  issues rather than skipping the checks.
- The CI will validate that:
  - The `package.json` version matches the branch name (`version-check.yml`)
  - The `CHANGELOG.md` has an entry for the version (`changelog-check.yml`)
  - Source ESLint + TypeScript build pass (`quality-checks.yml`)
- All checks must pass for the PR to be mergeable.
- After merging to main, the `publish.yml` workflow publishes the package to
  npm via Trusted Publishing (OIDC) — no manual `npm publish` step needed.
- Today's date for the changelog entry: use the current date in `YYYY-MM-DD`
  format.

## Differences vs the pipelex (Python) release skill

For maintainers porting between the two:

| Concern | pipelex (Python) | n8n-nodes-pipelex (this) |
|---|---|---|
| Version file | `pyproject.toml` line 3 | `package.json` line 3 |
| Lockfile | `uv.lock` regenerated via `make li` | none — `pnpm-lock.yaml` not refreshed during release |
| Quality gate | `make agent-check` | `make check` |
| Test badge | `.badges/tests.json` updated via `make test-count` | none |
| Publish target | PyPI via OIDC | npm via OIDC (`publish.yml`) |

Everything else — branch naming, changelog format, PR shape, CI validators —
is intentionally identical so the two release flows feel the same.
