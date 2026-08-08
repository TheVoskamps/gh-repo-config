---
name: generalize-the-level-above-too
description: When a finding says "replace this hardcoded list with a loop", check the enclosing selector for the same hardcoding before you call it done
metadata:
  type: feedback
---

# Generalize the level above too

When a finding asks you to replace a hardcoded enumeration with a
mechanism driven by the canonical source, look one level up before you
report done: whatever *selects* the things you just started looping
over is usually hardcoded by the same author, in the same style.

**Why:** on PR #84 (issue #82) one round generalized the parameter-KEY
loop inside `rulesetSemanticDiff` while leaving four `findRule(desired,
"<type>")` calls selecting WHICH RULES got compared. The reviewer
returned it as "the same failure mode, one level up" — a second full
round trip for a defect the first round could have swept.

**How to apply:** after the edit, grep the changed function for any
remaining string literal naming a member of the canonical asset. If one
survives, ask whether the canonical body could grow a member the
literal would miss. Same test discipline applies at the new level: the
pinning test must fail against the pre-change code (see
[[prove-a-replacement-assertion-bites]]), and the prose describing the
mechanism has to be rewritten at both levels, not just the inner one.
