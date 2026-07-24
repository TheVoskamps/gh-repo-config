---
name: project-claudemd-no-provenance
description: CLAUDE.md in gh-repo-config deliberately carries NO history/provenance — no upstream-verification, no commit SHAs, no issue/PR numbers as explanation; assets/ is the sole source of truth, live .github/ copies converge via the sweep.
metadata:
  type: project
---

CLAUDE.md was rewritten to describe **only current behavior**, cutting
all history/provenance: upstream byte-identity classifications, commit
SHAs, issue/PR-number citations, and origin stories. When reviewing a
later PR that touches CLAUDE.md, treat the ABSENCE of that prose as
correct, and flag its RE-introduction (a new "sourced from upstream",
"byte-identical to the github-setup plugin", commit SHA, or "(issue
#N)" explanation) as a regression against this convention.

**Why:** the mixed history/current-state prose actively misdirected
readers — e.g. an issue-developer chasing the `github-setup` plugin
repo to "fix" a payload that this repo's `assets/` owns outright, or
hand-syncing `.github/` live copies the sweep already converges. This
repo's `assets/` files ARE the payloads; there is no upstream source
of truth to reconcile/verify against at runtime.

**How to apply:**
- The old "verify assets/ against upstream via a marketplace scratch
  clone" reviewer technique is now MOOT — CLAUDE.md asserts no upstream
  relationship, so there is no such claim to verify. Do not resurrect
  that check for this repo.
- The one surviving `github-setup` mention (the dependabot ecosystem
  resolution spec "lives in" that plugin's SKILL.md) is a live
  doc-pointer, not a provenance/authority claim — leave it.
- "authoritative" is fine when it means the CURRENT compare semantics
  (ruleset canonical-authoritative) or that `assets/` is authoritative
  over the repo's own live `.github/` copy — that positive statement is
  required, not forbidden.

See [[project-fanout-review]] for slice context.
