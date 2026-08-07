---
name: feedback-prove-a-replacement-assertion-bites
description: When a finding says a test assertion does not actually test what it claims, the fix is not done until you have fed the pre-change input to the new assertion and watched it fail — and cross-checked any hand-rolled parser against a real one
metadata:
  type: feedback
---

# Prove a replacement assertion actually bites

A finding of the form "this assertion passes by coincidence / would pass
on the very regression it exists to catch" is not discharged by writing a
better-looking assertion and seeing the suite stay green. Green proves
only that the assertion accepts the CURRENT input. Two extra steps are
what actually close it:

1. **Mutation check.** Feed the assertion the input it is supposed to
   reject — usually `git show origin/main:<path>`, i.e. the shape the PR
   removed — and watch it fail. If it passes, the replacement is vacuous
   too. Do this in a scratch `.mjs` under `.claude/tmp/<slug>/`, not by
   editing the payload.
2. **Cross-check any hand-rolled parser against a real one.** A
   replacement that counts job ids by slicing the `jobs:` block is prone
   to exactly the same class of bug it replaces: `assets/codeql.yml`'s
   jobs block opens with a two-space-indented COMMENT that ends in a
   colon, so a loose pattern reports the comment as a job. Only diffing
   the draft against a real YAML parse across every rendered workflow
   surfaces that. A passing suite never will.

**Why:** the reviewer's complaint is about the assertion's DISCRIMINATING
power, and a passing test carries no information about that. Shipping a
second unsound assertion costs another review round on a PR that is
already near its round cap.

**How to apply:** when the finding is "this test does not test what it
says", budget a scratch harness before touching the test. Print, per
case, both what the assertion accepts and what it rejects, and keep the
pre-change input in the harness. Then prefer asserting the exact expected
VALUE (a job-id list) over a count — a leaked entry changes the list and
names itself in the failure message, where a count only says `2 !== 1`.
Related: [[feedback-sweep-past-the-diff-for-falsified-prose]] for the
prose half of the same PR.
