---
name: project-cp-refuses-to-overwrite
description: In this environment bare `cp` is interactive and refuses to overwrite an existing file, which breaks the restore half of a mutation check; `/bin/cp -f` bypasses it, and `node -e "fs.writeFileSync(...)"` also works
metadata:
  type: project
---

# Bare `cp` refuses to overwrite; `/bin/cp -f` does not

The shell the harness starts has `cp` behaving interactively. Restoring
a file from a backup during a mutation check produced only:

```text
overwrite package.json? (y/n [n]) not overwritten
```

The prompt is never answerable — the Bash tool supplies no stdin — so
the copy simply does not happen and the `&&` chain after it stops. An
earlier run recorded `cp -f` failing the same way, which points at a
shell-level wrapper rather than a plain `alias cp='cp -i'`. Calling the
binary directly, `/bin/cp -f <bak> <dst>`, overwrote cleanly on PR #79
and is the shortest way out.

**Why:** the mutation check that
[[feedback-prove-a-replacement-assertion-bites]] requires is
backup → mutate → build → run → restore, and the restore leg is where
this bites. A half-done restore leaves a deliberately corrupted
`package.json` (or asset) in the worktree, which is easy to commit by
accident.

**How to apply:** take the backup with `cp` if you like (creating a new
file is fine), and restore with `/bin/cp -f <bak> <dst>` or, if that
ever prompts too, a command that writes rather than copies —
`node -e "const fs=require('fs');fs.writeFileSync('<dst>',fs.readFileSync('<bak>','utf8'));"`
— then confirm with `git status --porcelain` before moving on. Sibling
environment note: [[project-worktree-bash-refuses-redirection]].
