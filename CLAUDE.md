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
  - `src/sweep.ts` — `runSweep` / `runSweepFromEnv`, the sweep's
    orchestration. Convergence is currently an injectable no-op stub;
    later slices (#14-#18) replace it with the real converger. The
    merge pass (issue #24) runs independently of the version-skip
    decision, over every repo the properties API returns, so an
    unmerged converger PR from a prior tick still gets picked up.
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
  pr-automation App, since later slices need Administration / Org
  administration scope the pr-automation App must never hold. Requires
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
