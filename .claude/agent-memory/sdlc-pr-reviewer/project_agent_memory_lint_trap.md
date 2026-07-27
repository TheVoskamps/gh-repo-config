---
name: agent-memory-lint-trap
description: On gh-repo-config, a committed agent-memory entry file (front-matter-first, no H1) fails MD041 under npm run lint:md, turning the required ci-required check red — check every PR that commits .claude/agent-memory/ entries
metadata:
  type: project
---

# Agent-memory files can turn the required lint check red

On `gh-repo-config`, `npm run lint:md`'s glob is `**/*.md` (excluding
only `node_modules`/`dist`), so it lints `.claude/agent-memory/**/*.md`
too. `MD041/first-line-heading` stays live there. An agent-memory
*entry* file opens with YAML front matter (`---`) followed by prose,
NOT a `# H1`, so it fails MD041 unless it carries a `# H1` as its
first content line after the front matter. `MEMORY.md` index files are
fine (they open with `# Memory Index`).

**Why:** `ci-required` (the aggregator that `needs:` the lint job) is a
required status check via the `repo-required-checks` ruleset. A single
MD041 failure in a committed agent-memory entry turns `Lint` red →
`ci-required` red → the PR is blocked. Seen live on PR #66, where
`.claude/agent-memory/sdlc-issue-developer/project_ruleset_split.md`
failed MD041 at line 8 and blocked the PR even though the PR body
claimed `lint:md — 0 issues` (the claim was made before the file was
committed / the glob covered it).

**How to apply:** when reviewing any PR here that commits or edits a
file under `.claude/agent-memory/`, run `npm run lint:md` yourself —
do not trust the PR body's "0 issues" claim. If an entry file lacks a
`# H1` first content line after its front matter, that is a real
merge-blocking finding (the required check is red), graded High, not a
cosmetic markdown nit.
