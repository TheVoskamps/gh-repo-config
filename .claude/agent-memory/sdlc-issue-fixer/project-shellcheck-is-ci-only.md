---
name: project-shellcheck-is-ci-only
description: shellcheck is not installed on Edwin's host and is not a project dependency, so the ci.yml shellcheck step cannot be reproduced locally; use bash -n plus the payload self-tests instead of installing it
metadata:
  type: project
---

# `shellcheck` runs in CI only, never locally

`.github/workflows/ci.yml` runs `shellcheck assets/*.sh scripts/*.sh` as a
dedicated step, but `shellcheck` is **not** on Edwin's host (`command not
found`, observed 2026-08-06) and is not in `package.json` or
`node_modules/.bin`. There is no `npx` fallback.

**Why:** it is a system binary the GitHub runner image ships, not a
declared project dependency. Installing it locally would be a
`brew install` — forbidden by the host-integrity axis in
`rules/install-discipline.md` — and escalating a missing lint tool stalls
a run for a check CI performs anyway.

**How to apply:** when a change touches `assets/*.sh` or `scripts/*.sh`,
do not install shellcheck and do not escalate its absence as a blocker.
Substitute what IS available locally: `bash -n <script>` for syntax, the
matching `assets/test-*.sh` / `scripts/test-*.sh` self-test for behaviour,
and `scripts/check-pin-shape.sh` when any `assets/*.yml` changed. Then say
plainly in the report that shellcheck was not run and why, rather than
implying the CI lint set passed. Verify the binary is still missing before
relying on this — Edwin may install it later. Sibling constraint on how to
shape those Bash calls: [[project-worktree-bash-refuses-redirection]].
