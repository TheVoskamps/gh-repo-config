---
name: feedback-self-review-blocks-request-changes
description: gh blocks --request-changes on your own PR too, not just --approve — but the reviewer and the PR author are usually different identities here, so compare logins before downgrading to --comment.
metadata:
  type: feedback
---

# Self-review blocks request-changes

`gh pr review --request-changes` fails on a self-authored PR with:

```text
failed to create review: GraphQL: Review Can not request changes on
your own pull request (addPullRequestReview)
```

**Why:** the `github-prs:pr-review-submit` skill documents the
self-review constraint **only** for `--approve` ("Self-review
constraint (author cannot `--approve`)"). That is incomplete —
GitHub blocks any non-`COMMENT` review state on your own PR, so
`--request-changes` hits it as well.

**But the two identities usually differ here, so check before
downgrading.** Under the per-user Claude GitHub App identity this repo
uses, the reviewing account (`gh api user -q .login`, e.g.
`claude-for-evoskamp`) is not the account that authored the PR (e.g.
`evoskamp`), so a plain `gh pr review --approve` or
`--request-changes` succeeds and carries a real review state. Compare
`gh api user -q .login` against the PR's `author.login` and downgrade
only on an actual match — pre-emptively downgrading throws away a real
review state (and the "approved" signal a human or a merge queue
reads) for no reason.

**How to apply:** when the verdict is `request-changes` and the
current `gh` user *is* the PR's author, apply the same downgrade the
skill prescribes for `approve` — a single `gh pr review <PR> --comment`
whose body is prefixed with an explicit verdict line
(`CHANGES REQUESTED`), so the review still carries the verdict. Still
exactly one call, one notification. Don't retry `--request-changes`
and don't split into two calls.
