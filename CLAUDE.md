# gh-repo-config

Org-wide repo-configuration converger: TypeScript, Node >=22, ESM. A
scheduled sweep renders the payloads under `assets/` onto every managed
repo in an org through one converger PR per repo, converges each repo's
settings and `protect-main` ruleset through the API, and stamps the repo
with this package's `version`.

## Commands

```bash
npm ci                      # install from the lockfile
npm run build               # TypeScript -> dist/
npm run build && npm test   # tests import dist/, so build first
npm run lint:md
mise exec -- shellcheck assets/*.sh scripts/*.sh
mise exec -- actionlint -shellcheck= .github/workflows/*.yml
```

`npm run lint:md` takes no arguments: `.markdownlint-cli2.jsonc` owns
the linted set, so a caller passing its own globs lints a different set
than CI does. That set includes `.claude/agent-memory/**/*.md`, so an
agent-memory entry file needs a `# H1` as its first line after the
front matter.

`actionlint`'s `-shellcheck=` matches CI, which turns off actionlint's
own shellcheck pass over `run:` blocks. A bare `actionlint` picks up
`shellcheck` from `PATH` and fails on `SC2016` findings CI never
reports.

`shellcheck` and `actionlint` come from `mise.toml` here and from the
runner image on CI. When one cannot run locally, report the PR's
`gh pr checks <N>` state for it, never the local absence.

## Index

- `docs/rules/workflows-and-payloads.md` — read before editing a file
  under `assets/` or `.github/workflows/`. Kernel: the file under
  `assets/` is the payload, and this repo's own rendered copy of it
  under `.github/` is sweep output that is never hand-edited.
- `docs/rules/converger-source.md` — read before editing a file under
  `src/`, `bin/`, or `test/`. Kernel: a sweeper-repo converger PR is
  held for a human by two locks, its draft state and the merge pass's
  `humanApprovalPaths`, and both stay.
- `docs/repo-selection.md` — read before changing which repos the sweep
  treats as managed, or when provisioning the org custom properties.
- `docs/codeartifact-auth.md` — read before changing the
  `codeartifact-auth` payload, or when provisioning CodeArtifact access
  for a managed repo.
- `docs/github-app-converger.md` — read before changing the converger
  App's permissions or the secrets its token mint reads.
