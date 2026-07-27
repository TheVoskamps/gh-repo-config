---
name: feedback-acceptance-criteria-are-not-load-bearing
description: When a review finding shows an issue's acceptance criterion encodes a wrong design, fix the design and update the issue body — never add a second mechanism to keep the AC's literal wording true
metadata:
  type: feedback
---

# Acceptance criteria are not load-bearing

When a PR review finding reveals that an issue's stated design (or one
of its acceptance criteria) is itself wrong, change the design and
**update the issue body to match**. Do not preserve the old mechanism
alongside the new one so that the criterion's literal wording stays
true.

**Why:** on issue #39 (PR #56) the reviewer's recommended fix was
"keep the repo-root `.npmrc` — acceptance criterion 7 mandates it — but
*additionally* write a job-scoped copy." Edwin rejected that
explicitly as "a two-location kludge that existed only to keep an
acceptance criterion's literal wording true," and directed a single
location with a single mechanism, plus an issue-body update. The
issue body is a description of intent, not a contract that outranks
correctness; two mechanisms for one credential is a durability and
security cost paid forever to avoid one issue edit.

**How to apply:** when a finding's fix contradicts the issue's Design
section or an AC, say so in the report, implement the single correct
mechanism, and update the issue via `/issue-update` in the same run.
Reconcile against **every** AC (count them on the live issue — the
spawn brief's count has been wrong before), not just the ones the
finding names. Related: [[feedback-fix-findings-now-no-later-slice]].
