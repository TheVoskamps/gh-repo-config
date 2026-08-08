# Memory Index

- [Acceptance criteria are not load-bearing](feedback-acceptance-criteria-are-not-load-bearing.md) — when a finding shows an AC encodes a wrong design, fix the design and update the issue; never add a second mechanism to keep the AC literally true
- [Worktree Bash refuses redirection and loops](project-worktree-bash-refuses-redirection.md) — heredocs, `>` and `for` loops are refused even with no git in the command; use Write plus `bash <abs-path>`
- [shellcheck runs in CI only](project-shellcheck-is-ci-only.md) — not on the host and not a project dep; substitute `bash -n` plus the self-tests, don't install and don't escalate
- [Sweep past the diff for falsified prose](feedback-sweep-past-the-diff-for-falsified-prose.md) — after a structural change, grep the RETIRED term repo-wide; untouched files can hold prose the diff made false, but a `docs/` design record is never a hit to fix
- [Prove a replacement assertion bites](feedback-prove-a-replacement-assertion-bites.md) — a green suite says nothing about a fixed test's discriminating power; feed it the pre-change input and watch it fail
- [js-yaml is an undeclared transitive dep](project-js-yaml-is-an-undeclared-transitive-dep.md) — resolves via markdownlint-cli2 only; fine for scratch, never import from test/ or src/
- [`cp` refuses to overwrite](project-cp-refuses-to-overwrite.md) — bare `cp` prompts and stalls the `&&` chain; restore a mutation check's backup with `/bin/cp -f`
- [Fixtures never equal the real value](feedback-fixtures-never-equal-real-values.md) — a fixture that coincides with the value it stands in for is a defect to fix now, not to flag; pick one the real value can never reach
- [A cited guarantee has to be read](feedback-a-cited-guarantee-must-be-read.md) — "safe because test Y pins Z" is a claim about Y's assertion, not its name; open it and run the breaking value through it
- [Stale worktree holds the branch claim](project-stale-worktree-holds-branch-claim.md) — checkout fails on a leftover sibling worktree; work detached at the remote tip and push `HEAD:refs/heads/<branch>`
