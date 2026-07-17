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
properties because it converges repo protection settings, writes the
org `~ALL` ruleset, and reads/writes the three selection + stamp
custom properties. That elevated scope is precisely why it is a
**separate** App — the pr-automation App must never hold it. See
`docs/org-repo-configuration-fanout-decomposition.md` → "Converger
App — permission set".

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
