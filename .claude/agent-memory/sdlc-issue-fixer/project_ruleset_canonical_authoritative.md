---
name: project-ruleset-canonical-authoritative
description: gh-repo-config's protect-main ruleset compare (src/converge/ruleset.ts) is canonical-authoritative for rule parameters — per-repo variance is drift, not operator intent, except bypass actors.
metadata:
  type: project
---

Issue #16 / PR #40 follow-up (2026-07-19): the human (Edwin) made an
explicit design decision when a PR reviewer flagged that
`rulesetSemanticDiff` compared rule *types* and required-check
*contexts* but never rule *parameters* — so a parameter-only drift
(e.g. `required_approving_review_count` changed, `allowed_merge_methods`
widened) reported `unchanged` and never got corrected.

**Decision: canonical-authoritative semantics.** The converger's
purpose is to guarantee the *identical* canonical ruleset (from
`assets/protect-main-ruleset.json`) on every managed repo. Existing
per-repo state is not operator intent to preserve — it is exactly the
variance the converger exists to eliminate. Baseline sameness first;
per-repo variance mechanisms are a deliberately deferred, separate
concern. No preservation heuristics beyond what issue #16 §3
explicitly specifies.

**The one deliberate preservation surface remains bypass actors**
(set-containment compare, union on write, per issue §3.4) — everything
else, including `pull_request`/`required_status_checks`'s non-list
params/`code_scanning`'s tool list/`code_quality`'s severity and
`ref_name.exclude`, is now compared directly against canonical and any
difference is drift.

**How to apply:** if a future PR review on this repo suggests
"preserve the operator's existing X" for anything in the protect-main
ruleset other than bypass actors, that conflicts with this settled
decision — surface the conflict rather than silently implementing
preservation. If the *scope* changes (e.g. per-repo overrides become a
real feature), that's a new design decision requiring the human's
explicit sign-off, not an extension of this one.
