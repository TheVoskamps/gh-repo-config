# gh-repo-config

Org-wide repo-configuration converger: TypeScript, Node >=22, ESM. A
scheduled sweep renders the payloads under `assets/` onto every managed
repo in an org through one converger PR per repo, converges each repo's
settings and `protect-main` ruleset through the API, and stamps the repo
with this package's `version`.

## Commands

```bash
pnpm install --frozen-lockfile  # install from the lockfile
pnpm run build                  # TypeScript -> dist/
pnpm run build && pnpm test     # tests import dist/, so build first
pnpm lint                       # every linter, as CI runs them
pnpm format                     # rewrite the tree's formatting
```

`pnpm lint`'s Markdown set includes `.claude/agent-memory/**/*.md`, so
an agent-memory entry file needs a `# H1` as its first line after the
front matter.

The Bash tool runs zsh, which aborts the whole call before any part of
it runs on an unquoted glob or leading `=` in a word: `--include=*.md`
fails with `no matches found` and `echo =====` with `==== not found`.
Quote both (`--include='*.md'`, `echo '====='`), and read either
message as a failed call, never as a grep that found nothing.

A sweep, dry run included, throws before reading any repo when the
PR-automation App is not installed on the org or lacks a permission its
fanned-out workflows need. That preflight is
`assertPrAutomationPermissions` in `src/converge/app-permissions.ts`.

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
