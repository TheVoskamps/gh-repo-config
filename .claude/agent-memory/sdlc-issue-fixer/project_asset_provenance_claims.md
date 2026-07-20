---
name: project-asset-provenance-claims
description: gh-repo-config's assets/ carries "extracted verbatim from the github-setup skill" claims that are not byte-diffable from this repo — write provenance claims to describe what's actually verifiable.
metadata:
  type: project
---

`gh-repo-config`'s `assets/` directory ships payloads (dependabot.yml,
gate/guard workflows, CodeQL files, protect-main-ruleset.json) sourced
from the `github-setup` plugin's `gh-repo-setup-protection` skill in a
separate repo (`TheVoskamps/claude-plugins-marketplace`). CLAUDE.md
historically described these as "extracted verbatim" — a byte-identity
claim.

**Why this is a trap:** the repo-boundary sandbox blocks reading
outside the current repo/worktree (by design — see global
core-principles.md #1). The upstream plugin's payload files are not
present in the local plugin cache either (only `SKILL.md` is cached,
not its `payload/` directory), so "extracted verbatim" cannot be
independently byte-diffed from a `gh-repo-config` working session. A
PR #40 review (issue #16) flagged this as a documentation-accuracy
finding: the claim was asserted as fact but was not checkable.

**How to apply:** when documenting or reviewing a provenance/verbatim
claim in this repo, either (a) make it checkable (e.g. commit a hash or
pointer to the upstream commit/version extracted from), or (b) word it
to describe only what's actually verifiable from within this repo (a
shipped self-test, a schema match, a runtime check) rather than
asserting byte-identity as settled fact. Don't silently keep an
unverifiable claim just because it was already there — sweep it when
you touch nearby doc text.
