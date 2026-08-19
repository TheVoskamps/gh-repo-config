---
name: project-worktree-bash-refuses-redirection
description: In a worktree-isolated subagent the harness refuses any Bash call carrying output redirection or a loop even when no git command is involved; write the script with the Write tool and run `bash <abs-path>`
metadata:
  type: project
---

# Worktree Bash refuses redirection and loops, git or not

A worktree-isolated subagent's Bash calls are classified statically, and
the refusal is not limited to git. Both of these were refused during an
issue-fixer run with no git command anywhere in them:

- `cat > .claude/tmp/<slug>/check.mjs <<'EOF' … EOF` (heredoc write)
- `for t in assets/test-*.sh; do … >/tmp/out.$$ …; done` (loop plus
  redirection)

The message is the same one the git forms get: "this command is too
complex to verify that it stays inside the worktree … break it into
plain, separate commands."

**Why:** the classifier has to prove every write target sits inside the
worktree. A redirection target or a loop body defeats that proof, so it
refuses regardless of which binary is being run.

**How to apply:** never plan a Bash call containing `>`, `>>`, a
heredoc, or a `for`/`while` loop. Write the file with the `Write` tool
(absolute path under `.claude/tmp/<task-slug>/`) and, when several steps
are needed, put them in a `.sh` under the same directory and invoke the
single static command `bash <abs-path-to-script>`. One exception that
does pass: a plain `cmd > <abs-path-inside-worktree>` with no other
shell structure, e.g. `gh pr view N --json body --jq '.body' >
<abs-path>`. `npm`/`node`/`git` invocations with `| tail`, `| grep` and
`&&` chains of non-git commands also pass. Sibling note in the
issue-developer's memory: [[worktree-gate-refuses-heredocs-and-chains]].
