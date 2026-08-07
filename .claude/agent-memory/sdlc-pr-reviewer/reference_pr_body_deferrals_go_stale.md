---
name: reference-pr-body-deferrals-go-stale
description: A PR body's "this acceptance criterion is carried forward by issue #N" is a claim with a shelf life — re-read #N's state AND stateReason every round, because a criterion an earlier round accepted as deferred becomes unmet the moment the owner closes #N as NOT_PLANNED.
metadata:
  type: reference
---

# A deferral to a follow-up issue expires; re-check it every round

When a PR body says an acceptance criterion is not satisfied here but is
carried forward by issue #N, that is a load-bearing developer claim, and
it is the one kind that can go false **without anyone touching the
branch**. An earlier review round can accept it correctly and a later
round still has to re-check it, because the thing that falsifies it
happens on the issue tracker, not in the diff.

The check is one call, and `state` alone is not enough:

```bash
gh issue view <N> --json number,title,state,stateReason,closedAt,comments
```

`stateReason: NOT_PLANNED` is the tell. A `COMPLETED` close means the
follow-up happened; `NOT_PLANNED` means the owner decided it will not,
and the closure **comment** is where the real scope decision is written
down — richer than anything the issue body or the PR body says.

Observed on PR #79 (issue #77, the job-count collapse). Five review
rounds accepted "carried forward by issue #80" while #80 was open. The
owner then closed #80 `NOT_PLANNED` with "This has no place in this
repo. This belongs in Fablegate which this repo should not have access
to." — hours before the next round. The deferral had silently become an
unmet acceptance criterion with a false mitigation in a body that, in a
merge-commit-only repo, becomes permanent history.

Grade the result on the criterion, not on the prose: a body claim that a
criterion is handled by other means, where the other means no longer
exists, IS the unmet criterion and is High. The remedy is usually a body
edit, which does not lower the severity.

**How to apply:** in step 2 of the review, after
`/github-prs:pr-closing-issues`, resolve every issue the body names in a
deferral or a `References:` trailer and read its live state — not just
the members of the resolved set. Do it on every round, including rounds
that only review a small follow-up change, and treat a prior round's
approval of the deferral as carrying no weight. See
[[reference-verify-a-test-actually-bites]] for the same
don't-take-the-report-on-faith habit applied to assertions.
