---
name: project-cp-refuses-to-overwrite
description: In this environment `cp` is interactive and refuses to overwrite an existing file even with `-f`, which breaks the restore half of a mutation check; restore with `node -e "fs.writeFileSync(...)"` or the Write tool instead
metadata:
  type: project
---

# `cp` refuses to overwrite, `-f` included

The shell the harness starts has `cp` behaving interactively. Restoring
a file from a backup during a mutation check produced only:

```text
overwrite package.json? (y/n [n]) not overwritten
```

`cp -f` produced the same refusal. The prompt is never answerable — the
Bash tool supplies no stdin — so the copy simply does not happen and the
`&&` chain after it stops.

**Why:** the mutation check that
[[feedback-prove-a-replacement-assertion-bites]] requires is
backup → mutate → build → run → restore, and the restore leg is where
this bites. A half-done restore leaves a deliberately corrupted
`package.json` (or asset) in the worktree, which is easy to commit by
accident.

**How to apply:** take the backup with `cp` if you like (creating a new
file is fine), but restore with a single static command that writes
rather than copies —
`node -e "const fs=require('fs');fs.writeFileSync('<dst>',fs.readFileSync('<bak>','utf8'));"`
— then confirm with `git diff <path>` before moving on. Sibling
environment note: [[project-worktree-bash-refuses-redirection]].
