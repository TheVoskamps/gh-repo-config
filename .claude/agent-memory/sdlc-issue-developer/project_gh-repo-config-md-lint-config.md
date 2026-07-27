---
name: project-gh-repo-config-md-lint-config
description: gh-repo-config has a checked-in .markdownlint.jsonc (disables only MD013 line-length); every other default rule, including MD041 first-line-heading, is live and enforced by the new ci.yml lint job (issue #58).
metadata:
  type: project
---

# `gh-repo-config` markdownlint config

`gh-repo-config`'s repo root carries a `.markdownlint.jsonc` that
disables only `MD013` (line length, because `docs/` has wide tables
and ASCII trees). Every other markdownlint default rule stays active,
including `MD041` (first line must be a top-level heading) and `MD022`
(blank lines around headings). Before issue #58 added
`.github/workflows/ci.yml`'s `lint` job, nothing enforced this, so a
number of tracked `*.md` files (agent-memory feedback notes, the
pr-reviewer `MEMORY.md` index, `README.md`, both `PRIOR_ART.md`
copies, `.claude/rules/repo-config.md`) had pre-existing MD041/MD022
violations, fixed in that same PR.

**Why this matters:** `.claude/rules/repo-config.md` is machine-parsed
by the `issues` plugin's `skills/lib/repo-config.md` reader, which
scans the file body for a `github-project:` (or `jira:`) line **at
column 0**, not by line position. That means a `# Repo Config` H1
heading can be inserted immediately after the front-matter's closing
`---` and before the `github-project:` block without breaking the
reader contract — confirmed by re-reading
`skills/lib/repo-config.md` step 6 before making the edit. Do not
add a `title:` key to the front matter itself as a fix — that
front-matter schema is a cross-plugin contract (`schema-version`,
`source-control`, `issues`, etc.) fully overwritten by `/repo-config`
re-runs, and an unrecognized extra key is out of scope to add.

**How to apply:** the two files this reasoning does NOT safely extend
to are `PRIOR_ART.md` and its `assets/PRIOR_ART.md` twin — those are
shipped byte-for-byte to every managed repo (`COMMUNITY_FILES` in
`src/converge/files.ts`), so any content change there (even adding an
H1) changes what every future managed repo receives. It was still the
right call for issue #58 (trivial, meaning-preserving), but flag it
explicitly rather than fixing it silently — a future lint sweep might
disagree about whether that file's shipped content should change.
