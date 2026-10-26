# PR conventions

## Every PR advances the `version` core

Every PR bumps `version` in the root `package.json` past main's
`MAJOR.MINOR.PATCH` core. The sweep runs a release tarball, never
`main`'s source tree: the release the org's `version-pin` names, else
the latest. A release is cut by pushing a `vX.Y.Z` tag that
`release.yml` requires to equal `package.json`'s `version`, and the
sweep skips every repo already stamped at the version it runs. The bump
keeps `main` ahead of the last release, so any commit on it can be
tagged as a release every stamped repo is behind; a change merged
without one leaves `main` at a version already released, which no new
tag can ship. The version compare reads only the core, so a
prerelease or build identifier delivers nothing and fails `pnpm test`.
Re-check the bump after a rebase, since a concurrent merge may have
taken the value you picked. Semver picks the component; the move to
`1.0.0` is a human's decision, never routine work.

## Acceptance criteria yield to a correct design

When a review finding shows an issue's acceptance criterion or Design
section encodes the wrong design, implement the one correct mechanism
and update the issue body to match. Never keep the old mechanism beside
it so the criterion's wording stays true, and reconcile against every
criterion on the live issue, not only the ones the finding names.

## Sweep the repo for prose a structural change falsified

After a structural change — a job shape, a file move, a renamed
export — grep the retired term across the whole repo
(`--exclude-dir=node_modules --exclude-dir=dist`) rather than
re-reading the diff's own files, since the falsified prose mostly sits
in files the diff never touched. Historical narration stays, a
present-tense claim is a defect. Fixing an out-of-diff one-line
comment is in scope; a refactor is not.
