---
name: npmrc-not-walked-up
description: Verified — npm, pnpm and yarn v1 all ignore a repo-root .npmrc from a nested package dir but all honour NPM_CONFIG_USERCONFIG; relevant to any converger payload that authenticates a registry while dependency-install-gate cds into each manifest's dirname.
metadata:
  type: project
---

# .npmrc is not walked up

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
clue why. Yarn **Berry** is immune because it is configured through
`$GITHUB_ENV`, which is cwd-independent; yarn **classic** (v1) is not
— the gate gates it too, and `YARN_NPM_*` is Berry-only.

**How to apply:** when reviewing any asset that authenticates a
registry, check whether the consumer's cwd is the repo root. The
cwd-independent mechanism is `NPM_CONFIG_USERCONFIG` pointed at
`$RUNNER_TEMP/.npmrc`. Re-verified in the #39 round-2 review: with it
set, npm 11.6.2, pnpm 11.15.0 **and yarn 1.22.22** all resolve both
the registry and its `_authToken` from a nested manifest dir — yarn v1
reads the file even though it ignored the repo-root one. It **replaces**
the repo-root write; it does not supplement it. Edwin settled #39 on
one credential in one location, and `$HOME/.npmrc` is rejected outright
as a cross-repo credential pool. Note `actions/setup-node`'s
`registry-url` writes that same path and exports the same variable
(`src/authutil.ts`), so a payload sharing it must rewrite only its own
lines, never truncate. Related: [[feedback-dont-anchor-a-recommendation-to-an-ac]].
