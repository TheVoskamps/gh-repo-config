---
name: https-fetch-when-ssh-blocked
description: When git-over-SSH to github.com times out, fetch/push via a literal https://github.com/<nwo> URL (gh's credential helper authenticates it); the Bash gate requires the URL spelled literally, not via $VAR
metadata:
  type: reference
---

# HTTPS fetch when SSH is blocked

`git fetch origin` can fail with `ssh: connect to host github.com port
22: Operation timed out` while `gh` (HTTPS) works fine in the same
session. Do not treat this as a credential-surface stop — it is a
network-path mismatch with a one-command fallback.

**How to apply:** fetch the PR head and main over HTTPS with the URL
spelled as a literal (the harness Bash gate blocks
`git fetch "https://github.com/$NWO"` because the token is dynamic):

```bash
git fetch https://github.com/TheVoskamps/gh-repo-config \
  refs/pull/<N>/head:pr-<N>-review main:main-https
```

`gh auth`'s credential helper authenticates the HTTPS remote, so push
works the same way when a memory-capture commit needs to land:
`git push https://github.com/TheVoskamps/gh-repo-config HEAD:refs/heads/<branch>`.

Side benefit: fetching to a local name like `pr-<N>-review` (not the
convention branch name) never claims the feature branch, so end-of-run
cleanup is just deleting the local refs — same idea as
[[stale-worktree-holds-branch-claim]] in the fixer's memory.
