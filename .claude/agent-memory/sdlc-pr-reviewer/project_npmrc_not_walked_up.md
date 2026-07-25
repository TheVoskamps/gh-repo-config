---
name: npmrc-not-walked-up
description: Verified — neither npm nor pnpm reads a repo-root .npmrc from a nested package dir; relevant to any converger payload that writes .npmrc while dependency-install-gate cds into each manifest's dirname.
metadata:
  type: project
---

Neither npm nor pnpm walks up to the git root for a project `.npmrc`.
Both resolve it relative to the nearest package directory, so a
repo-root `.npmrc` is invisible to an install run from
`services/api/`. Verified empirically during the #39 review with
npm 11.6.2 and pnpm 10.33.4: from a nested `package.json` dir with no
`.npmrc` of its own, `config get registry` returned
`https://registry.npmjs.org/`, ignoring the root file entirely.

**Why:** this repo's `assets/dependency-install-gate.sh` discovers
lockfiles at any depth (`git ls-files '*package-lock.json'`) and runs
each install with `cd "$(dirname "$manifest")"`. Any converger payload
that authenticates a registry by writing a repo-root `.npmrc`
therefore silently fails on multi-manifest repos — the install falls
back to the public registry and the required gate goes red with no
clue why. Yarn is immune because it is configured through
`$GITHUB_ENV`, which is cwd-independent.

**How to apply:** when reviewing any asset that writes `.npmrc`, check
whether the consumer's cwd is the repo root. The cwd-independent fix
is `NPM_CONFIG_USERCONFIG` pointed at a `$RUNNER_TEMP/.npmrc` (what
`actions/setup-node` itself does), which works alongside the repo-root
file rather than replacing it.
