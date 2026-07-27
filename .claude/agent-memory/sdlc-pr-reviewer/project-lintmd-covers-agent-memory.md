---
name: project-lintmd-covers-agent-memory
description: gh-repo-config's npm run lint:md globs **/*.md (only #node_modules #dist excluded), so it lints .claude/agent-memory/**/*.md too; a front-matter-first memory file added in the same PR that adds the lint gate will fail MD041.
metadata:
  type: project
---

# lint:md covers .claude/agent-memory

`gh-repo-config`'s `package.json` `lint:md` script is
`markdownlint-cli2 "**/*.md" "#node_modules" "#dist"` — it excludes
only `node_modules` and `dist`, so it lints **everything else**,
including `.claude/agent-memory/**/*.md`. The repo's
`.markdownlint.jsonc` disables only `MD013`; `MD041`
(first-line-heading) is live.

Agent-memory files begin with YAML front matter (`---` … `---`) then
prose, with no `# H1` first content line. That is an MD041 violation.

**Why this matters:** on the PR that first introduced the CI `lint`
job (issue #58, PR #65), the developer ran `npm run lint:md` (17 files,
clean) *before* the "Add agent memory from issue-developer" capture
commit added an 18th file — a front-matter-first memory note — which
itself fails MD041. The lint job the PR introduces therefore goes red
on the PR's own head SHA, so the `ci-required` aggregator fails and the
acceptance criterion "Lint jobs green with zero suppression" is unmet.
The `MEMORY.md` index files pass because they open with `# Memory
Index`; individual memory notes do not, unless given an H1.

**How to apply:** when reviewing (or authoring) a PR in this repo that
touches `.claude/agent-memory/` AND relies on `lint:md` being green,
check that every added/changed memory `.md` file has an `# H1` as its
first content line after the front matter. The memory-capture commit
lands *after* the developer's own lint run, so it is exactly the file
class a developer's pre-commit lint check misses. The intended posture
is that agent-memory markdown IS linted (the same PR fixed MD041 on
the existing MEMORY.md indexes), so the fix is to add the H1, not to
exclude the directory.
