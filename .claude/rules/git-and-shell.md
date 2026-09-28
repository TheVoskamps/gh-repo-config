# Git and shell in this repo

## Keep every Bash call statically simple

The harness classifies a Bash call statically and refuses, before any
part of it runs, one it cannot prove stays inside the worktree. That
covers `git -C <path>`, a call chaining several `cd`/`git` steps, and,
whatever the binary, a heredoc, a `for`/`while` loop, or
`sed -i '' -e …` (the empty BSD suffix parses as a path outside the
repo). A plain `cmd > <abs path inside the worktree>`, a `|` pipeline,
and an `&&` chain of non-git commands pass.

Edit repo files with `Edit` or `Write`. Put a multi-step git sequence or
a mechanical edit pass in a `.sh`/`.py` under `.claude/tmp/<task slug>/`
and run it as the single command `bash <abs path>` or
`python3 <abs path>`, and pass a commit message with
`git commit -F <file>`. A refused call ran none of its parts, so
re-stage anything a refused `git add` was chained to. The refusal for
`git -C` suggests a bare `cd` in a prior call, which does not help a
subagent, whose cwd resets between calls.

Run the test suite after a mechanical retokenization; it misses value
assertions whose key was renamed separately.

## Restore a file with `/bin/cp -f`

`cp` is wrapped interactively here and `cp -f` does not defeat the
wrapper: overwriting prints `overwrite <path>? (y/n [n]) not
overwritten` and stops the `&&` chain, since the Bash tool supplies no
stdin. On the restore leg of a mutation check that leaves the corrupted
file in the worktree, one commit away from shipping. Restore with
`/bin/cp -f <bak> <dst>` and confirm with `git status --porcelain`.

## A sibling worktree holding your branch is left in place

`git checkout <branch>` failing with `already used by worktree at
.claude/worktrees/agent-<other>` means an earlier agent died before its
cleanup. Neither escalate nor delete that worktree. Confirm with
`git worktree list` and `git rev-parse origin/<branch>` that its HEAD is
already pushed, then `git checkout --detach <tip>` and push with
`git push origin HEAD:refs/heads/<branch>`, which never claims the
branch and leaves your end-of-run cleanup nothing to release.

## An SSH push timeout is retried, not escalated

`ssh: connect to host github.com port 22: Operation timed out` is a
connection that never opened, not an authentication failure, despite the
trailing "make sure you have the correct access rights". Re-run the
identical push a couple of times without touching the remote, the URL,
or the credential agent, and escalate only when every retry times out.

## A `Read` of the primary clone can show `main`'s text

An `Edit` against the primary clone's path under `Workspaces/` is
refused, but a `Read` against it can succeed and return `main`'s copy
of the file, which looks like the branch lacking its own change. When a
`Read` disagrees with a `grep` of the same file, believe the `grep` and
re-read through the path `git rev-parse --show-toplevel` gives.
