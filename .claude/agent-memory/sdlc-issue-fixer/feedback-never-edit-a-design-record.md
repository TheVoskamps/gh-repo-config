---
name: feedback-never-edit-a-design-record
description: A doc marked "Status: design, not yet implemented" is a record of intent — code changing cannot falsify it, so never edit it to match as-built behaviour
metadata:
  type: feedback
---

# Never edit a design record to match as-built code

A doc whose header says `Status: design, not yet implemented.` (in this
repo, `docs/org-repo-configuration-fanout-design.md`) is a **design
record** — a statement of what was intended at a point in time, not a
description of the code as it stands. Leave its prose alone even when
the code no longer matches it. If a review finding claims such a doc's
prose is "now false", the finding is wrong about the doc's genre; say
so and fix nothing.

**Why:** Edwin directed this on PR #79 (issue #77) after two rounds on
that branch rewrote the design doc's "no per-repo inputs" paragraph to
describe the collapsed gates, on the theory that the code change had
made the prose false. Code changing cannot falsify a record of intent —
it makes the code *diverge* from the design, and that divergence is
information worth preserving rather than erasing. The edit also left
the file half-design/half-as-built, which is worse than either pure
form. Both rounds were reverted with
`git checkout origin/main -- <path>`.

**How to apply:** Before editing any file under `docs/`, read its first
few lines for a status/genre marker. Marked as design or as a historical
record → out of bounds for as-built corrections, and out of bounds for
"sweep the class" prose sweeps after a structural change. As-built
behaviour belongs in `CLAUDE.md`, in the asset's own inline comments, or
in a doc that does not claim to be a design. This is the one carve-out
to [[feedback-sweep-past-the-diff-for-falsified-prose]]: that rule says
grep repo-wide for prose a structural change falsified, and this one says
a design record is never among the hits to fix.
