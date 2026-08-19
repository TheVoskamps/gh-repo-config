---
name: state-once-means-once-per-audience
description: "\"State the prerequisite once\" in this repo means once per audience — a src/ TSDoc never reaches a managed repo's maintainer, so the shipped assets/ header needs its own copy"
metadata:
  type: project
---

# State once means once per audience

When a ruling says to state an operator prerequisite once at its
definition site and keep other mentions consistent, the definition
site alone is not enough here. `src/converge/render.ts` never leaves
this repo; `assets/*.yml` is rendered into every managed repo, and its
header is the only prose a downstream maintainer will ever read. So
the full reason goes in both, and the remaining mentions (CLAUDE.md,
the sibling asset) name the requirement and point at the fuller
statement.

**Why:** the payload/repo split is asymmetric — this repo's readers
and the managed repos' readers are different people with disjoint
file access. A single copy in `src/` silently serves only half of
them.

**How to apply:** before collapsing duplicated prose to one copy, ask
which of the candidate files actually ship. Put the reasoned copy in
the shipped file whose behaviour the reason is about (here
`auto-enable-automerge.yml`, the only `pull_request`-triggered
template), and let non-shipping files cross-reference it. Relates to
[[sweep-past-the-diff-for-falsified-prose]].
