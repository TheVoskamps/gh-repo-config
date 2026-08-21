# GitHub App: `thevoskamps-repo-config-converger`

This repo authenticates selected GitHub Actions workflows as the
GitHub App **`thevoskamps-repo-config-converger`** rather than the default `GITHUB_TOKEN`.
A short-lived installation token is minted per workflow run from the
App ID and private key stored in secrets; there is no long-lived token
to rotate manually.

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

## Granted permissions

The App was registered with these permissions:
`Administration: write, Contents: write, Pull requests: write, Workflows: write, Code scanning alerts (security events): write, Organization administration: write, Organization custom properties: write, Metadata: read`.

This set is deliberately broader than the pr-automation App
(`thevoskamps-pr-automations`), which holds only Contents / Pull
requests / Workflows / Actions. The converger additionally holds
Administration, Organization administration, and Organization custom
properties, each for its own reason: Administration to converge repo
protection settings and each managed repo's own `protect-main` ruleset;
Organization administration for the `GET /orgs/{org}/installations`
call in `src/github/rulesets.ts` (`readAppIdsBySlug`), which resolves an
App slug to the `app_id` every `protect-main` bypass-actor entry is
written with — an org-owner-only endpoint, and the converger's only
call that needs org-administration scope; Organization
custom properties to read the selection property `gh-repo-config-mode`
(both its schema `default_value` and every repo's own value) and to read
and write the `gh-repo-config-version` stamp — write is needed for the
stamp alone, since the converger never writes a repo's mode. See
`docs/repo-selection.md`. The
org-level `~ALL` ruleset the design moves `protect-main` to is not
built: every ruleset endpoint `src/github/rulesets.ts` calls is
repo-scoped, under `/repos/{o}/{r}/rulesets`, and that installations
call is the only org-level one it makes — a read that writes nothing.
That elevated scope is precisely why it is a
**separate** App — the pr-automation App must never hold it. See
`docs/org-repo-configuration-fanout-decomposition.md` → "Converger
App — permission set".

The pull-request surface the converger drives is not all REST: it also
issues two GraphQL calls, the `convertPullRequestToDraft` and
`markPullRequestReadyForReview` mutations, issued by `ContentsClient`
(`src/github/contents.ts`) and driven by `src/converge/writer.ts` to
hold the sweeper repo's trust-anchor PR as a draft under
`sweeper-update-policy: manual`, and to release that hold under `auto`.
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

## Secrets

The App's identifiers and private key are stored as `organization`
secrets (visible to all repositories, matching the `AUTOMERGE_*` pair):

| Secret | Holds | Read by |
| --- | --- | --- |
| `CONVERGER_APP_ID` | the numeric App ID (`4319606`) | this repo's own `.github/workflows/sweep.yml` |
| `CONVERGER_APP_CLIENT_ID` | the App's Client ID | the fanned-out sweeper workflow |
| `CONVERGER_APP_PRIVATE_KEY` | the App's PEM private key | both |

Two identifier secrets exist because the two workflows that mint a
token feed different inputs of `actions/create-github-app-token`. This
repo's own `.github/workflows/sweep.yml` uses `app-id:`. The
fanned-out sweeper workflow (`assets/sweeper-sweep.yml`, rendered to
`.github/workflows/sweep.yml` on an org's sweeper repo) uses
`client-id:`, because upstream carries a `deprecationMessage` on
`app-id:` and a workflow shipped org-wide must not be born deprecated.

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
downstream steps. The snippet below mirrors this repo's own
`.github/workflows/sweep.yml`, which still feeds `app-id:`. A workflow
written now should feed `client-id:` from `CONVERGER_APP_CLIENT_ID`
instead — upstream carries a `deprecationMessage` on `app-id:`, so it
warns on every run — as `assets/sweeper-sweep.yml` does:

```yaml
    steps:
      - name: Mint App installation token
        id: app-token
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          app-id: ${{ secrets.CONVERGER_APP_ID }}
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
