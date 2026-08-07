---
name: feedback-verify-which-pass-acts-on-which-pr
description: When prose claims a workflow pass acts on a given PR, check that pass's candidate filter, not just that it pushes
metadata:
  type: feedback
---

# Verify which pass acts on which PR

When prose asserts that some workflow pass "also pushes to" / "also
rebases" a particular branch or PR, confirm it against that pass's
**candidate selection**, not merely against the presence of a `git
push` in its body. Two passes in the same job can share an identity and
a push while selecting disjoint PR sets.

**Why:** on PR 79 a fixer round rewrote the `assets-pin-bump.yml`
bot-authorship comment (and its CLAUDE.md mirror) to claim the
Dependabot REST-merge pass, moved into `auto-rebase-prs.yml`, also
rewrites the committer on the bumper's own PR. It does push and it does
rebase — but its `jq` filter requires `author.login == "dependabot"`,
so it can never reach a PR the pin bumper opened. The described
*behavior* of the guard was correct and nothing failed; only the stated
reason was false, which no test catches.

**How to apply:** any "pass P also does X to Y" sentence in a diff is
settled by reading P's filter/`select(...)` chain and Y's author. Do
this before letting such a sentence survive a doc pass, especially when
the sentence was authored in the same commit as the code it describes.
Related: [[feedback-sweep-past-the-diff-for-falsified-prose]].
