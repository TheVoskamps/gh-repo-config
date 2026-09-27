# Workflows and payloads

## A rendered copy under `.github/` is never hand-edited

A file under this repo's `.github/actions/`, `.github/scripts/`, or
`.github/workflows/` that renders from a file under `assets/` is sweep
output, converged whenever the sweep runs over this repo; the change
goes into `assets/`. A workflow with no `assets/` counterpart is
repo-own and hand-maintained here. A repo-own script goes under
`scripts/`, never `.github/scripts/`.

## This repo is never named as a sweeper repo

`assets/sweeper-sweep.yml` renders to `.github/workflows/sweep.yml` on
the repo `GH_REPO_CONFIG_SWEEPER_REPO` names, which is the path of this
repo's own hand-maintained sweep. Nothing sets that variable to this
repo, so the payload never converges over the hand-maintained file.

## A repo-own required check is registered outside `protect-main`

A status check a repo-own workflow must pass is required through
`.github/rulesets/repo-required-checks.json`, never through
`assets/protect-main-ruleset.json`, whose required-check set the sweep
converges on every managed repo and reverts on this one.

## No fanned-out workflow gains a job

GitHub bills a whole minute per job, rounded up, while a check name is
free, so per-leg work in a rendered workflow stays a step or a
`run`-block loop inside its existing jobs, and a stage's ordering comes
from steps, not from separate jobs. `test/files.test.js`'s
`EXPECTED_JOBS` table pins every rendered workflow's job ids, so adding
a job means editing that table, and the PR argues the billing cost
there.

## A detection mode reports over stdout only

A payload script's detection mode (`--present`, `--matrix`) prints its
result to stdout for the calling step to capture, and writes nothing to
`$GITHUB_OUTPUT`; a step that needs the result later derives its own
output from that capture.

## Every App token mint uses `client-id:`

Every `actions/create-github-app-token` step passes `client-id:`, fed
from a secret holding the App's Client ID, never the deprecated
`app-id:`, whose `deprecationMessage` would warn on every run of every
managed repo. The Client ID and the numeric App ID are different
values, so the secret is a different secret, not a renamed one.

## The PR-automation workflows stay split by event

`auto-rebase-prs.yml` owns every trigger but `pull_request`, and
`auto-enable-automerge.yml` owns `pull_request` alone. Neither is
merged into the other or retired: the converger has no delete path, so
a retired rendered workflow keeps running, and billing, on every
managed repo. The rebase backstop and the merge backstop in
`auto-rebase-prs.yml`'s `schedule:` keep their separate rationales in
its comments.

## The sweeper workflow verifies before it unpacks

`assets/sweeper-sweep.yml` unpacks and executes nothing from the
release tarball before `gh attestation verify` passes, and mints the
converger App token only after that, so no privileged credential is
live while an unverified archive is handled. Its header's
`sweeper-update-policy` bullets follow `src/converge/writer.ts`: the
`manual` bullet says the PR is opened as a draft, and the `auto` and
`off` bullets each say the hold is released.
