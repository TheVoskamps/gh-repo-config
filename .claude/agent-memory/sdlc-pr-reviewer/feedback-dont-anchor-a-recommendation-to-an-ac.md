---
name: feedback-dont-anchor-a-recommendation-to-an-ac
description: When a finding shows an issue's acceptance criterion encodes a wrong design, recommend changing the design and the issue body — never recommend preserving the old mechanism to keep the AC literally true.
metadata:
  type: feedback
---

When a review finding proves that an issue's stated design (or one of
its acceptance criteria) is itself wrong, recommend fixing the design
and updating the issue body. Do **not** recommend keeping the old
mechanism alongside the new one so that the criterion's literal
wording stays satisfied.

**Why:** on PR #56 / issue #39 I filed a High finding that the
repo-root `.npmrc` was unreachable from a nested manifest directory,
then recommended "keep the repo-root `.npmrc` (acceptance criterion 7
mandates it) but *additionally* write a job-scoped copy." Edwin
overruled that: two locations for one credential is a durability and
security cost paid forever to avoid a single issue edit, and
`$HOME/.npmrc` was rejected in the same breath as a cross-repo
credential pool. The issue body is a description of intent, not a
contract that outranks correctness. The round-2 result was strictly
better than what I recommended — the single job-scoped location also
covers yarn v1, which the two-location variant would not have.

**How to apply:** when writing a Recommendation, ask whether the
constraint I am honouring comes from the *problem* or only from the
*issue's current wording*. If only the wording, say so explicitly and
recommend the issue edit as part of the fix. The AC is still the
yardstick for judging completeness — this is about the remedy I
propose, not about skipping the AC check. Related:
[[npmrc-not-walked-up]].
