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

The App ID and private key are stored as `organization` secrets
(visible to all repositories, matching the `AUTOMERGE_*` pair):

| Secret | Holds |
| --- | --- |
| `CONVERGER_APP_ID` | the numeric App ID (`4319606`) |
| `CONVERGER_APP_PRIVATE_KEY` | the App's PEM private key |

The private key is never committed to the repo and never printed to
logs. To rotate it, generate a new private key in the App's settings,
update the `CONVERGER_APP_PRIVATE_KEY` secret, then delete the old
key in the App settings.

## Using the App in a workflow

Mint an installation token at the start of the job and pass it to
downstream steps. See `.github/workflows/sweep.yml` for the live
usage; the canonical snippet is:

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
