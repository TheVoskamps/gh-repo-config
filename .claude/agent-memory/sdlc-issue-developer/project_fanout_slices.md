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

**How to apply:** later slices (#13-#18) build convergence logic on
top of this package skeleton — `src/config`, `src/detect`,
`src/render`, `src/converge/*`, `src/stamp` per the decomposition's
"Converger shape" section. Don't re-scaffold `package.json`/
`tsconfig.json` — extend the existing ones.

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

See also [[fanout-design-doc-pointers]] (not yet written) if design
doc locations change.
