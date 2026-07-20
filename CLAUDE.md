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
    file-rendering slice reuses (issue #16 already does; #25 next).
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
      target path. Rendered workflows land under `.github/workflows/`;
      a rendered non-workflow config (the CodeQL config) lands at a
      fixed bespoke path (`.github/codeql/codeql-config.yml`, the path
      the CodeQL workflow's `config-file:` line references); verbatim
      scripts ship byte-for-byte and executable under
      `.github/scripts/`.
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
    - `default-setup.ts` — `convergeDefaultSetup` (issue #16): pure API
      mutation, no files, no PR. Drives server-side CodeQL default setup
      to `not-configured` on every managed repo, since a live default
      setup and the converger's advanced CodeQL workflow are mutually
      exclusive. Read-then-PATCH-on-diff; a 403/404 (feature/plan
      unavailable) is report-and-skip, not a failure.
    - `ruleset.ts` — `convergeProtectMainRuleset` (issue #16): pure API
      mutation, no files, no PR. Creates/converges the repo-level
      `protect-main` ruleset from `assets/protect-main-ruleset.json`,
      unioning in App bypass actors (converger + AUTOMERGE, each
      resolved to an `app_id` at sweep time — an uninstalled App's
      entry is omitted and reported, never a failure) onto the existing
      bypass list (never dropping an operator's own bypasses). When an
      active org-level ruleset already governs the default branch, the
      repo-level copy is deleted and convergence is deferred
      (`org-governed`), not asserted redundantly. A `code_quality` 422
      (limited availability) is retried once with that rule dropped.
      Semantic (not literal), canonical-authoritative compare decides
      whether a write is needed: `ref_name.include` superset-ok on
      `~DEFAULT_BRANCH` or the concrete ref, required-check contexts
      compared by name only (ignoring `integration_id`), bypass actors
      by set-containment (the one deliberate preservation surface —
      an operator's extra bypass actors are never drift), and every
      other field — including rule parameters (`pull_request`,
      `required_status_checks`'s non-list parameters, `code_scanning`'s
      tool list, `code_quality`'s severity when both sides carry the
      rule) and `ref_name.exclude` — compared directly against the
      canonical asset; any difference is drift corrected by the PUT.
      The rule-parameter compare is one-directional over the canonical
      key set (iterates the desired rule's own parameter keys), plus a
      separate detect-and-surface pass over the *existing* rule's keys:
      a server-side parameter key the canonical asset doesn't carry at
      all (e.g. a future GitHub-added default) is reported in
      `RulesetConvergeResult.unknownParams` — an operator action cue to
      update the asset and bump the converger's version — but is never
      itself drift, since the canonical PUT could never set a key it
      doesn't model; treating it as drift would just churn every tick
      with no way to converge.
  - `src/sweep.ts` — `runSweep` / `runSweepFromEnv`, the sweep's
    orchestration. `runSweep`'s `converge` (files, #14), `convergeGhas`
    (settings, #15), and `convergeDefaultSetup` (#16) steps all stay
    injectable stubs (tests supply their own) and run independently per
    repo in the same per-repo pass — one step's failure doesn't skip the
    others, but any failure marks the repo `failed` and skips stamping.
    `runSweepFromEnv` wires the real implementations in production. The
    merge pass (issue #24) runs independently of the version-skip
    decision, over every repo the properties API returns, so an
    unmerged converger PR from a prior tick still gets picked up.
    The `convergeRuleset` step (issue #16) runs in a separate pass
    **after** the merge pass, gated by an ordering rule: for a given
    repo, the ruleset is asserted only once that repo's file
    convergence has reached the default branch this tick (file
    convergence was a no-op, or its converger PR merged in the merge
    pass this tick). A repo whose file PR is still open is deferred
    (`SweepReport.rulesetDeferred`) and **not stamped** this tick — the
    next tick retries. This is the #91/#230 phantom-check guard: never
    require a status-check context whose producing workflow isn't yet
    on the target's default branch. The gate applies only when a
    `convergeRuleset` step is injected; omitting it (as in tests that
    don't exercise ruleset behavior) reproduces pre-#16 stamping,
    gated on the file/GHAS/default-setup steps alone.
- `assets/` — the template payloads the converger renders, sourced from
  the `github-setup` plugin's `gh-repo-setup-protection` payload
  (authoritative shape defined in that plugin's SKILL.md — see
  "Authority" in issue #16): the `dependabot.yml` + `ecosystem-block.yml`
  templates, the gate/guard `.yml` workflows, the CodeQL payload set
  (`codeql.yml` workflow, `codeql-config.yml`, `codeql-language-
  present.sh` runtime language-detection script + its
  `test-codeql-language-present.sh` self-test), the
  `protect-main-ruleset.json` ruleset body template, and the `.sh`
  scripts (shipped verbatim + executable). "Verbatim" here means byte-
  identical to the upstream payload at the time of extraction — not
  independently re-verifiable from this repo, since the upstream
  plugin's payload files (as opposed to its `SKILL.md`) are not present
  in a local plugin cache to diff against. The shipped
  `test-codeql-language-present.sh` self-test is the one piece of
  after-the-fact verification available for the CodeQL detection script;
  it does not by itself confirm byte-identity with upstream. Packed into
  the release tarball (`.github/workflows/release.yml`) alongside
  `dist`/`bin`/`package.json`.
- `bin/gh-repo-config.js` — CLI entry point (`package.json` `bin`).
  Subcommands: `version` (default) and `sweep` (reads
  `GH_REPO_CONFIG_ORG` / `GH_REPO_CONFIG_TOKEN` /
  `GH_REPO_CONFIG_APP_SLUG` / optional `GH_REPO_CONFIG_DRY_RUN` from
  the environment; exits non-zero when any repo's convergence or stamp
  write failed, so a scheduled sweep run cannot fail silently). The
  sweep summary also prints each repo's CodeQL default-setup and
  `protect-main` ruleset outcomes, plus any ruleset-deferred repos
  (issue #16).
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
