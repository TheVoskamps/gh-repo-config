---
name: project-fanout-slices
description: Org-wide repo-configuration fan-out design facts and invariants for gh-repo-config that aren't obvious from reading the code alone — custom-property read semantics, release-immutability, merge-pass semantics, GHAS-settings decisions, ruleset/CodeQL ordering, Dependabot group-rendering invariants, and the CLAUDE.md/agent-memory doc-hygiene rule.
metadata:
  type: project
---

The org-wide repo-configuration fan-out (design in
`docs/org-repo-configuration-fanout-design.md`, decomposition in
`docs/org-repo-configuration-fanout-decomposition.md`) is tracked as a
GitHub issue tree in `TheVoskamps/gh-repo-config`. See
`CLAUDE.md`'s "Structure" section for the current file/module
inventory — this memory captures design decisions and non-obvious
findings that don't fit CLAUDE.md's file-by-file shape.

**Custom-property read semantics (non-obvious):** the
`gh-repo-config-default` org custom property is read from its
**schema's** `default_value` (`GET .../properties/schema/<name>`),
not from a per-repo value — it is an org-level setting, unlike
`gh-repo-config-mode`/`gh-repo-config-version`, which are per-repo
from `.../properties/values`. Don't assume all three properties share
one read path.

**Release-immutability has no API surface.** GitHub's release-
immutability toggle has no REST API or `gh` CLI surface — only a
one-time manual web-UI toggle under repo/org Settings > General >
Releases. Verify current state with `gh release view <tag>` rather
than assuming a converger slice can enable it programmatically.

**Coordination fact:** this repo's own visibility (private vs public)
is managed by a separate process outside the fan-out work. Don't
assume a fixed visibility when testing release/attestation flows, and
don't flip visibility from a fan-out-slice PR.

**GHAS settings design decisions (non-obvious):**

- **No stable read for push-protection delegated-bypass.**
  `secret_scanning_delegated_bypass` has no dedicated GET, unlike
  every other GHAS setting (which is genuine read-then-PATCH, skip
  the write when already at target). The converger always attempts
  this one PATCH, best-effort, every pass — deliberately excluded from
  `GhasConvergeResult.noop` (including it would make `noop` false on
  every pass, since it always reports `changed` on success).
- **Independent-concern error posture applies at two levels.** Within
  `convergeGhasSettings`, each setting's write failure is isolated (a
  422 is skip-not-fail, only an unexpected status throws). At the
  `sweep.ts` level, the whole `convergeGhas` step and the whole
  `converge` (files) step are also isolated from each other.
  "Independent concerns" applies at both the per-setting layer and the
  sweep-orchestration layer.
- **`allow_update_branch` is deliberately not converged** — a settled
  design decision, not an oversight. Don't add it without raising the
  question first.

**Ruleset + CodeQL slice:** see
[[project-codeql-ruleset-slice]] (this directory) for the ruleset/
CodeQL design deviations and the merge-before-ruleset ordering gate.

**PR-automation render tokens:** the PR-automation workflows carry
nine fixed org-level placeholders beyond the three
`renderTemplate` already resolves (`__APP_NAME__`,
`__APP_ID_SECRET__`, `__APP_PRIVATE_KEY_SECRET__`, `__MERGE_METHOD__`,
`__REST_MERGE_METHOD__`, `__DO_NOT_MERGE_LABEL__`,
`__REQUIRED_CHECK_WORKFLOW__`, `__INSTALL_GATE_WORKFLOW__`,
`__INSTALL_GATE_NPM_CHECK__`), plus the per-repo-but-derived
`__BOT_SLUG__` (`<repo>-auto-rebase[bot]`).
`renderPrAutomationTemplate` + `PR_AUTOMATION_CONSTANTS` live
separately from `renderTemplate`/`RepoContext` since these tokens are
PR-automation-specific constants, not general per-repo context — this
keeps the dependabot/CodeQL render call sites unchanged. The full
surface always renders unconditionally (no conditional-drop logic for
repos lacking certain workflows) — on a managed repo the gates/guards
are guaranteed present in the same per-repo converger PR, so every
placeholder always resolves.

**Community-file seeding:** `DesiredFile`'s optional
`honoredLocations: string[]` field is the discriminator between
"seed-if-absent" (community files) and every other payload's default
"converge-and-overwrite". `writer.ts`'s diff loop short-circuits a
community file (skip, no blob read, never compared for drift) once
the target's tree already has a path match at the file's own path
**or** any `honoredLocations` entry, reusing the single recursive
`readTree` call the pipeline already makes. Honored locations for the
current four root-level files: repo root, `.github/`, `docs/`
(case-sensitive path match). A narrower root+`.github`-only scoping
for a future file is supported by the same mechanism (one asset + one
`COMMUNITY_FILES` entry) without a seeding-logic change.

**Dependabot named-group rendering (non-obvious design directive):**
Named Dependabot groups (`NAMED_DEPENDABOT_GROUPS`) render
**identically into every armed ecosystem**, not scoped per ecosystem
— this is a hard design requirement, not an implementation default: a
per-ecosystem group *selection* mechanism would be the first crack in
the repo-identity guarantee the rest of the converger enforces (the
same principle `DEPENDABOT_ECOSYSTEMS` follows by arming the full
ecosystem set unconditionally). A group whose patterns match nothing
in a given ecosystem is simply inert there — no PR, no error. If a
future change proposes per-ecosystem group scoping, that conflicts
with this settled decision — raise it rather than silently
re-deriving different behavior. Group precedence is pure config-order
(Dependabot's first-matching-group-wins): named groups are listed
before each ecosystem's `*-minor-and-patch` catch-all, so a dependency
matching both lands in the named group; no `exclude-patterns` needed.
The `docker` ecosystem keeps its own `*-minor-and-patch`/`*-security`
catch-alls in addition to the (functionally inert there) named-group
union, consistent with "every ecosystem gets the whole registry."

## CLAUDE.md and agent-memory doc-hygiene convention

CLAUDE.md and agent-memory describe **current behavior only** — no
commit SHAs, no issue/PR numbers as explanation, no upstream-
provenance framing ("sourced from", "byte-identical to", "extracted
verbatim from"). When editing either, describe what a module/asset
does and which invariants constrain it, in present tense.

**Why:** mixed history/current-state prose rots independently of the
code and actively misdirects readers — e.g. chasing an external repo
to "fix" a payload this repo's `assets/` already owns outright, or
hand-syncing a live copy that a sweep already converges on its own.
