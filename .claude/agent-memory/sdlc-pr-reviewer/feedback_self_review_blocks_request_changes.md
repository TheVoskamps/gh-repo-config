---
name: feedback-self-review-blocks-request-changes
description: gh blocks --request-changes on your own PR too, not just --approve — the pr-review-submit skill only documents the approve case, so downgrade to --comment with an explicit verdict line.
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
`--request-changes` hits it as well. In the `/sdlc:orchestrate` flow
the reviewer and the PR author are routinely the same identity
(`evoskamp`), so this fires on essentially every request-changes
verdict, not as a rare edge case.

**How to apply:** when the verdict is `request-changes` and the
current `gh` user authored the PR, apply the same downgrade the skill
prescribes for `approve` — a single `gh pr review <PR> --comment`
whose body is prefixed with an explicit verdict line
(`CHANGES REQUESTED`), so the review still carries the verdict. Still
exactly one call, one notification. Don't retry `--request-changes`
and don't split into two calls.

**But check the identities first, don't assume they collide.** Since
this repo adopted the per-user Claude GitHub App identity, the two are
often *different*: `gh api user -q .login` returned
`claude-for-evoskamp` while PR #79's author was `evoskamp`, so a plain
`gh pr review --approve` succeeded and the review shows
`state=APPROVED`. Compare `gh api user -q .login` against the PR's
`author.login` and downgrade only on an actual match — pre-emptively
downgrading throws away a real review state (and the "approved" signal
a human or a merge queue reads) for no reason.
