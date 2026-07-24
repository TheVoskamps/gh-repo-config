---
name: project-claudemd-no-provenance
description: CLAUDE.md and agent-memory in gh-repo-config carry no history/provenance prose — flag its re-introduction as a regression.
metadata:
  type: project
---

CLAUDE.md and agent-memory describe current behavior only (see the
"CLAUDE.md and agent-memory doc-hygiene convention" section of
[[project-fanout-slices]], issue-developer's memory, for the full
rule). When reviewing a PR that touches either, flag a re-introduced
commit SHA, issue/PR-number-as-explanation, or upstream-provenance
claim ("sourced from", "byte-identical to", "extracted verbatim from")
as a regression against that convention. "Authoritative" describing
CURRENT compare semantics or that `assets/` governs this repo's own
live `.github/` copy is a required positive statement, not provenance
— don't flag it.
