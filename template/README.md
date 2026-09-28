# gh-repo-config sweeper

This repo is an org's sweeper repo for
[gh-repo-config](https://github.com/TheVoskamps/gh-repo-config): the one
private repo in the org whose scheduled `sweep` workflow runs the
converger against every managed repo in the org. It starts life as a
copy of the public template
`TheVoskamps/gh-repo-config-sweeper-template` and carries two files of
its own:

- `gh-repo-config.json` — the org's configuration. It is org-owned: the
  sweep reads it, and the converger never writes it.
- `bootstrap.sh` — places the sweep workflow once, so the first tick has
  something to run. It is bootstrap-only: once the first sweep has run,
  the converger owns `.github/workflows/sweep.yml`, and the script has
  nothing left to do.

## Operator steps

Run these once, as an org owner, in this order. `ORG` is your org's
login.

1. **Register the org's two GitHub Apps**, both owned by the org and
   installed on all of its repositories:
   - the converger App, which renders, opens, and merges the converger
     PRs, converges repo settings and the `protect-main` ruleset, and
     reads and writes the org custom properties;
   - the PR-automation App, which the rendered `auto-enable-automerge`
     and `auto-rebase-prs` workflows run as on every managed repo.

   Then name the PR-automation App in `gh-repo-config.json` under
   `pr-automation-identity` (see "Org config keys" below), and commit
   and push that change to the default branch.

2. **Set the secrets and the org custom properties.**
   - Org secrets `CONVERGER_APP_CLIENT_ID` and
     `CONVERGER_APP_PRIVATE_KEY`, in the Actions store, visible to this
     repo.
   - Org secrets `AUTOMERGE_APP_CLIENT_ID` and
     `AUTOMERGE_APP_PRIVATE_KEY`, visible to all repositories, in both
     the Actions and the Dependabot store.
   - Each `*_CLIENT_ID` secret holds the App's **Client ID** from its
     settings page, never its numeric App ID.
   - Org custom property `gh-repo-config-mode`: single-select over
     `opt-in` / `opt-out`, `required: true`, with a `default_value`.
     Set this repo's own value to `opt-in`: the sweep converges only
     managed repos, so an unmanaged sweeper repo never has its sweep
     workflow converged.
   - Org custom property `gh-repo-config-version`: a string.

3. **Run `bootstrap.sh`** from the root of a clean local clone of this
   repo, on the default branch, under your own `gh` authentication:

   ```bash
   ./bootstrap.sh
   ```

   It reads `version-pin`, downloads that converger release (the latest
   when no pin is set), verifies its build-provenance attestation before
   unpacking it, copies the release's sweep workflow to
   `.github/workflows/sweep.yml`, and commits and pushes that one file
   to the default branch. It registers no App and sets no secret.

4. **Trigger the first sweep**, as a dry run first:

   ```bash
   gh workflow run sweep.yml --repo "$ORG/gh-repo-config-sweeper" -f dry-run=true
   gh workflow run sweep.yml --repo "$ORG/gh-repo-config-sweeper"
   ```

   The dry run decides and logs which repos it would converge and stamps
   none. Read its log before dispatching the real run.

## Trust

TheVoskamps ships code. Your org owns every credential and all authority
over itself: both Apps are registered by and installed on your org, every
secret lives in your org, and nothing in the sweep holds a credential
TheVoskamps controls.

The trust that remains — that a converger release does what it should —
is narrowed three ways:

- **Attested immutable releases.** The sweep, and `bootstrap.sh`, run
  `gh attestation verify` against `TheVoskamps/gh-repo-config` on the
  release tarball before anything in it is unpacked or run.
- **An org-controlled version pin.** Once set, `version-pin` holds your
  org on a release you chose, and a new release reaches your org only
  when you move the pin, through a change to this repo.
- **The `manual` sweeper-update policy, by default.** A converger change
  to this repo's own sweep workflow, where the verify and the pin live,
  is held as a draft PR a human in your org must review and merge.

## Org config keys

`gh-repo-config.json` is one JSON object. The sweep fails the tick on a
malformed value, naming the key, and warns on a key it does not know.

### `sweeper-update-policy`

How this repo takes a converger change to its own
`.github/workflows/sweep.yml`. Absent means `manual`.

- `manual` — the change arrives as a draft PR, which the sweep never
  merges. Review it, mark it ready, and merge it in one sitting: every
  tick drafts it again.
- `auto` — the change merges like any other converger PR.
- `off` — the file is not converged at all.

```json
{
  "sweeper-update-policy": "manual"
}
```

### `version-pin`

The converger release to run, as its tag: `v` then `MAJOR.MINOR.PATCH`.
Absent means the latest release, resolved at each tick.

```json
{
  "version-pin": "v0.8.0"
}
```

### `pr-automation-identity`

Your org's PR-automation App. All four sub-keys are required together.
Absent means the identity TheVoskamps uses for its own org, whose App no
other org can install, so every other org sets it.

- `app-name` — the App's slug. The rendered PR-automation workflows run
  as it, and the sweep adds it as a bypass actor on each managed repo's
  `protect-main` ruleset.
- `app-client-id-secret` — the name of the org secret holding the App's
  Client ID.
- `app-private-key-secret` — the name of the org secret holding the
  App's private key.
- `bot-slug` — the git identity the rebase sweep commits as. It may
  carry the per-repo tokens `__GH_ORG__`, `__GH_REPO__`, and
  `__DEFAULT_BRANCH__`.

```json
{
  "pr-automation-identity": {
    "app-name": "acme-pr-automations",
    "app-client-id-secret": "AUTOMERGE_APP_CLIENT_ID",
    "app-private-key-secret": "AUTOMERGE_APP_PRIVATE_KEY",
    "bot-slug": "acme-pr-automations[bot]"
  }
}
```

### `named-dependabot-groups`

Dependabot groups rendered into every managed repo's
`.github/dependabot.yml`, each mapping a group name to a non-empty list
of dependency patterns. A group covers every update type, majors
included, and takes precedence over the per-ecosystem minor-and-patch
catch-all. When set, the map replaces the converger's built-in groups
entirely; `{}` renders no named groups.

```json
{
  "named-dependabot-groups": {
    "aws-cdk": ["aws-cdk", "aws-cdk-lib", "@aws-cdk/*", "constructs"],
    "codeql-action": ["github/codeql-action/*"]
  }
}
```

A config change reaches a repo only on a tick that converges it, and the
sweep skips every repo whose `gh-repo-config-version` stamp is already
at or past the running converger version. Moving the pin to a newer
release re-converges every managed repo; a change to any other key waits
for the next converger release, or for the affected repos'
`gh-repo-config-version` to be cleared.

## Schedule

The sweep runs hourly on weekdays from 12:00 through 20:00 UTC. The
schedule is org-wide and not locally editable: the sweep workflow is a
converge-and-overwrite payload, so every sweeper repo runs the same
`schedule:`. What happens to a local edit depends on
`sweeper-update-policy`:

- `auto` — the sweep's converger PR reverts it.
- `manual` — the sweep opens a held PR that reverts it, which a human
  in your org must merge.
- `off` — the file is not converged, and the local edit stays.

`gh workflow run sweep.yml` runs a tick outside the schedule under any
policy.

## Manual fallback

This repo has no link back to the template it was copied from, and the
converger updates only the files it renders. A structural change it
cannot express — a later revision of `bootstrap.sh` that only new
adopters need, say — is taken by hand, by merging the template in:

```bash
git remote add template https://github.com/TheVoskamps/gh-repo-config-sweeper-template.git
git fetch template
git merge --allow-unrelated-histories template/main
```

Resolve the conflicts in favour of your own `gh-repo-config.json`, then
push the merge through your usual review.
