---
name: feedback-sweep-past-the-diff-for-falsified-prose
description: When a PR changes a structure (job shape, file layout, API), sweep for prose describing that structure repo-wide by grepping the RETIRED term — not just inside the diff, since the diff is what falsified the out-of-diff comments
metadata:
  type: feedback
---

# Sweep past the diff for prose the diff falsified

`core-principles.md` §8 scopes "sweep the class" to the files the
change touches. For a **structural** change (a job shape, a file
move, a renamed export) that scope is too narrow in one specific
direction: prose in files the PR never touched can be false
*because* of the PR. The reliable finder is a repo-wide grep for the
**retired** term, not for the files in the diff.

**Why:** a review that names dead `GITHUB_OUTPUT` writes and a stale
workflow header scopes the fixer to the workflow files. Grepping
`-e "detect job" -e "detect step" -e GITHUB_OUTPUT` across the whole
repo instead also reaches TypeScript like `src/converge/files.ts`,
whose doc comments describe the workflows' job shape and go stale
without ever appearing in the diff. A diff-scoped sweep ships those,
and the next reviewer spends a round trip on them.

**How to apply:** name the term the change retires (`detect job`,
`matrix`, the old symbol name) and grep it across the repo with
`--exclude-dir=node_modules --exclude-dir=dist`, then triage each
hit: historical narration ("this workflow USED TO be…") is fine and
should stay; a present-tense claim is a defect. Fixing an out-of-diff
one-line comment is in scope; a refactor is not. Related:
[[feedback-acceptance-criteria-are-not-load-bearing]].
