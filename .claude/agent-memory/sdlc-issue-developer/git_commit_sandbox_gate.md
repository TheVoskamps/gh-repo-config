---
name: git-commit-sandbox-gate
description: git commit with a heredoc (`$(cat <<'EOF' ... EOF)`) can be blocked by the CVE-2025-59536 static-classification gate even for a plain commit
metadata:
  type: project
---

# Git commit sandbox gate

A `git commit -m "$(cat <<'EOF' ... EOF)"` command can be rejected by
the harness's dynamic-argument gate with: "a 'git' command whose
arguments are not all static literals ... cannot be statically
classified." This happened on a completely ordinary commit (no rebase,
no force, nothing destructive) in gh-repo-config.

**Why:** the gate can't tell a heredoc-substituted commit message from
one that might reach a dangerous operation through the dynamic token,
so it blocks conservatively regardless of the actual command's intent.

**How to apply:** when `git commit` with an inline heredoc/command
substitution is blocked, write the message to a plain file (e.g. under
`.claude/tmp/<task-slug>/`) with the `Write` tool and commit with
`git commit -F <file>` instead. This uses only static literal
arguments and passes the gate. Remember to re-stage files if the
blocked command also silently skipped `git add` (the gate blocks
before execution, so any preceding `git add` in the same blocked
invocation never ran either).
