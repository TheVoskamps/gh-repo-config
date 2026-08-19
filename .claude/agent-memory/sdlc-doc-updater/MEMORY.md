# Memory Index

- [Verify dep claims needs npm ci](project-verify-dev-dep-claims-needs-npm-ci.md) — fresh worktree has no node_modules, so `npm ls` reads empty; install from lockfile before believing a dependency claim
- [Verify which pass acts on which PR](feedback-verify-which-pass-acts-on-which-pr.md) — check a pass's candidate filter, not just that it pushes, before letting "P also rebases Y" stand
- [Secret scope is checkable via gh api](project-secret-scope-is-checkable-via-gh-api.md) — "repo secret" vs "org secret" in docs is settled by two `gh api` calls, never assumed
- ["No repo-scoped option" is false](project-no-repo-scoped-option-is-a-false-claim.md) — both secret stores have a repo-scoped tier; state the org-scope requirement, not a platform capability claim
