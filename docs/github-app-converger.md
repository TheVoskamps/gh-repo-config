# GitHub App: `thevoskamps-repo-config-converger`

This repo authenticates selected GitHub Actions workflows as the
GitHub App **`thevoskamps-repo-config-converger`** rather than the default `GITHUB_TOKEN`.
A short-lived installation token is minted per workflow run from the
Client ID and private key stored in secrets; there is no long-lived
token to rotate manually.

This document is the checked-in record of that App. It is maintained
by the `/gh-create-app` skill — re-run the skill to verify or update
it.

## Identity

| Field | Value |
| --- | --- |
| App name (slug) | `thevoskamps-repo-config-converger` |
| App ID | `4319606` |
| Owner | `TheVoskamps` |
| Scope | `organization` |
| Settings / install URL | `https://github.com/organizations/TheVoskamps/settings/apps/thevoskamps-repo-config-converger` |
| Recorded | `2026-07-16` |

## Permissions

### Required by the sweep

The sweep requires these of the App's installation, each at the
highest level any endpoint called from `src/github/*.ts` needs it. This
is the set `CONVERGER_REQUIRED_PERMISSIONS` in `src/github/preflight.ts`
holds, and the converger preflight below refuses to let the sweep run
against an installation granting less. The last column is the map's
own attribution of calls to permissions, not a citation of GitHub's
reference pages.

| Settings-page section | Permission | Level | Calls the map attributes to it |
| --- | --- | --- | --- |
| Repository | Metadata | Read-only | `GET /repos/{o}/{r}`, `GET …/rules/branches/{b}`, `GET …/rulesets` |
| Repository | Contents | Read and write | the git-data writes (blobs, trees, commits, refs) and `PUT …/pulls/{n}/merge` |
| Repository | Workflows | Read and write | creating or moving a ref onto a commit that touches `.github/workflows/` |
| Repository | Pull requests | Read and write | `POST …/pulls` and the GraphQL draft / ready-for-review mutations |
| Repository | Checks | Read-only | `GET …/commits/{ref}/check-runs` |
| Repository | Commit statuses | Read-only | `GET …/commits/{ref}/status` |
| Repository | Administration | Read and write | `PATCH /repos/{o}/{r}`, the ruleset writes, vulnerability alerts, automated security fixes, and code-scanning default setup |
| Organization | Administration | Read-only | `GET /orgs/{org}/installations` |
| Organization | Custom properties | Read and write | `PATCH /orgs/{org}/properties/values` |

A granted level above the required one satisfies it, and a grant the
map does not name the preflight ignores.

### Registered

The App was registered with these permissions:
`Administration: write, Contents: write, Pull requests: write, Workflows: write, Code scanning alerts (security events): write, Organization administration: write, Organization custom properties: write, Metadata: read`.
That record names neither Checks nor Commit statuses. What the
installation grants today is what the preflight reads, so a shortfall
surfaces there, on every run, rather than in this file.

The converger holds Administration, Organization administration, and
Organization custom properties, which the PR-automation App
(`thevoskamps-pr-automations`) never does, each for its own reason:
Administration to converge repo protection settings and each managed
repo's own `protect-main` ruleset; Organization administration for the
`GET /orgs/{org}/installations` call in `src/github/rulesets.ts`
(`readInstallationsBySlug`), which reads every App installed on the
org, keyed by slug, with its `app_id` — what every `protect-main`
bypass-actor entry is written with — and its granted permissions —
what the PR-automation preflight below checks; an org-owner-only
endpoint, and the converger's only call that needs org-administration
scope; Organization custom properties to read the selection property
`gh-repo-config-mode` (both its schema `default_value` and every repo's
own value) and to read and write the `gh-repo-config-version` stamp —
write is needed for the stamp alone, since the converger never writes a
repo's mode. See `docs/repo-selection.md`. The org-level `~ALL` ruleset
the design moves `protect-main` to is not built: every ruleset endpoint
`src/github/rulesets.ts` calls is repo-scoped, under
`/repos/{o}/{r}/rulesets`, and that installations call is the only
org-level one it makes — a read that writes nothing. That elevated
scope is precisely why it is a **separate** App — the PR-automation App
must never hold it. See
`docs/org-repo-configuration-fanout-decomposition.md`.

The pull-request surface the converger drives is not all REST: it also
issues two GraphQL calls, the `convertPullRequestToDraft` and
`markPullRequestReadyForReview` mutations, issued by `ContentsClient`
(`src/github/contents.ts`) and driven by `src/converge/writer.ts` to
hold the sweeper repo's trust-anchor PR as a draft under
`sweeper-update-policy: manual`, and to release that hold under a
policy that no longer reserves that path — `auto` or `off`.
There is no REST equivalent — `draft` is writable on the create call
only. Narrowing whatever permission those mutations need would leave
them failing: the trust-anchor hold would rest on the merge pass alone,
which does not bind GitHub-native auto-merge, and a hold placed under
`manual` could never be released.

A sentence added here of the form "GitHub gates `<endpoint>` on
`<permission>`" stands only after that endpoint's own REST reference
page is fetched and seen to state the mapping. Many pages state only
the classic-PAT / OAuth scope and the account role required — the
installations call above documents `admin:read` and organization
ownership, and names no fine-grained or App permission at all — so the
mapping is unstated upstream and the sentence would be a training-data
prior dressed as a citation, in the one document whose whole purpose is
to record why each scope is held. Write what the page does say, plus
what this repo can prove about which calls need the scope, and leave
the exact permission mapping unasserted.

No webhook is configured: this App is used only for minting
installation tokens in CI, not for receiving event deliveries.

## Preflights

An App's permissions are UI-gated: no API writes them, so the sweep
cannot converge a shortfall and instead checks for one before it reads
any repo. Without that check a missing converger permission surfaces as
a per-repo `403` part-way through a sweep that has already opened PRs
and converged settings on other repos, and a missing PR-automation
permission surfaces nowhere: an App lacking `issues: write` merges a PR
carrying a closing keyword and leaves the linked issue open, with
nothing failed and nothing logged. Each App gets its own preflight, and
a shortfall in either stops the whole run.

### The converger App

The sweeper workflow's "Check converger App permissions" step runs
`gh-repo-config.js preflight` between "Mint converger App installation
token" and "Run sweep". `GET /app/installations/{installation_id}`
accepts only an App JWT, never an installation token, so this step and
the mint are the only two that receive `CONVERGER_APP_PRIVATE_KEY`: the
step signs an RS256 JWT with `node:crypto`, `CONVERGER_APP_CLIENT_ID`
as its `iss`, makes that one call, and compares the response's
`permissions` map against the required set above. Its other inputs are
the org and the mint step's `app-slug` and `installation-id` outputs,
passed as `GH_REPO_CONFIG_ORG`, `GH_REPO_CONFIG_APP_SLUG`,
`GH_REPO_CONFIG_INSTALLATION_ID`, `GH_REPO_CONFIG_APP_CLIENT_ID` and
`GH_REPO_CONFIG_APP_PRIVATE_KEY`.

On a shortfall the step exits non-zero and the job stops before "Run
sweep": no repo is read, no PR opened, no setting changed, nothing
stamped. Its stderr names each missing permission as the settings page
words it, such as
`Repository permissions > Commit statuses: Read-only (needs Read-only, granted none)`,
gives the App's permissions settings URL, and says that after granting,
an org owner must accept the updated permissions on the installation —
until then the minted token keeps the old grant and the step keeps
failing. With no shortfall it exits zero and writes nothing to stderr.
A read that fails outright — a bad key, a non-2xx response — fails the
step with the status and GitHub's message.

### The PR-automation App

The sweep itself preflights the App the fanned-out
`auto-enable-automerge` and `auto-rebase-prs` workflows run as, the one
`pr-automation-identity` names, `thevoskamps-pr-automations` by default.
`runSweepFromEnv` reads the org's installations once and, before
converging any repo and under a dry run too, throws when that App is
not installed on the org or its installation lacks any of
`PR_AUTOMATION_REQUIRED_PERMISSIONS` in
`src/converge/app-permissions.ts`: Actions read, Checks read, Contents
write, Issues write, Metadata read, Pull requests write. The CLI prints
the error as `Sweep failed: …`; a missing-permission message names the
org, the slug and each shortfall as `<name>: <granted or none> (need
<required>)`, that App permissions change only through the GitHub web
UI, and that the org owner must accept the updated permissions on the
installation before they take effect. The same installations map
supplies the `protect-main` bypass actors, so a sweep still makes one
installations call, and an App that map lacks by then can only be the
converger App, whose bypass entry is omitted and reported rather than
failed.

Not installed is fatal for this App where it is tolerated for the
converger: the converger fans the PR-automation workflows out to every
managed repo unconditionally, so an org without the App is misconfigured
by construction, its auto-merge jobs would go red on every managed
repo's Actions tab rather than in the sweep's output, and omitting it
from `protect-main`'s bypass actors would converge a ruleset that blocks
the automation once the App is installed. The preflight sees org
installations only, so an App installed on a selected repository set
that omits a managed repo passes it.

Both preflights take their granted-versus-required verdict from the
same comparison, `findMissingPermissions`, which orders levels
`read < write < admin`, reports an absent key as granted `none`, and
never lets an unrecognized level satisfy anything.

## Secrets

The App's identifiers and private key are stored as `organization`
secrets (visible to all repositories, matching the `AUTOMERGE_*` pair):

| Secret | Holds | Read by |
| --- | --- | --- |
| `CONVERGER_APP_CLIENT_ID` | the App's Client ID | the sweeper workflow's token mint and permission preflight |
| `CONVERGER_APP_PRIVATE_KEY` | the App's PEM private key | the same two steps, and no other |

The fanned-out sweeper workflow (`assets/sweeper-sweep.yml`, rendered
to `.github/workflows/sweep.yml` on an org's sweeper repo) is the one
workflow that reads these secrets; this repo runs no sweep of its own.
Its mint feeds the Client ID to the `client-id:` input of
`actions/create-github-app-token`, and its preflight step signs an App
JWT from the same two secrets. Upstream carries a `deprecationMessage`
on the `app-id:` input `client-id:` replaced, so no mint feeds it. The
numeric App ID is therefore not read by any workflow; deleting the
`CONVERGER_APP_ID` org secret that used to hold it is an operator
action.

The Client ID is a distinct value from the numeric App ID and is not
derivable from it: read it off the App's settings page and set the
secret by hand. An org standing up a sweeper repo must have
`CONVERGER_APP_CLIENT_ID` and `CONVERGER_APP_PRIVATE_KEY` present in
its own org secrets, under those names, before the sweeper workflow's
first run — the workflow provisions neither.

The private key is never committed to the repo and never printed to
logs. To rotate it, generate a new private key in the App's settings,
update the `CONVERGER_APP_PRIVATE_KEY` secret, then delete the old
key in the App settings.

## Using the App in a workflow

Mint an installation token at the start of the job and pass it to
downstream steps. The snippet below mirrors the sweeper workflow's mint
step. Feed `client-id:` from
`CONVERGER_APP_CLIENT_ID`, never the `app-id:` input it replaced —
upstream carries a `deprecationMessage` on `app-id:`, so it warns on
every run:

```yaml
    steps:
      - name: Mint App installation token
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ secrets.CONVERGER_APP_CLIENT_ID }}
          private-key: ${{ secrets.CONVERGER_APP_PRIVATE_KEY }}
      - name: Do privileged work as the App
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
        run: gh api /repos/${{ github.repository }} --jq .full_name
```

The minted token authorises only the permissions granted to the App
above, and expires within the hour. The `permissions:` block of the
workflow governs the default `GITHUB_TOKEN` only; it does not affect
the App installation token.
