# gh-repo-config

Org-wide repo-configuration converger. TypeScript, Node >=22, ESM
(`"type": "module"`). See `docs/org-repo-configuration-fanout-design.md`
and `docs/org-repo-configuration-fanout-decomposition.md` for the
overall design and issue breakdown.

## Commands

Install (deterministic, from lockfile):

```bash
npm ci
```

Build (TypeScript → `dist/`):

```bash
npm run build
```

Test (runs compiled output under `dist/`, so build first):

```bash
npm run build && npm test
```

## Structure

- `src/` — TypeScript source, compiled to `dist/` by `npm run build`.
  `dist/` is gitignored; tests and `bin/gh-repo-config.js` import from
  `dist/`, not `src/`.
  - `src/config/selection.ts` — managed-or-not precedence over the
    `gh-repo-config-mode` / `gh-repo-config-default` custom properties.
  - `src/version-compare.ts` — `isBehind`, the version-skip check
    against `gh-repo-config-version`.
  - `src/stamp/decide.ts` — combines selection + version-skip into a
    single per-repo verdict (`skip-unmanaged` / `skip-current` /
    `converge`).
  - `src/github/properties.ts` — dependency-free `fetch`-based REST
    client for the three org custom properties (paginated read,
    batched ≤30 stamp write).
  - `src/github/merge.ts` — `MergeClient`, same dependency-free-`fetch`
    shape as `properties.ts`. Lists the converger App's own open PRs on
    a repo, resolves required checks via the rules API
    (`GET /repos/{o}/{r}/rules/branches/{branch}`, not legacy branch
    protection), and REST-merges (merge-commit only) whichever are
    green. A 405/409 from the merge call itself is `awaiting-retry`,
    not a failure.
  - `src/github/contents.ts` — `ContentsClient`, same dependency-free-
    `fetch` shape as `properties.ts` / `merge.ts`. The converger's
    file-write path: reads a target repo's default branch and current
    file state, then commits changed files via the **git-data API**
    (blobs → tree → commit → ref) so scripts land mode `100755` (the
    contents API cannot set the executable bit), and opens or updates a
    single PR to the default branch.
  - `src/github/settings.ts` — `RepoSettingsClient`, same dependency-
    free-`fetch` shape as the other `src/github/` clients. The converger's
    pure-API-mutation path (issue #15, no files, no PR): read-then-PATCH
    for Dependabot alerts/security-updates enablement, secret scanning +
    push protection (+ best-effort delegated-bypass lockdown — no stable
    per-repo read exists for that one sub-key, so it's always attempted),
    and the merge-button/PR-hygiene settings.
  - `src/converge/` — the file-render + write pipeline (issue #14) every
    later file-rendering slice (#17, #18, #25) reuses.
    - `assets.ts` — locates the `assets/` templates relative to the
      built module (`import.meta.url`), not `process.cwd()`, so they
      resolve in an unpacked release.
    - `render.ts` — `__PLACEHOLDER__` substitution
      (`__GH_ORG__`/`__GH_REPO__`/`__DEFAULT_BRANCH__`), the unresolved-
      token assertion (rendered templates only, never verbatim scripts),
      and the composite `dependabot.yml` `__DEPENDABOT_ECOSYSTEMS__`
      expansion (one `ecosystem-block.yml` copy per armed ecosystem,
      variant parts resolved per ecosystem class — the resolution spec
      lives in the `github-setup` plugin's `gh-repo-setup-protection`
      SKILL.md Step 3).
    - `files.ts` — the payload set: which asset renders/ships to which
      target path (`.github/dependabot.yml`, `.github/workflows/*.yml`
      rendered; `.github/scripts/*.sh` verbatim + executable).
    - `writer.ts` — `convergeRepoFiles`: whole-file compare (a right-
      content-wrong-mode script counts as differing), commit changed
      files onto the fixed `gh-repo-config/converge` branch, open/update
      one PR per repo. No diff → no branch, no PR. Never pushes to the
      default branch; merging the PR is issue #24's job.
    - `ghas.ts` — `convergeGhasSettings` (issue #15): read-then-write
      each GHAS/repo-security toggle and merge-button setting
      independently — one setting's failure (report-and-skip on a 422
      entitlement error) never blocks the rest. Only an unexpected
      (non-422) write failure throws, which the sweep records as that
      repo's `failed` outcome.
  - `src/sweep.ts` — `runSweep` / `runSweepFromEnv`, the sweep's
    orchestration. `runSweep`'s `converge` (files, #14) and `convergeGhas`
    (settings, #15) steps both stay injectable stubs (tests supply their
    own); `runSweepFromEnv` wires the real `convergeRepoFiles` and
    `convergeGhasSettings` in production. The two run independently per
    repo (one's failure doesn't skip the other, but either failure marks
    the repo `failed` and skips stamping). The merge pass (issue #24) runs
    independently of the version-skip decision, over every repo the
    properties API returns, so an unmerged converger PR from a prior
    tick still gets picked up.
- `assets/` — the template payloads the converger renders (extracted
  verbatim from the `github-setup` plugin's
  `gh-repo-setup-protection` payload): the `dependabot.yml` +
  `ecosystem-block.yml` templates, the gate/guard `.yml` workflows,
  and the `.sh` scripts (shipped verbatim + executable). Packed into
  the release tarball (`.github/workflows/release.yml`) alongside
  `dist`/`bin`/`package.json`.
- `bin/gh-repo-config.js` — CLI entry point (`package.json` `bin`).
  Subcommands: `version` (default) and `sweep` (reads
  `GH_REPO_CONFIG_ORG` / `GH_REPO_CONFIG_TOKEN` /
  `GH_REPO_CONFIG_APP_SLUG` / optional `GH_REPO_CONFIG_DRY_RUN` from
  the environment; exits non-zero when any repo's convergence or stamp
  write failed, so a scheduled sweep run cannot fail silently).
- `test/` — `node:test` files, run via `node --test test/**/*.test.js`.
- `.github/workflows/release.yml` — publishes a tagged (`v*`) immutable
  GitHub Release with a build-provenance attestation. Bumping the
  release version means editing `package.json`'s `version` and pushing
  a matching `vX.Y.Z` tag; the workflow verifies the two match before
  building.
- `.github/workflows/sweep.yml` — scheduled (daily) + `workflow_dispatch`
  sweep. Runs as a dedicated converger org GitHub App (org secrets
  `CONVERGER_APP_ID` / `CONVERGER_APP_PRIVATE_KEY`), distinct from the
  pr-automation App, since it needs Administration / Org administration
  scope the pr-automation App must never hold. Requires
  three org-level custom properties to be defined
  (`gh-repo-config-mode`, `gh-repo-config-default`,
  `gh-repo-config-version`) — an operator-provisioning step, not
  something the workflow itself creates. Also passes
  `GH_REPO_CONFIG_APP_SLUG` (read from the token-mint step's own
  `app-slug` output, not a separate secret) so the merge pass can
  match `user.login === "<slug>[bot]"` and never merge a PR authored
  by anyone else.

## Conventions

- Doc comments (TSDoc) on exported symbols explain contracts and *why*,
  not what's evident from the signature.
- GitHub Actions steps in `.github/workflows/` pin third-party actions
  by commit SHA (with a version comment), not by tag.
