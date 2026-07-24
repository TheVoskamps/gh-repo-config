---
name: feedback-self-review-blocks-request-changes
description: gh blocks --request-changes on your own PR too, not just --approve — the pr-review-submit skill only documents the approve case, so downgrade to --comment with an explicit verdict line.
metadata:
  type: feedback
---

`gh pr review --request-changes` fails on a self-authored PR with:

```
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
and don't split into two calls. See
[[project-verify-assets-against-upstream]] for the other
reviewer-context gotcha in this repo.
