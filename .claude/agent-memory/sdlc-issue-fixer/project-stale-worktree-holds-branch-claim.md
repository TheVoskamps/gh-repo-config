---
name: stale-worktree-holds-branch-claim
description: A leftover sibling worktree can hold the PR branch claim; work detached at the remote tip and push HEAD to the branch ref instead of escalating
metadata:
  type: project
---

# Stale worktree holds the branch claim

`git checkout <branch>` in a fresh fixer worktree can fail with
`already used by worktree at .claude/worktrees/agent-<other>` — a
previous subagent's worktree that the orchestrator has not cleaned up
yet.

**Why:** the fixer's own cleanup step (`git checkout --detach` +
`git branch -D`) is skipped whenever an agent dies or is interrupted,
so the claim outlives the run that made it.

**How to apply:** do not escalate and do not delete another agent's
worktree. Confirm nothing is at risk first — `git worktree list` for
its HEAD and `git rev-parse origin/<branch>` — and if the remote tip
equals that HEAD there is no unpushed work. Then
`git checkout --detach <tip>`, do the work, commit, and push with an
explicit refspec: `git push origin HEAD:refs/heads/<branch>`. That
never claims the branch, so the end-of-run cleanup has nothing to
release either.

Note the harness refuses `cd <path> && git ...` and refuses
`git --git-dir=<primary>/.git ...` from an isolated worktree, so
inspect other worktrees with a bare `git worktree list` from your own.
