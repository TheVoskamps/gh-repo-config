# Workflows and payloads

## A rendered copy under `.github/` is never hand-edited

A file under this repo's `.github/actions/`, `.github/scripts/`, or
`.github/workflows/` that renders from a file under `assets/` is sweep
output, converged whenever the sweep runs over this repo; the change
goes into `assets/`. A workflow with no `assets/` counterpart is
repo-own and hand-maintained here. A repo-own script goes under
`scripts/`, never `.github/scripts/`.

## This repo is never named as a sweeper repo

`assets/sweeper-sweep.yml` renders to `.github/workflows/sweep.yml` only
on the repo `GH_REPO_CONFIG_SWEEPER_REPO` names. This repo carries no
sweep workflow, and nothing sets that variable to this repo, so no
sweep writes one here.

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

## The converger takes no per-repo setting

A payload renders the same on every managed repo but for values derived
from the repo itself and the org's `gh-repo-config.json`. What differs
between repos is read by the rendered workflow when it runs: every
Dependabot ecosystem is armed, the gates and CodeQL each detect what is
present before they act, and `codeartifact-auth` acts on the
`CODEARTIFACT_ROLE` Actions variable, set at org level and overridden
at repo level, and no-ops where it is unset. A new payload reads its
variance the same ways rather than adding a per-repo input to the
converger. The sweeper workflow, which lands on one repo per org, is
the one payload a repo's identity decides.

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
managed repo.

## The sweeper workflow's policy bullets follow `writer.ts`

`assets/sweeper-sweep.yml`'s header `sweeper-update-policy` bullets
follow `src/converge/writer.ts`: the `manual` bullet says the PR is
opened as a draft, and the `auto` and `off` bullets each say the hold
is released.
