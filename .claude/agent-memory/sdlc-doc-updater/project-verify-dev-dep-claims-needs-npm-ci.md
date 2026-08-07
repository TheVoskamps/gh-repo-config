---
name: verify-dev-dep-claims-needs-npm-ci
description: In this repo a worktree starts with no node_modules, so any doc claim about a dependency's presence or export shape needs `npm ci` first to check
metadata:
  type: project
---

# Verifying dependency claims in a fresh worktree

A subagent worktree here starts with no `node_modules`, and even the
primary clone often has only prod deps installed. So `npm ls <pkg>`
returns `(empty)` for every dev-tree package, which looks like evidence
the package is absent. Run `npm ci` (lockfile-honoring, allowed) before
concluding anything, and prefer `package-lock.json` as the durable
citation in prose since it is present regardless of install state.

**Why:** a test docstring that justifies hand-rolling a YAML helper
with claims about `js-yaml` being an undeclared transitive dep of
`markdownlint-cli2`, and about its ESM export shape, states two true
things that are nonetheless uncheckable until `npm ci` has run — the
docstring's own suggested check (`npm ls js-yaml`) reproduces as empty
in a fresh worktree, which reads as a refutation and is not one.

**How to apply:** when a doc comment or doc file asserts something
about a package's presence, dependents, version, or export shape,
install from the lockfile and verify it empirically (`node
--input-type=module -e "import ..."` settles export shape). Then
rewrite the prose to cite `package-lock.json` and name the pinned
version, so a future reader can re-check without an install.
