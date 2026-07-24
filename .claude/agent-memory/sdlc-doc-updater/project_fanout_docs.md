---
name: project-fanout-docs
description: Which docs track the org-wide repo-config fan-out, and the doc-sync check doc-updater applies on each slice PR.
metadata:
  type: project
---

The fan-out's design doc (`docs/org-repo-configuration-fanout-design.md`)
and decomposition doc (`docs/org-repo-configuration-fanout-decomposition.md`)
are written *ahead* of implementation — a slice's PR generally
implements what the design doc already describes, rather than the design
doc needing to catch up. Don't assume a slice PR requires a design-doc
rewrite; check whether the design doc's existing prose already covers the
new behavior (it usually does) before editing it. The decomposition doc's
"Converger App — permission set" table is the one place that *does* need
a per-slice row added whenever a slice's PR starts exercising a REST
surface the table doesn't yet list.

**Why:** the design doc was written in one pass covering the full
"unattended end to end" architecture before the slices that implement
each piece existed. Treating it as implementation-drives-docs would
cause needless rewrites; the permission table is the exception because
it's a concrete enumeration of REST calls, which the design prose is
not.

**How to apply:** for a new fan-out slice PR, read the design +
decomposition docs first — if the PR's behavior matches prose already
there, no edit is needed. Do check the permission table for a missing
row, even when no edit turns out to be needed — a table already scoped
correctly (e.g. explicitly stating a workflow makes no `orgs/`/`repos/`
REST calls) can validly require zero changes, but that must be
confirmed by checking, not assumed. CLAUDE.md's "Structure" section
always needs updating per-slice (new `src/` files, new env vars, new
workflow behavior) since it's a literal file/command inventory, not a
design narrative — when a new payload family is introduced, also
double check any sourcing/attribution prose stays accurate, not just
the file list.

**Don't assume "design doc prose already covers it, no edit needed"
without actually diffing the *mechanism* the PR implements against the
doc's prose, not just the externally-visible behavior** — a behavior
can match a documented design while the mechanism underneath (source
of truth, required permissions) diverges from what the doc describes.
When a PR's mechanism diverges from the design doc's existing prose,
add an explicit "shipped differently" note at the point of divergence
rather than silently rewriting the design doc's original prose to
match — the design doc is also a decision record, and quietly editing
it to match what shipped erases the fact that a decision was
revisited.
