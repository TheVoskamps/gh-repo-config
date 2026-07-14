# Org-Wide Repo-Configuration Fan-Out — Design

Status: design, not yet implemented. Authored 2026-07-13.

Applies to three GitHub orgs, present and future:

- **Fablegate** (GitHub Team) — the immediate target.
- **TheVoskamps** (GitHub Team) — hosts the canonical converger repo.
- **StationWorks** (GitHub Enterprise Cloud, EMU, US data residency on a
  `ghe.com` tenant; three organizations). Applied later.

## Problem

Every repo across these orgs needs the same protections, PR automation,
Dependabot config, workflows, and branch-protection ruleset that the
Fablegate flagship repo has. Today this is applied by running two
interactive Claude Code skills (`gh-repo-setup-protection`,
`gh-repo-setup-pr-automation`, shipped in the `github-setup` plugin) one
repo at a time. Two pains:

1. **Fan-out cost** — running the skills ~N times by hand.
2. **Determinism** — the skills are English prose executed by a model,
   so the outcome is not guaranteed identical across runs/repos.

## Core decisions

### Skills are convergers, not scaffolders — a template repo is a downgrade

The two skills are already **idempotent convergence engines**: they
read-then-PATCH every remote setting, whole-file-replace rendered files,
and re-assert on every run. A GitHub **template repo** copies files once
at creation and never re-converges, so it is strictly worse than what
exists. It is not part of this design.

### Separate the deterministic core from the interactive shell

The determinism gap is narrow. The skills are already thin English
wrappers around deterministic payloads (`*.sh` scripts shipped verbatim,
`*.yml` templates with `__PLACEHOLDER__` substitution). The
non-deterministic surface is only **(a)** ecosystem/CodeQL detection and
**(b)** the GitHub API mutation sequence (GHAS toggles, ruleset, secrets).

Extract (a) + (b) into a **deterministic converger** (TypeScript, to
match the all-TS stack). Two entry points consume the *same* converger:

- The **interactive skill** — first-run authoring, the genuinely
  human-judgment parts (the ecosystem confirmation checklist, CodeQL
  on/off). It calls the converger for the mechanical work.
- The **CI fan-out workflow** — scheduled + on-repo-create, no model in
  the loop. It calls the converger directly.

Both paths run identical code, so CI and interactive runs cannot
diverge. This is the whole point.

### Canonical source: one public repo, consumed as an immutable release

The converger lives in **one public repo under TheVoskamps**, named
semantically: `gh-repo-config`. Own CODEOWNERS, locked to fork-and-PR
contribution, secured by this same fan-out.

Distribution is **not** by fork (forks pull the wrong way, drift
silently, and EMU cannot fork). Distribution is by **immutable GitHub
Release**:

- Publish the built converger as a release asset per tag.
- **Release immutability** (GA 2025-10-28) locks the assets and protects
  the tag. Enable it at repo creation, before the first relied-on
  release (it protects **new** releases only; existing releases stay
  mutable unless republished). Repo- or org-level setting.
- Each immutable release auto-generates a **Sigstore-format release
  attestation** (release tag + commit SHA + assets). This is the
  integrity mechanism — no hand-rolled `SHA256SUMS` file needed.

Consumers pin by tag and verify by attestation:

```bash
gh release download <tag> --repo TheVoskamps/gh-repo-config \
  --pattern '<asset>'
gh attestation verify <asset> --repo TheVoskamps/gh-repo-config
```

A public repo needs no special auth for release download — the
workflow's default `GITHUB_TOKEN` suffices.

### Self-currency

The converger, running in CI, reads its own repo's latest release; if the
running checkout is behind, it re-pulls at the newer tag before
converging targets. A stale scheduled run upgrades itself before acting.

### Version stamp: org custom properties, not a per-repo file

Each converger run stamps the target repo with the release version it
applied, via an **org custom property** (e.g.
`gh-repo-config-version`). The fan-out reads every repo's stamp
in one paginated call and re-converges any repo whose stamp is behind the
current release.

Custom properties beat a per-repo file: org-wide queryable in one call,
survive `.github/` churn, and can double as a ruleset targeting predicate.

Verified REST shape (available on **Team**):

- Define schema: `PUT /orgs/{org}/properties/schema/{name}` (or batch
  `PATCH /orgs/{org}/properties/schema`).
- Set values: `PATCH /orgs/{org}/properties/values` — **batch, up to 30
  repos per call** (there is no single-repo PUT). The fan-out stamps in
  batches.
- Read all: `GET /orgs/{org}/properties/values` (paginated).

### `protect-main` → org-level ruleset

`protect-main` is a solid ruleset that belongs on every repo, targeted at
`~ALL`. Move it to the org level:

- **New skill `gh-org-setup-protection-ruleset`** — creates/converges the
  ruleset once per org via `POST /orgs/{org}/rulesets`, targeting `~ALL`.
  `~ALL` targeting works on **Team**. (Custom-property *filter* targeting
  also appears available on Team per the docs, but `protect-main` uses
  `~ALL` regardless.)
- **Modify `gh-repo-setup-protection`** — detect an org-level ruleset
  covering the repo (`GET /repos/{org}/{repo}/rulesets`,
  `source_type: Organization`). When an org ruleset governs the repo,
  the repo skill **deletes** the now-redundant repo-level `protect-main`
  (`source_type: Repository`) copy and defers to the org ruleset. The
  per-repo ruleset path remains as the fallback for repos not covered by
  an org ruleset.

GHE/EMU migration is planned (import the org). Org rulesets and custom
properties are org-scoped objects that travel with the org on migration,
so building on them now is migration-safe.

### Community-health files → org `.github` repo

Create a **public** `<org>/.github` repo per org. It provides these files
as org-wide defaults, inherited by any repo lacking its own copy (nothing
is copied into the repo; GitHub falls back at display time):

- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- discussion category forms
- `FUNDING.yml`
- `GOVERNANCE.md`
- issue/PR templates + `config.yml`
- `SECURITY.md`
- `SUPPORT.md`

These come **out of the converger's scope** — they become org-inherited,
not rendered per repo.

**Not inherited** (and therefore still owned by the converger, per repo):
`dependabot.yml`, GitHub Actions workflow files, `CODEOWNERS`.
`workflow-templates/` in `<org>/.github` are adopt-only (a manual,
copy-on-adoption UI action) and are **not** used for the fan-out.

### Dependabot config stays per repo

The org `.github` repo does **not** inherit `dependabot.yml`. Each repo
needs its own file. The converger continues to render and converge a
per-repo `dependabot.yml` exactly as the protection skill does today. The
only org-level Dependabot lever is alert / security-update *enablement* (a
GHAS toggle), which is orthogonal to the config file.

## Distribution map

| Artifact | Home | Versioned by | Fan-out involvement |
| --- | --- | --- | --- |
| Converger (payloads + TS driver) | Public repo, TheVoskamps | Release tag | Source of truth; consumed as a release |
| Fan-out driver workflow | `<org>/.github`, scheduled + on-repo-create | — | Downloads converger release, runs it per repo |
| Community-health files | `<org>/.github` (public) | — | None — true inheritance |
| Workflows (auto-merge, rebase, gates, guard) | Rendered per repo by converger | Release tag (stamp) | The fan-out |
| `dependabot.yml` | Rendered per repo by converger | Release tag (stamp) | The fan-out |
| Repo API settings (GHAS, merge button) | PATCHed per repo by converger | Release tag (stamp) | The fan-out |
| `protect-main` | Org ruleset, `~ALL` | — | Set once per org |
| Version stamp | Org custom property | Release tag | Fan-out reads all, re-converges stale |
| App identity secret | Org secret (already set) | — | None |

## EMU / StationWorks notes

- **EMU can consume public releases.** Managed users have "read-only
  access to the wider GitHub community" and "can view all public
  repositories, but cannot interact with repositories outside of the
  enterprise" (the restrictions are push/PR/issue/star/**fork**).
  "Cannot create public content" does not mean cannot consume. So a
  StationWorks EMU Actions runner can download a public release asset
  from TheVoskamps' public converger repo.
- **EMU cannot fork** — which independently rules out the
  fork-into-each-org distribution model and confirms download-the-release
  as the only viable path.
- **Corporate-proxy egress restriction** (enterprise access restrictions,
  GA 2025-09-15) is an opt-in admin control that can block public
  github.com. StationWorks is administered by us and this restriction is
  not a concern for this design.

## Open items

- Extraction boundary: which converger to extract first
  (`pr-automation` is smaller; `protection` is the larger, higher-value
  one), and exactly which SKILL.md prose steps become the deterministic
  TS core vs. stay in the interactive skill.
- Stamp granularity: one stamp per release, or per-concern
  (`protection` / `pr-automation`) if the concerns will ever version
  independently.

## Sources

- [Immutable releases are now generally available](https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/)
- [Immutable releases — GitHub Docs](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Abilities and restrictions of managed user accounts](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/understanding-iam-for-enterprises/abilities-and-restrictions-of-managed-user-accounts)
- [Enterprise access restrictions with corporate proxies (GA)](https://github.blog/changelog/2025-09-15-enterprise-access-restrictions-with-corporate-proxies-is-now-generally-available/)
- [Custom properties — REST API](https://docs.github.com/en/rest/orgs/custom-properties)
- [Creating rulesets for repositories in your organization](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization)
- [Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
