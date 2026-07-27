---
name: project-ruleset-split
description: gh-repo-config tracks two repo-level GitHub rulesets with different ownership models — protect-main (converger-managed) vs repo-required-checks (operator-managed, exported to .github/rulesets/)
metadata:
  type: project
---

`gh-repo-config`'s own repo carries two active repo-level rulesets on
`main`, deliberately split by ownership:

- `protect-main` — converged every sweep run by `src/converge/ruleset.ts`
  against the canonical `assets/protect-main-ruleset.json`, using an
  exact-set compare on required-check contexts. Any hand-added context
  here is reverted as drift.
- `repo-required-checks` — operator-managed (created/maintained by a
  human via the rules API or web UI, never touched by the converger).
  Carries just one rule: `required_status_checks` requiring
  `ci-required` (the aggregator job in this repo's own `.github/workflows/ci.yml`,
  itself a repo-own workflow outside the sweep's rendered payload).
  Exported as checked-in source-of-record at
  `.github/rulesets/repo-required-checks.json` +
  `.github/rulesets/README.md` (PR #66, follow-up to issue #58/PR #65).

**Why:** GitHub aggregates all active rulesets on a branch, so a check
required by `repo-required-checks` is required even though
`protect-main` doesn't list it — this is how `ci-required` became a
required check without touching the converger-owned canonical asset
(which would just get reverted on the next sweep).

**How to apply:** if a future issue asks to add a required check to
this repo's own branch protection, check whether it belongs in the
converger-managed `assets/protect-main-ruleset.json` (if it should
apply to every managed repo org-wide) or as a new operator-managed
ruleset entry under `.github/rulesets/` (if it's specific to this
repo's own CI, like `ci-required`). Never hand-edit `protect-main`'s
live ruleset directly — it will be reverted.
