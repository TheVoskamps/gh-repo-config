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

Lint Markdown (all tracked `.md` files, config in `.markdownlint.jsonc`).
`lint:md`'s glob (`**/*.md`, excluding only `node_modules` and `dist`)
covers `.claude/agent-memory/**/*.md` too, and `MD041` (first-line
heading) stays live there — any new agent-memory entry file (which
opens with YAML front matter, not a heading) needs a `# H1` as its
first content line after the front matter, or `lint:md` fails on it.
`MEMORY.md` index files are unaffected since they already open with a
heading.

```bash
npm run lint:md
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
    pure-API-mutation path (no files, no PR): read-then-PATCH
    for Dependabot alerts/security-updates enablement, secret scanning +
    push protection (+ best-effort delegated-bypass lockdown — no stable
    per-repo read exists for that one sub-key, so it's always attempted),
    and the merge-button/PR-hygiene settings.
  - `src/converge/` — the file-render + write pipeline every
    file-rendering slice reuses.
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
      SKILL.md Step 3). Each ecosystem block also carries
      `NAMED_DEPENDABOT_GROUPS`: ONE canonical union of the
      org's lockstep/stack Dependabot groups (`codeql-action`, `aws-cdk`,
      `vite-toolchain`, `fastapi-stack`, `sqlalchemy-stack`, `auth-stack`,
      `aws-sdk`, `test-stack`), rendered identically into every armed
      ecosystem — not scoped per ecosystem, per the same
      arm-everything-unconditionally/repo-identity principle
      `DEPENDABOT_ECOSYSTEMS` itself follows. A group whose patterns
      match nothing in a given ecosystem is inert there. Definitions and
      precedence (named groups listed before each ecosystem's
      `*-minor-and-patch` catch-all, so a dependency matching both lands
      in the named group) are org-wide constants covering the org's
      lockstep/stack dependency groupings. `renderPrAutomationTemplate` +
      `PR_AUTOMATION_CONSTANTS` render the PR-automation
      workflows' extra placeholders: nine fixed org-level constants
      (App identity, merge method, do-not-merge label, required-check/
      install-gate workflow names) plus the per-repo-but-derived
      `__BOT_SLUG__` (`<repo>-auto-rebase[bot]`), layered on top of the
      same three per-repo tokens `renderTemplate` already resolves. The
      full surface always renders unconditionally (no conditional-drop
      logic like the interactive `gh-repo-setup-pr-automation` skill has
      for repos lacking certain workflows) — on a managed repo the gates
      and guards are guaranteed present in the same per-repo converger
      PR, so every placeholder always resolves.
    - `files.ts` — the payload set: which asset renders/ships to which
      target path. Rendered workflows land under `.github/workflows/`,
      including the PR-automation workflows, rendered via
      `renderPrAutomationTemplate` rather than the plain three-token
      `renderTemplate`; a rendered non-workflow config (the CodeQL
      config) lands at a fixed bespoke path
      (`.github/codeql/codeql-config.yml`, the path the CodeQL
      workflow's `config-file:` line references); the `VERBATIM_AT_PATH`
      list ships an unrendered `.yml` at a fixed bespoke path (the
      `codeartifact-auth` composite action at
      `.github/actions/codeartifact-auth/action.yml`, the directory its
      `uses: ./.github/actions/codeartifact-auth` callers reference —
      stored flat in `assets/` as `codeartifact-auth-action.yml`, and
      deliberately not routed through the render path because it carries
      nothing per-repo); verbatim scripts ship
      byte-for-byte and executable under `.github/scripts/`. The
      `COMMUNITY_FILES` list ships verbatim, non-executable
      community/governance files (`CONTRIBUTORS`, `LICENSE`, `PATENTS`,
      `PRIOR_ART.md`) at repo root; these are the one payload kind that
      is **seed-if-absent** rather than converge-and-overwrite, flagged
      by the optional `honoredLocations` field on `DesiredFile` —
      present only on `COMMUNITY_FILES` entries, absent (and therefore
      always converge-and-overwrite) on every other payload.
    - `writer.ts` — `convergeRepoFiles`: whole-file compare (a right-
      content-wrong-mode script counts as differing), commit changed
      files onto the fixed `gh-repo-config/converge` branch, open/update
      one PR per repo. No diff → no branch, no PR. Never pushes to the
      default branch directly; the merge pass merges the PR once its
      required checks are green. A `DesiredFile` carrying
      `honoredLocations` is skipped entirely — never compared for
      drift, never overwritten — once the target repo has its own copy
      at the file's own path or at any of `honoredLocations` (repo
      root, `.github/`, `docs/` for the current community files).
    - `ghas.ts` — `convergeGhasSettings`: read-then-write
      each GHAS/repo-security toggle and merge-button setting
      independently — one setting's failure (report-and-skip on a 422
      entitlement error) never blocks the rest. Only an unexpected
      (non-422) write failure throws, which the sweep records as that
      repo's `failed` outcome.
    - `default-setup.ts` — `convergeDefaultSetup`: pure API
      mutation, no files, no PR. Drives server-side CodeQL default setup
      to `not-configured` on every managed repo, since a live default
      setup and the converger's advanced CodeQL workflow are mutually
      exclusive. Read-then-PATCH-on-diff; a 403/404 (feature/plan
      unavailable) is report-and-skip, not a failure.
    - `ruleset.ts` — `convergeProtectMainRuleset`: pure API
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
    orchestration. `runSweep`'s `converge` (files), `convergeGhas`
    (settings), and `convergeDefaultSetup` steps all stay
    injectable stubs (tests supply their own) and run independently per
    repo in the same per-repo pass — one step's failure doesn't skip the
    others, but any failure marks the repo `failed` and skips stamping.
    `runSweepFromEnv` wires the real implementations in production. The
    merge pass runs independently of the version-skip
    decision, over every repo the properties API returns, so an
    unmerged converger PR from a prior tick still gets picked up.
    The `convergeRuleset` step runs in a separate pass
    **after** the merge pass, gated by an ordering rule: for a given
    repo, the ruleset is asserted only once that repo's file
    convergence has reached the default branch this tick (file
    convergence was a no-op, or its converger PR merged in the merge
    pass this tick). A repo whose file PR is still open is deferred
    (`SweepReport.rulesetDeferred`) and **not stamped** this tick — the
    next tick retries. This guards against ever requiring a
    status-check context whose producing workflow isn't yet on the
    target's default branch. The gate applies only when a
    `convergeRuleset` step is injected; omitting it (as in tests that
    don't exercise ruleset behavior) reproduces the file/GHAS/
    default-setup-only stamping behavior.
- `assets/` — the template payloads the converger renders. This repo's
  `assets/` files are the payloads: `render.ts` and `files.ts` operate
  directly on them, with no external source of truth to reconcile
  against at runtime. The set: `dependabot.yml` +
  `ecosystem-block.yml` templates, the gate/guard `.yml` workflows, the
  CodeQL payload set (`codeql.yml` workflow, `codeql-config.yml`,
  `codeql-language-present.sh` runtime language-detection script + its
  `test-codeql-language-present.sh` self-test), the
  `protect-main-ruleset.json` ruleset body template, the `auto-enable-
  automerge.yml` + `auto-rebase-prs.yml` workflows, the
  `auto-rebase-lockfile-regen.sh` script + its
  `test-auto-rebase-lockfile-regen.sh` self-test, and the
  CodeArtifact-auth payload set (`codeartifact-auth-action.yml` composite
  action, `codeartifact-auth.sh` + its `test-codeartifact-auth.sh`
  self-test). All `.sh` scripts ship verbatim and executable.
  - `dependency-pinned-gate.sh` matches workspace-covering dependency
    globs order-independently (a negation before a positive glob still
    excludes the match). A pnpm `catalog:`/`catalog:<name>` reference is
    exempt from direct exactness checking only when it RESOLVES: the
    gate walks up from the manifest toward the repo root, stops at the
    first covering `pnpm-workspace.yaml`, and checks that root defines
    the referenced label; an undefined label or no covering root at all
    is a violation, reported per manifest, not an exemption. A resolved
    reference's catalog entry is still checked for exactness once, at
    the workspace root that defines it. In npm mode the gate separately
    runs a standalone nested-pnpm-workspace-roots check — any tracked
    `pnpm-workspace.yaml` that is an ancestor of another tracked
    `pnpm-workspace.yaml` is a violation — independent of catalogs and
    of whether any manifest declares dependencies.
    `test-dependency-pinned-gate.sh` covers the catalog resolution
    cases, the nested-roots cases, and the order-independent
    glob-matching case (`negation before positive glob still
    excludes`).
  - `ecosystem-block.yml` carries `__NAMED_GROUPS_BLOCK__` (the named
    Dependabot groups — see `render.ts`'s `NAMED_DEPENDABOT_GROUPS`
    description above). `no-back-merging-guard.yml` runs with
    least-privilege permissions. `auto-enable-automerge.yml` truncates
    an oversized PR body before merging, refuses to merge an
    unverified rebased head, and documents its cron schedule inline.
  - `codeartifact-auth.sh` is the whole of the `codeartifact-auth`
    composite action's logic; `codeartifact-auth-action.yml` is thin
    glue (parse → OIDC role assumption → configure) and reaches the
    script via `$GITHUB_ACTION_PATH/../../scripts/`. It arms off a
    single `CODEARTIFACT_ROLE` Actions variable (org-level default,
    repo-level override via GitHub's own variable precedence, no merge
    logic); empty means no-op, and more than one endpoint is an error
    because npm/pnpm/yarn each resolve a package to exactly one
    registry. It writes **nothing into the working tree**: the
    credential goes to `$RUNNER_TEMP/.npmrc` with
    `NPM_CONFIG_USERCONFIG` exported through `$GITHUB_ENV`, matching how
    yarn Berry is already handled via `YARN_NPM_*`. Yarn classic (v1)
    also resolves the registry and its auth token from
    `NPM_CONFIG_USERCONFIG` even though it, like npm and pnpm, ignores
    a repo-root `.npmrc` from a nested manifest directory — it needs no
    separate `YARN_NPM_*`-style handling. That is the only
    shape independent of the directory the installer `cd`s into — npm
    resolves a project `.npmrc` from the nearest package directory and
    never walks up to the git root, pnpm only up to a covering
    `pnpm-workspace.yaml`, and `dependency-install-gate.sh` installs
    from each discovered lockfile's own directory — so a repo-root
    `.npmrc` would miss every non-root manifest. `$HOME/.npmrc` was
    rejected as a cross-repo credential pool. Only the `registry=` line
    and the configured endpoint's own `//<host><path>:` namespace are
    replaced in that file, so another registry's credential survives.
    `dependency-install-gate.yml` calls it between checkout and install
    on every non-`pip` matrix leg (mirroring its `Set up Node` guard)
    and is the only fanned-out workflow carrying an `id-token: write`
    grant — on its `gate` job only, latent (and documented inline as
    such) on repos without CodeArtifact. Operator prerequisites live in
    `docs/codeartifact-auth.md`, including the hard requirement that an
    org-level `CODEARTIFACT_ROLE` be scoped to exactly the repositories
    the IAM trust policy names.
  This repo's own `.github/actions/`, `.github/scripts/`, and
  `.github/workflows/` — the
  live copies the sweep renders onto this repo itself — are **not**
  hand-maintained: they converge on their own when the fanout sweep
  runs over this repo, the same way it converges every other managed
  repo. The authoritative payload is always the file under `assets/`;
  the live copy is an output of the sweep and must never be hand-
  edited to match it.
  Separately, `CONTRIBUTORS`, `LICENSE`,
  `PATENTS`, and `PRIOR_ART.md` are this repo's own root files,
  copied verbatim into `assets/` and shipped as the fixed seed-if-
  absent payload every managed repo receives (see `files.ts`'s
  `COMMUNITY_FILES`). These are shipped as static files in `assets/`,
  not read per-org at converge time. Packed into the release tarball
  (`.github/workflows/release.yml`) alongside `dist`/`bin`/
  `package.json`.
- `bin/gh-repo-config.js` — CLI entry point (`package.json` `bin`).
  Subcommands: `version` (default) and `sweep` (reads
  `GH_REPO_CONFIG_ORG` / `GH_REPO_CONFIG_TOKEN` /
  `GH_REPO_CONFIG_APP_SLUG` / optional `GH_REPO_CONFIG_DRY_RUN` from
  the environment; exits non-zero when any repo's convergence or stamp
  write failed, so a scheduled sweep run cannot fail silently). The
  sweep summary also prints each repo's CodeQL default-setup and
  `protect-main` ruleset outcomes, plus any ruleset-deferred repos.
- `test/` — `node:test` files, run via `node --test test/**/*.test.js`.
- `.github/workflows/ci.yml` — REPO-OWN workflow, not part of the
  sweep's rendered payload (it has no `assets/` counterpart and is
  hand-maintained here only). Runs on every PR against `main`: build +
  `npm test`, the `assets/test-*.sh` AND `scripts/test-*.sh` payload
  self-tests (looped over the discovered set from both directories, so
  a new self-test in either is picked up automatically), and lint
  (`actionlint` over `.github/workflows/*.yml`, `shellcheck` over
  `assets/*.sh` AND `scripts/*.sh`, `npm run lint:md`). A `ci-required`
  aggregator job depends on all three and is the status context this
  workflow registers as required — alongside `pin-shape-required` — via
  the repo-level `repo-required-checks` ruleset, not `protect-main`,
  which is converged by `src/converge/ruleset.ts`
  against `assets/protect-main-ruleset.json` and would revert a
  hand-added context as drift.
- `.github/rulesets/` — checked-in source-of-record copies of
  repo-level GitHub rulesets that are **operator-managed** (created
  and maintained by a human via the rules API or web UI), never
  touched by the converger. Holds `repo-required-checks.json`, the
  create-input body for the `repo-required-checks` ruleset described
  above (requires both the `ci-required` and `pin-shape-required`
  status checks on the default branch), plus a README explaining the
  recreate-from-source command. Distinct from `protect-main`, whose
  canonical source is `assets/protect-main-ruleset.json` and is
  converger-managed — it is deliberately not tracked here. Editing
  this checked-in copy does not itself change the live ruleset;
  applying a change is a separate, manual, post-merge operator step
  (the README's recreate-from-source command).
- `scripts/` — repo-own scripts, distinct from `.github/scripts/`
  (sweep-rendered payload territory the converger overwrites from
  `assets/` on every tick — a repo-own script placed there would be
  destroyed on the next sweep). Holds `bump-asset-pins.sh` (rewrites
  `assets/*.yml`'s `uses:` pins to the current eligible upstream
  release, applying the same policy the rendered `github-actions`
  Dependabot ecosystem applies: security fixes immediately, everything
  else after a 7-day soak, semver-major bumps limited to the
  `github/codeql-action/*` named group — see the script's own header
  for the full policy and why `assets/*.yml` needs its own bumper
  instead of relying on Dependabot, which can't reach templates
  outside `.github/workflows/`) and `check-pin-shape.sh` (an offline,
  purely syntactic gate asserting every `uses:` in `assets/*.yml` is
  either a local ref or an exact 40-hex-SHA pin; staleness is
  explicitly out of scope — that's the bumper's job, on its own
  schedule), plus their self-tests `test-bump-asset-pins.sh` /
  `test-check-pin-shape.sh` (both fully offline, no network access).
- `.github/workflows/assets-pin-bump.yml` — REPO-OWN workflow, not
  part of the sweep's rendered payload (no `assets/` counterpart,
  hand-maintained here only). Scheduled daily plus `workflow_dispatch`;
  runs `scripts/bump-asset-pins.sh` under the ambient read-only
  `github.token` (the script itself only ever makes read-only GitHub
  API calls) and, only if it actually changed a file, force-pushes the
  fixed `assets-pin-bump/main` branch and opens **or updates** a single
  PR against `main` — mirroring `src/converge/writer.ts`'s own
  fixed-branch, open-or-update contract rather than a timestamped
  branch per run, so a lingering unmerged bump is amended instead of
  duplicated. Before that force-push, a bot-authorship guard reads the
  branch's LIVE remote tip via `git ls-remote` (not the possibly-stale
  ref `actions/checkout` already fetched) and, if the branch exists,
  refuses to push unless that tip's committer email is this workflow's
  own bot identity — a bare `--force-with-lease` is not sufficient
  since checkout's own fetch would have already refreshed the lease's
  remote-tracking ref, so a maintainer's own new commit on the branch
  would silently be clobbered otherwise. `--force-with-lease=<ref>:
  <expected>` (or `<ref>:` with an empty expected value when the
  branch doesn't yet exist) is layered on top as defense-in-depth
  against the narrower race between that check and the push itself.
  The commit/push/PR step mints a short-lived GitHub App
  installation token from the `AUTOMERGE_APP_ID` /
  `AUTOMERGE_APP_PRIVATE_KEY` repo secrets (the same PR-operations App
  `auto-rebase-prs.yml` / `auto-enable-automerge.yml` use) rather than
  the default `GITHUB_TOKEN` — a PR opened with `GITHUB_TOKEN` does not
  trigger `pull_request` workflows, so `ci.yml` and `pin-shape.yml`
  would never run on its own PRs and they could never satisfy the
  `ci-required` / `pin-shape-required` required checks. That App token
  is scoped to only this last step, kept out of the checkout and the
  bump script that parse untrusted upstream release/advisory text —
  `git remote set-url` does write it into `.git/config`, but only here,
  on the ephemeral runner, after the untrusted-text-parsing steps have
  already finished. Never uses `CONVERGER_APP_*` — that App's
  Administration/Org administration scope must not be held by a job
  parsing untrusted upstream release notes and advisory text.
- `.github/workflows/pin-shape.yml` — REPO-OWN workflow, not part of
  the sweep's rendered payload (no `assets/` counterpart, hand-
  maintained here only). Runs `scripts/check-pin-shape.sh` on every PR
  against `main`. Its `pin-shape-required` aggregator is registered as
  a required status check via the repo-level `repo-required-checks`
  ruleset, not `protect-main`, for the same reason `ci-required` is —
  a hand-added context on `protect-main` would be reverted as drift by
  `src/converge/ruleset.ts`.
- `.github/workflows/release.yml` — publishes a tagged (`v*`) GitHub
  Release with a build-provenance attestation. Bumping the release
  version means editing `package.json`'s `version` and pushing a
  matching `vX.Y.Z` tag; the workflow verifies the two match before
  building. Release immutability itself has no REST/`gh` API surface —
  it is a one-time manual web-UI toggle (repo/org Settings > General >
  Releases), not something this workflow or any converger slice can
  enable programmatically; verify current state with
  `gh release view <tag>`.
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
