---
name: project-asset-provenance-claims
description: gh-repo-config's assets/ "extracted verbatim from github-setup" claims are now independently checkable via a scratch clone of the marketplace repo — issue #43/PR #48 did this diff; five files diverge as of PR #48's round-2 fix.
metadata:
  type: project
---

`gh-repo-config`'s `assets/` directory ships payloads (dependabot.yml,
gate/guard workflows, CodeQL files, protect-main-ruleset.json) sourced
from the `github-setup` plugin's `gh-repo-setup-protection` and
`gh-repo-setup-pr-automation` skills in a separate repo
(`TheVoskamps/claude-plugins-marketplace`). CLAUDE.md describes these
as "extracted verbatim" — a byte-identity claim.

**Resolved (issue #43, PR #48):** the claim is independently
re-verifiable after all — a scratch clone of
`TheVoskamps/claude-plugins-marketplace` (`main`,
`plugins/github-setup/payload/<skill>/<file>`) carries the same payload
files the plugin cache installs, byte-for-byte diffable against this
repo's `assets/`. (The earlier belief that only `SKILL.md` is available
and `payload/` is not was wrong — `payload/` is present in the
marketplace repo itself, just not in the local plugin *cache*; cloning
the source repo bypasses that.) PR #48's first pass diffed against
upstream 0.11.3 and found six files diverge; a round-2 review caught
that one of those six (`dependency-pinned-gate.yml`) diverged only by
a comment-only header line the PR itself could adopt verbatim from
upstream, so PR #48 also folded in that header-wording change — making
the file byte-identical and dropping the true post-PR count to five
(see CLAUDE.md's `assets/` bullet for the current per-file breakdown).
**Lesson:** when a divergence is "comment-only, could just match
upstream," check whether adopting upstream's wording is in scope for
the PR already touching that file — leaving it as documented-but-
avoidable divergence is exactly the kind of doc-staleness a later
review round will catch. A self-test passing
(`test-codeql-language-present.sh`, `test-auto-rebase-lockfile-
regen.sh`) is still not proof of byte-identity by itself — only the
direct upstream diff is — but the diff itself is no longer blocked.

**How to apply:** when documenting or reviewing a provenance/verbatim
claim in this repo, prefer making it checkable (cite the upstream
commit/version and note the scratch-clone diff method above) over
asserting byte-identity as unverifiable fact. If a future divergence
check is needed, redo the scratch-clone diff rather than assuming the
local plugin cache is sufficient, and prefer a list-carries-the-count
phrasing (per this repo's `~/.claude/rules/core-principles.md` §7)
over a bare number, since that number rots on the next sync.
