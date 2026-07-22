---
name: project-fanout-slices
description: Org-wide repo-configuration fan-out (issue #11) is being built as vertical slices in gh-repo-config; #12 via PR #20, #13 via PR #21, #24 via PR #27, #14 (real convergence) via PR #31, #15 (GHAS + merge-button settings) via PR #32, #16 (CodeQL + protect-main ruleset) via PR #40, #25 (PR-automation workflows/scripts) via PR #42, #18 (seed-if-absent community files) via PR #44.
metadata:
  type: project
---

The org-wide repo-configuration fan-out (design in
`docs/org-repo-configuration-fanout-design.md`, decomposition in
`docs/org-repo-configuration-fanout-decomposition.md`) is filed as
issue #11 with sub-issues #12-#18 in `TheVoskamps/gh-repo-config`.
Slices are meant to land independently and mostly in parallel once
slice 2 (selection loop) exists.

Slice 1 (#12, release/versioning mechanism) landed via PR #20: a
greenfield TypeScript package skeleton (`package.json`, `tsconfig.json`,
`src/`, `bin/`, `test/`) exposing a `CURRENT_VERSION` read from
`package.json`, plus `.github/workflows/release.yml` that builds,
tests, packages a tarball asset, generates a Sigstore build-provenance
attestation via `actions/attest-build-provenance`, and publishes a
GitHub Release on `v*` tag push.

**Why:** the design calls for the converger to be distributed as an
immutable, attested GitHub Release (not a fork), consumed by later
convergence slices and the CI fan-out sweep.

**How to apply:** later slices (#14-#18) build convergence logic on
top of this package skeleton — `src/config`, `src/detect`,
`src/render`, `src/converge/*`, `src/stamp` per the decomposition's
"Converger shape" section. Don't re-scaffold `package.json`/
`tsconfig.json` — extend the existing ones.

Slice 2 (#13, selection-loop walking skeleton) landed via PR #21: the
sweep control plane. `src/config/selection.ts` (managed-or-not
precedence), `src/version-compare.ts` (`isBehind` version-skip),
`src/stamp/decide.ts` (per-repo verdict), `src/github/properties.ts`
(dependency-free `fetch` REST client for the three org custom
properties: paginated read, batched <=30 stamp write, bearer-token
auth), `src/sweep.ts` (`runSweep`/`runSweepFromEnv`), a `sweep` CLI
subcommand, and `.github/workflows/sweep.yml` (scheduled +
workflow_dispatch). Convergence was a **stub** (injectable no-op
`converge` step in `runSweep`) at this point — slice #14 (below)
wired in the real one via `runSweepFromEnv`. `runSweep`'s own
`converge` option remains an injectable stub for tests.

**Placement decision on #13 (non-obvious):** the design doc
(distribution map) puts the fan-out *driver* workflow in `<org>/.github`
downloading the converger release, but I placed the walking-skeleton
sweep workflow *in this repo* running `npm ci && npm run build` against
the checked-out source. Rationale: it's the walking skeleton and the
issue's "files affected" listed a workflow under this repo's
`.github/workflows/`. A later slice may need to relocate the driver to
`<org>/.github` and consume the release asset instead of building from
source — revisit when convergence gets teeth.

**Operator-provisioning contract for #13 (not yet done, PR #21 lists
it):** a *separate* converger org App (org secrets `CONVERGER_APP_ID` /
`CONVERGER_APP_PRIVATE_KEY`) distinct from the pr-automation App
(decision 4); three org custom properties (`gh-repo-config-mode`
single-select process|ignore, `gh-repo-config-default` single-select
opt-in|opt-out with the *org-level default value* set — the sweep reads
it from the property *schema's* `default_value`, not a per-repo value;
`gh-repo-config-version` string stamp); fixture repos. The
`gh-repo-config-default` schema-default read is the subtle one: it is
org-level so it comes from `GET .../properties/schema/<name>`, whereas
`mode`/`version` are per-repo from `.../properties/values`.

**Non-obvious finding from #12:** GitHub's release-immutability toggle
has no REST API or `gh` CLI surface as of 2026-07 — only a one-time
manual web-UI toggle under repo/org Settings > General > Releases. But
when I tested the release workflow live (pushed a test `v0.1.0` tag),
`gh release view` already reported `immutable: true` on this repo —
so the setting was already enabled (by a prior converge pass or an org
default), not something #12 needed to newly enable. Verify this is
still true (`gh release view <tag>`) before assuming immutability is a
gap in a future slice.

**Coordination fact:** this repo's visibility (private -> public) is
being managed in a separate, concurrent workflow outside the fan-out
issues. Don't assume a fixed visibility when testing release/attestation
flows; don't attempt to flip visibility from a fan-out slice's PR.

Issue #24 (sweep merges its own green converger PRs — the control
plane's "unattended end to end" half) landed via PR #27: new
`src/github/merge.ts` (`MergeClient`, same dependency-free-`fetch`
shape as `properties.ts`), wired into `runSweep` as an optional
`mergeClient`/`appSlug` pair on `SweepOptions` (omitted -> merge pass
skipped, so it doesn't force every `runSweep` caller/test to fake a
merge client), and `runSweepFromEnv` now requires a new env var
`GH_REPO_CONFIG_APP_SLUG` (sourced in `sweep.yml` from the existing
token-mint step's `app-slug` output, not a new secret). The merge pass
runs over *every* repo the properties API returns each tick,
independent of that repo's version-skip decision — a stamped repo can
still have an unmerged PR sitting open from a prior tick. Required
checks are resolved from the rules API
(`/repos/{o}/{r}/rules/branches/{branch}`, matching the
`protect-main` ruleset model, not legacy branch protection); an empty
required-check set is mergeable outright (unprotected fixtures). A
405/409 from the merge PUT itself is `awaiting-retry`, not a failure —
distinct from a red/pending required check (`blocked`/`pending`,
surfaced in the new `SweepReport.awaitingChecks`, also not a sweep
failure).

Issue #14 (converge `dependabot.yml` + gates/guards, first real
convergence teeth) landed via PR #31: `src/github/contents.ts`
(`ContentsClient`, git-data-API file writer — blobs → tree → commit →
ref, so scripts land mode `100755`, which the contents API cannot
set) and `src/converge/` (`assets.ts`, `render.ts`, `files.ts`,
`writer.ts` — see [[dependabot-render-spec]] for the
`__DEPENDABOT_ECOSYSTEMS__` expansion rules). Templates extracted
verbatim from the `github-setup` plugin's `gh-repo-setup-protection`
payload into `assets/` at the repo root (packed into the release
tarball alongside `dist`/`bin`/`package.json`). `runSweepFromEnv` now
wires `convergeRepoFiles` as the real `converge` step; `runSweep`
itself keeps an injectable stub for tests. Whole-file compare (a
right-content-wrong-mode script counts as differing); no diff means
no branch and no PR. Writes to the fixed `gh-repo-config/converge`
branch, never to the default branch — merging is issue #24's job
(already landed, see above).

Issue #15 (converge GHAS/repo-security + merge-button settings, pure
API mutations, no files/PR) landed via PR #32: new
`src/github/settings.ts` (`RepoSettingsClient`, same dependency-free-
`fetch` shape) and `src/converge/ghas.ts` (`convergeGhasSettings`).
Wired into `runSweep` as a second injectable step (`convergeGhas`,
alongside the existing `converge` for files), both gated on the same
`converge`-decision branch and run in independent try/catch blocks per
repo — a failure in one never discards or skips the other's result,
but either failure marks the repo `failed` and excludes it from
stamping. `runSweepFromEnv` wires the real `convergeGhasSettings`.
Per-repo settings outcomes surface in the new
`SweepReport.ghasResults` and the CLI summary.

**Non-obvious findings from #15:**

- **No stable read for push-protection delegated-bypass.** Every other
  setting is genuinely read-then-PATCH (skip the write when already at
  target), but `secret_scanning_delegated_bypass` has no dedicated GET
  — the issue's own pre-extracted context from the `gh-repo-setup-protection`
  skill confirms this ("no clean, stable per-repo public REST toggle").
  The converger therefore always attempts this one PATCH, best-effort,
  every pass — it is deliberately excluded from the `GhasConvergeResult.noop`
  calculation (including it would make `noop` false on every single
  pass, since it always reports `changed` on success).
- **Independent-concern error posture applies at two levels.** Within
  `convergeGhasSettings`, each setting's write failure is isolated (a
  422 is skip-not-fail, only an unexpected status throws). At the
  `sweep.ts` level, the *whole* `convergeGhas` step and the *whole*
  `converge` (files) step are also isolated from each other — this
  wasn't explicit in the issue but follows from "independent concerns"
  read at the sweep-orchestration layer too.
- **`allow_update_branch` deliberately omitted** (human-confirmed
  decision baked into the issue body itself, not something I decided
  independently) — `gh-repo-setup-protection`'s merge-button table
  includes it but issue #15's spec doesn't list it, so the converger
  treats the issue body as authoritative and does not converge that key.

Issue #16 (converge protect-main ruleset + CodeQL, absorbing #17 into
the same PR rather than a separate one) landed via PR #40: new
`src/converge/ruleset.ts` (`convergeProtectMainRuleset`) +
`src/github/rulesets.ts` (`RulesetsClient`), and
`src/converge/default-setup.ts` (`convergeDefaultSetup`) +
`src/github/code-scanning.ts` (`CodeScanningClient`) for the
server-side CodeQL default-setup-off mutation. The CodeQL file payload
(advanced workflow + config + runtime language-detection script) rides
the existing #14 render pipeline via `src/converge/files.ts`. See
[[project-codeql-ruleset-slice]] (this directory) for the design
deviations from the `gh-repo-setup-protection` skill and the
merge-before-ruleset ordering gate.

Issue #25 (converge PR-automation workflows + scripts, the render
slice missing from the original decomposition tree) landed via PR #42:
extracted `auto-enable-automerge.yml`, `auto-rebase-prs.yml`,
`auto-rebase-lockfile-regen.sh` + its self-test verbatim from the
`github-setup` plugin's `gh-repo-setup-pr-automation` payload into
`assets/`, riding the existing #14 render/write pipeline via
`src/converge/files.ts`. The two workflows carry 9 fixed org-level
placeholders beyond the three `renderTemplate` already resolves
(`__APP_NAME__`, `__APP_ID_SECRET__`, `__APP_PRIVATE_KEY_SECRET__`,
`__MERGE_METHOD__`, `__REST_MERGE_METHOD__`, `__DO_NOT_MERGE_LABEL__`,
`__REQUIRED_CHECK_WORKFLOW__`, `__INSTALL_GATE_WORKFLOW__`,
`__INSTALL_GATE_NPM_CHECK__` — every value pinned directly by the
issue, nothing inferred), plus a per-repo-but-derived `__BOT_SLUG__`
(`<repo>-auto-rebase[bot]`). Added `renderPrAutomationTemplate` +
`PR_AUTOMATION_CONSTANTS` to `src/converge/render.ts` rather than
extending `renderTemplate`/`RepoContext` itself, since the 9 extra
tokens are PR-automation-specific constants, not general per-repo
context — keeps the existing dependabot/CodeQL render call sites
unchanged. Rendered the **full surface unconditionally** (no
conditional-drop logic like the interactive `gh-repo-setup-pr-
automation` skill has for repos lacking certain workflows) — on a
managed repo the gates/guards are guaranteed present in the same
per-repo converger PR (#14), so every placeholder always resolves;
confirmed by two of the two templates' placeholder counts (33 and 41
occurrences respectively) matching the issue's pinned table exactly.

Issue #18 (seed community/governance files into managed repos,
seed-if-absent) landed via PR #44: extracted this repo's own root
`CONTRIBUTORS`/`LICENSE`/`PATENTS`/`PRIOR_ART.md` verbatim into
`assets/`, added a `COMMUNITY_FILES` list in `src/converge/files.ts`,
and extended `DesiredFile` with an optional `honoredLocations: string[]`
field — its presence is the discriminator between "seed-if-absent"
(community files) and every other existing payload's default
"converge-and-overwrite". `writer.ts`'s diff loop short-circuits a
community file (skip, no blob read, never compared for drift) once the
target's tree already has a path match at the file's own path **or**
any `honoredLocations` entry — reusing the single recursive `readTree`
call the pipeline already makes (its full path-key set, not just blobs
matching the desired path), so no extra API calls were added. Honored
locations for this rollout's four root-level files: repo root,
`.github/`, `docs/` (case-sensitive path match). `FUNDING.yml`'s
narrower root+`.github`-only scoping (flagged in the issue for a future
file) isn't exercised yet, but the mechanism (a plain per-entry string
list) already supports it when that file is added — one asset + one
`COMMUNITY_FILES` entry, no seeding-logic change.

See also [[fanout-design-doc-pointers]] (not yet written) if design
doc locations change.
