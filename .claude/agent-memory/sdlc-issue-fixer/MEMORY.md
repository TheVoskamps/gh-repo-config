# Memory Index

- [Acceptance criteria are not load-bearing](feedback-acceptance-criteria-are-not-load-bearing.md) — when a finding shows an AC encodes a wrong design, fix the design and update the issue; never add a second mechanism to keep the AC literally true
- [Worktree Bash refuses redirection and loops](project-worktree-bash-refuses-redirection.md) — heredocs, `>` and `for` loops are refused even with no git in the command; use Write plus `bash <abs-path>`
- [shellcheck runs in CI only](project-shellcheck-is-ci-only.md) — not on the host and not a project dep; substitute `bash -n` plus the self-tests, don't install and don't escalate
