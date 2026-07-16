---
name: project-fanout-slices
description: Org-wide repo-configuration fan-out (issue #11) is being built as vertical slices in gh-repo-config; slice 1 (release/versioning, #12) landed via PR #20.
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
workflow_dispatch). Convergence is a **stub** (injectable no-op
`converge` step in `runSweep`) — slices #14-#18 replace it. The stub
lives at the `converge` option in `src/sweep.ts`, not a separate
module yet.

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

See also [[fanout-design-doc-pointers]] (not yet written) if design
doc locations change.
