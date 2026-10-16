---
name: release
description: >
  Cut a release of n8n-nodes-pipelex, the Pipelex community node published to
  npm: the release/vX.Y.Z worktree, the package.json bump, the changelog entry,
  the quality gates, one commit, and a pull request to main. Use when the user
  says "release", "cut a release", "bump version", "prepare a release", "make a
  release", "ship it", "create release branch", "promote dev to main", "tag a
  version", or any variation of shipping a new version of the n8n node.
  Changelog content passed inline ("/release Added MTHDS multi-bundle support")
  becomes the entry. The merge is landed by /ledger-land, never by this skill.
---

# Releasing n8n-nodes-pipelex

The procedure is the workspace release play, [`docs/releasing.md`](../../../../docs/releasing.md) at the workspace root — read it first, then run it with what follows. The repo key is `n8n-nodes-pipelex`, the base is `dev`, and the pull request targets `main`: `guard-branches.yml`'s `gate-main` job refuses any head branch into `main` that is not `release/vX.Y.Z`, so there is no other way in. The release worktree is `_n8n-nodes-pipelex--release`, made with `wt add n8n-nodes-pipelex release --branch release/vX.Y.Z`.

## What ships

The merge to `main` publishes, from the two workflows that fire on the push:

- **The `n8n-nodes-pipelex` package on npm**, by `publish.yml` — `make install`, `pnpm run build`, npm upgraded to the 11 line (`npm install -g npm@11`, pinned there deliberately because npm 12 refuses the Node 20 runner the job uses, and the workflow's comment says to raise it only together with `node-version`), then `npm publish --access public --provenance` through npm Trusted Publishing, which is what the job's `id-token: write` permission is for. Nothing stands between a push to `main` that did not bump the version and that publish step: `version-check.yml` runs on pull requests only, and the publish job carries no "skip existing" escape. `package.json` wraps that command in lifecycle hooks of its own — `prepublishOnly` runs the build again and `postpublish` sleeps ten seconds and runs `make check-published` — so the build and the scanner each run a second time inside the publish step, and anyone who runs `npm publish` by hand gets both without asking.
- **The GitHub Release, the `vX.Y.Z` tag, and a `dist` zip**, by the same workflow's `github-release` job — it reads the version back out of `package.json`, slices the notes out of `CHANGELOG.md` between the `## [vX.Y.Z] - ` heading and the next `## [v…] - ` one, and creates the release with `gh release create`, which is what makes the tag. When it finds no heading for that version the step warns, empties the notes and exits 0, so the Release ships carrying the bare line `Release vX.Y.Z` instead of failing. The notes are not the changelog verbatim: blank lines are deleted and every line's leading whitespace stripped, so an entry's indented continuation paragraphs read differently there than in the file. The `dist/` tree is zipped into `n8n-nodes-pipelex-vX.Y.Z-dist.zip` and attached with `--clobber` as the offline mirror of the npm package.
- **The documentation site**, by `deploy-docs.yml` — `mkdocs gh-deploy --force --clean` onto `gh-pages`, served at <https://pipelex.github.io/n8n-nodes-pipelex/>.

The landing verifies the publish — the run, the registry's answer, the tag. `publish.yml` fires on the push to `main`, so its run is keyed to the merge commit, exactly as the play describes it:

```bash
gh run list --workflow=publish.yml --branch main --limit 3 --json conclusion,headSha,url  # the run whose headSha is the merge SHA: success
npm view n8n-nodes-pipelex version                                                        # the registry's answer: X.Y.Z
git fetch --tags --prune origin && git tag --list vX.Y.Z                                  # the tag
```

`gh release view vX.Y.Z` confirms the Release and its notes. **A green publish run is not evidence the n8n scanner passed.** The workflow's "Verify published package" step runs `make check-published`, whose recipe ends in `|| echo "Note: Scanner checks the published npm package"`, so a scanner failure prints that note and the step still succeeds — the opposite of the intent stated in the workflow's own comment beside it. Read the step's log rather than the run's conclusion. The package is on npm by then either way, so the only remedy for what the scanner finds is a follow-up patch release.

## Version files and the lock

- **`package.json`** — the `version` field, the one and only place the number is written; nothing else in the tree restates it. Read it back with `node -p "require('./package.json').version"`, which is the same command `version-check.yml` and `publish.yml` both use.
- **The lock** — there is none to update. `pnpm-lock.yaml` is named in `.gitignore` and is not tracked, so this repo has no lock step and no CI lock check; the workflows that need dependencies install them with `make install` from `package.json` alone.
- **Also stamped:** nothing. No badge, no version literal, no exported artifact carries the number.

## Gates

Run in the worktree, before the commit:

1. **`make check`** — `pnpm run lint`, `pnpm run build`, `pnpm run scan:simulate`, `pnpm run typecheck:test` and `pnpm run test`, in that order. It stands in for the pull-request workflows almost entirely: the lint here is the combined `eslint.config.mjs`, which carries both the rule packs CI splits into `lint:ts` (`lint.yml`) and `lint:n8n` (`n8n-check.yml`), and `scan:simulate` lints the `dist/` the build just produced the way `n8n-scan.yml` does. The one hole is `vitest.config.ts`, which the combined config names in its `ignores` and `eslint.config.ts.mjs` — the config `lint.yml` runs — does not, so a lint error confined to that single file passes here and reddens the `Lint` job on the pull request; run `pnpm run lint:ts` as well when you want certainty. Red blocks the release: fix the code, never loosen the target. It rewrites no tracked file — the build's output is `dist/`, which is gitignored — so nothing it touches joins the release commit.

   **`make check-dist` is deliberately not part of it**, and not part of the release either. The Makefile's comment explains why: the recommended typescript-eslint config flags the `require()` calls tsc always emits for CommonJS targets, which cannot be satisfied without rewriting how the package compiles. Source ESLint is the real gate. Run it only when investigating something specific to `dist/`.

2. **`make docs-check`** (`mkdocs build --strict`), **when the entry carries links, or when `docs/` or `mkdocs.yml` changed.** It is the only strict build this repo has, and nothing runs it for you at release time: `doc-check.yml` is keyed to the `docs/**` and `mkdocs.yml` paths, which a release commit touching only `package.json` and `CHANGELOG.md` does not match, and the deploy on `main` is `mkdocs gh-deploy`, which is not strict and would publish a dead link rather than fail on it. The changelog reaches the site all the same: `docs/changelog.md` is nothing but `--8<-- "CHANGELOG.md"` under `pymdownx.snippets` with `base_path: .`. The first run pulls in `make env`, which builds a Python `.venv` in the worktree and pip-installs MkDocs; that directory is gitignored and expected.

## The release commit

`package.json` and `CHANGELOG.md`, staged by name. No gate rewrites a tracked file here, so there is nothing else to carry.

## CI on the release pull request

- **`guard-branches.yml`** (`gate-main`, on `pull_request_target`) — the head branch into `main` matches `^release\/v[0-9]+\.[0-9]+\.[0-9]+$`. Its `gate-release` job does not apply to a release pull request, being keyed to a base of `dev` or `release/v*`.
- **`version-check.yml`** — on a pull request into `main` it asserts twice over: that `package.json`'s version is strictly greater than the one on `main`, and, because the head is itself a `release/vX.Y.Z` branch, that it equals the version in the branch name.
- **`changelog-check.yml`** — runs on a pull request into `main` whose head starts with `release/v`, and demands `CHANGELOG.md` carry a `## [vX.Y.Z] - ` heading for the version in the branch name. It asserts nothing about `[Unreleased]`; leaving none behind is the play's rule, not CI's.
- **`lint.yml`, `n8n-check.yml`, `build.yml`, `n8n-scan.yml` and `test.yml`** — plain `on: pull_request` with no branch filter, so each of them gates the release pull request too, running `pnpm run lint:ts`, `pnpm run lint:n8n`, `pnpm run build`, a build followed by `pnpm run scan:simulate`, and `pnpm run typecheck:test` followed by `pnpm run test`. `make check` in step 1 of the gates is what keeps them green.
- **`doc-check.yml`** — `mkdocs build --strict`, only when `docs/**` or `mkdocs.yml` changed, which a release commit normally does not.

`publish.yml` and `deploy-docs.yml` are not pull-request checks: both fire on the push to `main`, which is to say on the merge.

## Particulars

- **The changelog heading carries the `v`, and the entries use section subheads.** `## [vX.Y.Z] - YYYY-MM-DD` is exactly what `changelog-check.yml` greps for and what `publish.yml` slices the Release notes out of, and the entries are written with the `### Added` / `### Changed` / `### Fixed` sections `.claude/rules/changelog.md` prescribes rather than as bare bullet lists. No `[Unreleased]` heading is left behind; the next change re-creates one.
- **No pre-release form.** `gate-main`'s regex refuses a head like `release/v0.3.0-rc.1` into `main` outright, and `changelog-check.yml` — which runs on any `release/v` head into `main` — fails on a form its own `^release/v([0-9]+\.[0-9]+\.[0-9]+)$` does not match, rather than skipping it the way a repo without that branch check would. Ship a plain `X.Y.Z`.
- **The tags are lightweight**, created as a side effect of `gh release create` rather than by `git tag -a`. Always pass `--tags` when reading them: bare `git describe` here dies with "No annotated tags can describe".
- **The repo declares neither `.worktree.toml` nor `.worktreeinclude`**, so `wt` resolves the base from `origin/dev` and provisions with the Makefile's `install` target — `make install`, which brings pnpm to the version the Makefile pins and runs `pnpm install`. The only gitignored file it copies is `.env`, when the main checkout has one; `.env.n8n` is tracked, its ignore rule explicitly negated, so it comes with the branch. A gate that fails in `_n8n-nodes-pipelex--release` on a missing local file means those declarations are short: add them rather than hand-copying the file every release.
- **The release arms nothing.** `ledger.toml` declares no `release_followups` for this repo, and no other package in the workspace depends on the published node, so whatever this release owes downstream has to be filed by hand alongside the release item.
