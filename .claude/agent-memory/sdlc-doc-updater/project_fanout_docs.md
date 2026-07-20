---
name: project-fanout-docs
description: Which docs track the org-wide repo-config fan-out (#11) slices, and what doc-updater has kept in sync so far — #24 (merge pass) via PR #27, #16 (ruleset+CodeQL) via PR #40.
metadata:
  type: project
---

The fan-out's design doc (`docs/org-repo-configuration-fanout-design.md`)
and decomposition doc (`docs/org-repo-configuration-fanout-decomposition.md`)
are written *ahead* of implementation — each slice's PR generally
implements what the design doc already describes, rather than the design
doc needing to catch up. Don't assume a slice PR requires a design-doc
rewrite; check whether the design doc's existing prose already covers the
new behavior (it usually does) before editing it. The decomposition doc's
"Converger App — permission set" table is the one place that *does* need
a per-slice row added whenever a slice's PR starts exercising a REST
surface the table doesn't yet list — issue #24 (merge pass, PR #27) added
a `Pull requests: write` row for listing/merging the App's own PRs.

**Why:** the design doc was written in one pass covering the full
"unattended end to end" architecture (including the merge-pass section)
before the slices that implement each piece existed. Treating it as
implementation-drives-docs would cause needless rewrites; the permission
table is the exception because it's a concrete enumeration of REST calls,
which the design prose is not.

**How to apply:** for a new fan-out slice PR, read the design +
decomposition docs first — if the PR's behavior matches prose already
there, no edit is needed. Do check the permission table for a missing
row. CLAUDE.md's "Structure" section always needs updating per-slice
(new `src/` files, new env vars, new workflow behavior) since it's a
literal file/command inventory, not a design narrative. See
[[project-fanout-slices]] (issue-developer's memory) for the full
per-slice implementation history this doc work tracks against.

**Issue #16 confirmed the pattern held:** the decomposition doc's
permission table already carried both new REST-surface rows
(`code-scanning/default-setup` PATCH and repo `rulesets` POST/PUT)
before the slice landed — no table edit needed. Only CLAUDE.md's
"Structure" section and the decomposition doc's slice-5/6 prose
(noting issue #17 was absorbed into issue #16's PR rather than
shipping separately) needed updates.
