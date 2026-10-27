# gh-repo-config

GitHub Organization-wide Repo configuration for fan-out of rulesets, actions, and workflows to protect and automate

## Development

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm lint
```

Releases are published as attested GitHub Releases from
`.github/workflows/release.yml` on the push of a `v*` tag that points
at a merge commit on `main`'s first-parent history; a tag on any other
commit fails the run before it builds anything.

## Architecture decisions

Each decision below holds today, with the reason it was taken.

### The standard is converged, never scaffolded

Every sweep reads each managed repo's settings, ruleset and rendered
files and writes only what differs, so a repo that has drifted is
brought back and an already-converged repo gets no write at all. A
GitHub template repository would copy files once at creation and never
again, so it plays no part.

### One public source, consumed as an attested release

The converger lives in this one public repo, and an org consumes it as
a release tarball, never as a fork: a fork pulls the wrong way and
drifts silently, while a public release asset needs no access beyond a
workflow's default token to download. A release carries a build-provenance attestation, and every consumer runs
`gh attestation verify` against this repo on the tarball before
unpacking or running anything from it.

### A release ships only what `main` merged

Every org's sweep downloads the latest release, and a tag is pushed by
hand, independently of any pull request, so the tag is the one point
where unreviewed code could reach every managed repo. The release
workflow therefore accepts only a tag at a merge commit on `main`'s
first-parent history — a commit `main` reached by merging a pull request
through its review and merge gates — and fails on any other tag, a
feature-branch commit included, before it installs or builds anything.
No ruleset in this repo targets tags, so this check is what stands in
for one.

### Each org sweeps itself from its own private repo

The scheduled sweep runs in the org's own private sweeper repo, as a
GitHub App the org registers and installs itself, with secrets the org
holds. Every credential and all authority over the org stay in the
org; what this repo ships is code, verified at the point of use. The
sweep is the one trigger: a newly created repo is an unstamped repo the
next tick picks up, so no on-create path exists beside it.

### Every change reaches a repo as a pull request

The converger never pushes to a default branch. It commits onto one
fixed work branch per repo and opens or updates one pull request, which
is the same path on a repo's first convergence and on every later one,
since a protected default branch admits nothing else.

### Converger pull requests merge unattended

The review that matters happens once, upstream, on the change to this
repo; re-reviewing its mechanical fan-out once per repo per release
would add toil, not scrutiny. The required checks on each converger
pull request are what still bind: a red check leaves the pull request
open, which is the escalation to a human.

### The applied version is an org custom property

Each converged repo is stamped with the converger version that was
applied, in the org custom property `gh-repo-config-version`, and the
sweep skips every repo stamped at or past the running version. A custom
property is queryable across the org in one paginated call and
survives churn in the repo's own tree, which a per-repo file is not and
does not. There is one stamp per release, not one per concern, since
every concern ships from the same release.

### A failed concern does not stop the others

Within a repo, the file convergence, the security settings and the
CodeQL default-setup write each run in their own error scope: a failure
in one is recorded against the repo and the others still run, and the
repo is left unstamped so the next tick retries it. A setting a repo's
plan does not entitle it to is reported and skipped rather than failed.
The sweep as a whole fails when any repo did.

### `protect-main` is a repo-level ruleset

The sweep converges a `protect-main` ruleset on each managed repo to
the canonical shape, and when an active org-level branch ruleset
already governs the repo's default branch it deletes the repo-level
copy and defers to it. The converger App and the org's PR-automation
App are `pull_request` bypass actors on the ruleset; a bypass actor an
operator added is preserved, every other field converges to the
canonical shape.

### CodeQL advanced setup, and default setup off

Every managed repo gets the advanced-setup CodeQL workflow, which
detects at run time which languages the repo holds, and has GitHub's
default setup driven to not-configured, since the two are mutually
exclusive.

### Community files are the org's own, seeded once

The community and governance files the converger places in a repo are
read from the org's own `.github` repo at sweep time, not shipped from
this repo, since another org's license and contributor policy are its
own. Each is seeded only where the repo has no copy of its own at any
location GitHub honors for that file, and an existing copy is never
overwritten.

## Contributing

This is a public repository. Contributions are welcome:

- **Fork** the repository and create a feature branch from the default
  branch.
- **Open a pull request** from your fork. PRs require a passing CI run,
  code-owner review (`@evoskamp`), and all review conversations
  resolved before they can merge.
- **File an issue** to report a bug or propose a change. Any logged-in
  GitHub user can open and comment on issues.

Outside contributors have read access: you can fork, open PRs from your
fork, and file/comment on issues. Push access, merging, and issue
triage are reserved for maintainers.
