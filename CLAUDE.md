# gh-repo-config

Org-wide repo-configuration converger. TypeScript, Node >=22, ESM
(`"type": "module"`). See `docs/org-repo-configuration-fanout-design.md`
and `docs/org-repo-configuration-fanout-decomposition.md` for the
overall design and issue breakdown.

Both of those are **point-in-time records**, and each says so in its own
first lines (`Status: design, not yet implemented.`, `Status: proposed
issue breakdown.`). They state what was intended, not what is built, so
code moving away from them never makes their prose false — it makes the
code *diverge*, and that divergence is information worth keeping. Never
edit a doc carrying such a marker to match as-built behaviour, and never
count one among the hits when sweeping the repo for prose a structural
change falsified; a half-design/half-as-built file is worse than either
pure form. As-built behaviour belongs in this file, in an asset's own
inline comments, or in a doc that makes no point-in-time claim
(`docs/codeartifact-auth.md`, `docs/github-app-converger.md`). Read a
`docs/` file's first lines for a status marker before editing it.

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
      workflows' extra placeholders: the fixed org-level constants
      (App identity, merge method, do-not-merge label, required-check/
      install-gate workflow names, and `__INSTALL_GATE_CHECK__` — the
      install gate's single required-check job name, which the
      lockfile-regen pass keys off) plus the per-repo-but-derived
      `__BOT_SLUG__` (`<repo>-auto-rebase[bot]`), layered on top of the
      same three per-repo tokens `renderTemplate` already resolves. No
      single template uses every constant — `auto-rebase-prs.yml` owns
      the sweep-side ones (`__REQUIRED_CHECK_WORKFLOW__`,
      `__INSTALL_GATE_WORKFLOW__`, `__INSTALL_GATE_CHECK__`,
      `__REST_MERGE_METHOD__`) and `auto-enable-automerge.yml` the
      native-auto-merge one (`__MERGE_METHOD__`) — so
      `test/render.test.js` asserts coverage over their union, and
      asserts the union is complete so a constant that falls out of
      both templates cannot go unnoticed. The
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
      key set, and the server's keys are never iterated. The two
      compare shapes differ: `pull_request` iterates the desired rule's
      own parameter keys, so a key added to that rule in the asset is
      compared automatically; the remaining compared rules name their
      parameters explicitly (`required_status_checks`'s
      `strict_required_status_checks_policy` and
      `do_not_enforce_on_create`, `code_scanning_tools`, `severity`),
      which today is every key the asset carries for them — adding a
      canonical key to one of those rules means adding it to that
      enumeration too, or it silently goes uncompared. A
      parameter key the canonical asset does not model at all — a
      GitHub-supplied default such as
      `pull_request.dismissal_restriction` — is by that contract
      deliberately ungoverned: it is neither drift (the canonical PUT
      could never set a key it has no concept of, so treating it as
      drift would churn every tick with no way to converge) nor a
      surfaced warning (issue #82 removed the warning channel that used
      to report such keys — GitHub adds parameters over time, so it
      fired on every repo on every tick and carried nothing an operator
      could act on). Do not reintroduce a pass over the existing rule's
      keys, value-aware or otherwise.
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
    least-privilege permissions. The two PR-automation workflows are
    split by EVENT, not by concern (issue #77): `auto-rebase-prs.yml`
    owns everything the `workflow_run` / `workflow_dispatch` /
    `schedule` / `push` / `issue_comment` sweep does — the rebase pass
    AND the Dependabot REST-merge pass that used to be
    `auto-enable-automerge.yml`'s own `dependabot-rest-merge` job —
    while `auto-enable-automerge.yml` is now `pull_request`-only and
    does nothing but enable native auto-merge. They were not collapsed
    into one file because the converger has no delete path: retiring a
    rendered workflow would leave an orphan copy running, and billing,
    on every managed repo. The REST-merge pass passes the evaluated
    head SHA to the merge call, so a head that moved since the checks
    were verified 409s and is left for the next sweep rather than
    merged unverified. Both workflows truncate an oversized PR body at
    16000 chars (appending the PR URL) before it becomes a merge-commit
    message, since GitHub caps commit messages at 16383. Each documents
    its trigger set — including `auto-rebase-prs.yml`'s two-rationale
    cron list — inline.
  - **Job count is a first-class constraint on every fanned-out
    workflow.** GitHub bills a whole minute per JOB, rounded up, so a
    wrapper job doing three seconds of work costs the same as a real
    one, and a check NAME is free while a JOB is not. Issue #77
    collapsed the shapes that violated this and they must not be
    re-split:
    - `dependency-pinned-gate.yml` and `dependency-install-gate.yml`
      are each ONE job — detection happens in a `run` block, the
      per-ecosystem/per-PM legs are a `run`-block loop — carrying the
      same `pinned-gate-required` / `install-gate-required` names
      `protect-main-ruleset.json` requires. The per-leg check names they
      gave up are bought back with a job-summary table and a
      per-failure `::error title=...::` annotation, not with jobs. That
      annotation carries no `file=`, so it defaults to `.github` line 1
      and surfaces on the run page and Checks tab only — the
      diff-attached annotations are the ones the gate SCRIPTS emit
      (`::error file=<manifest>::`). Do not write that the workflow's
      own annotation lands on Files changed. Both
      loops split the script's `--present` JSON array EXPLICITLY into a
      bash array and take the fail-open branch BEFORE splitting; relying
      on unquoted word splitting silently degrades to one iteration with
      the whole string as a single argument, which reddens the required
      check for a reason unrelated to the repo.
    - `dependency-install-gate.yml`'s detect step emits `node` / `pip`
      flags because a single job has no `matrix.pm` to guard
      `Set up Node` and the CodeArtifact auth step with. That guard is
      load-bearing: unguarded, a pip-only repo performs a real
      `AssumeRoleWithWebIdentity` it has no role for. Those guards are
      also the only reason detection MUST be its own STEP there: a
      step-level `if:` can read another STEP's outputs but not a
      mid-step shell variable (the install loop then reads the same
      step's `pm_csv` output, but that alone would not force the
      split). `dependency-pinned-gate.yml` has no
      conditional steps, so its `--present` call stays INLINE at the
      head of its one check step (that step carries no `id:` at all).
      The asymmetry is deliberate — do not harmonize the two, and do
      not describe the pinned gate as having a detect step.
    - **A detection mode talks to its workflow over STDOUT, never
      `$GITHUB_OUTPUT`.** This covers `dependency-install-gate.sh
      --present`, `dependency-pinned-gate.sh --present`, and
      `codeql-language-present.sh --matrix`. Before issue #77 each also
      wrote `pms=` / `ecosystems=` / `languages=` into `$GITHUB_OUTPUT`
      for the retired `detect` job to re-export to its matrix. The
      collapse removed every consumer, so those writes were removed
      too; every caller now captures that stdout directly, and the two
      that need the result in a LATER step (the install gate's and
      CodeQL's detect steps) derive their own step outputs from it.
      Re-adding one produces a step output nothing reads (and, in
      the pinned gate, one that is not even addressable). Each of the
      three modes carries a comment saying so. This does NOT touch
      `codeartifact-auth.sh`'s `emit` helper, whose step outputs the
      composite action really does consume.
    - `codeql.yml` analyzes every ubuntu-runner language in ONE
      `init` + `analyze` pair (the action takes a comma-separated
      language list) named `codeql-required`, with a second
      `analyze-swift` job that exists only when a non-ubuntu language is
      present. Neither analyze step passes `category:` — with the matrix
      gone, a literal category would be shared by both jobs and the two
      uploads would displace each other, whereas the action's derived
      `<workflow path>:<job id>` category is distinct per job. Do not
      reinstate it.
    - `auto-rebase-prs.yml`'s `schedule:` list serves TWO backstops
      with different rationales, and the file's comments must keep them
      apart. The REBASE backstop is WINDOWED to Pacific weekday
      business hours (`0 15-23 * * 1-5` + `0 0-2 * * 2-6`, 12 ticks a
      weekday instead of the old `*/20`'s 72 a day) — it exists only to
      catch the lazy-`mergeStateStatus` race, which cannot happen while
      nobody is pushing. Those two entries are the UNION of PDT and PST
      deliberately: GitHub cron is UTC-only, and over-covering by an
      hour beats clipping a real working hour for four months of the
      year. Splitting across the UTC date boundary is why their
      day-of-week fields differ. The MERGE backstop is the third entry,
      `0 15 * * 0,6` — the weekend replacement for the `0 12 * * *`
      daily cron the REST-merge pass had in `auto-enable-automerge.yml`
      before issue #77 moved it here. It catches a dropped
      `workflow_run` completion on a PR Dependabot opened on its own
      schedule, which does not stop for the weekend, so the rebase
      backstop's weekday reasoning does not cover it. 15:00 UTC is the
      hour the weekday window opens, which leaves no gap in the week
      longer than 24 h. Do not fold the weekend entry into the weekday
      window's justification.
    - The constraint is PINNED, not just documented:
      `test/files.test.js`'s `EXPECTED_JOBS` table names every rendered
      workflow's exact job-id list, and the test asserts the table's key
      set equals the set of rendered `.github/workflows/` paths — so a
      new workflow cannot escape the constraint by omission, and a
      re-split fails `npm test`. Adding a job means editing that table,
      which is the point: the edit is where the billing cost gets
      argued. Job ids are read with the file's `workflowJobIds` helper,
      which slices the top-level `jobs:` mapping before matching job-id
      syntax — counting keys BY INDENT does not work, since `on:`'s own
      keys sit at the same indent (and `codeql.yml`'s jobs block opens
      with a two-space-indented comment that ends in a colon).
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
    `dependency-install-gate.yml` calls it between checkout and the
    install loop, guarded by the same detect-step `node` output that
    guards `Set up Node`, and is the only fanned-out workflow carrying
    an `id-token: write` grant — on its single `install-gate-required`
    job only, latent (and documented inline as such) on repos without
    CodeArtifact. Operator prerequisites live in
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
  refuses to push unless that tip's commit was produced entirely by
  this workflow's own automation: AUTHOR is this workflow's bot
  identity AND COMMITTER is either that same bot identity (a fresh
  bumper push) or the PR-automation bot identity (a rebase of the
  bumper's own PR). Author alone is keyed first because
  `auto-rebase-prs.yml`'s rebase sweep rebase-and-force-pushes any
  open, non-draft, same-owner PR that has fallen behind `main` —
  including the bumper's own PR — and `git rebase` rewrites the
  committer while leaving the author untouched. (The Dependabot
  REST-merge sweep issue #77 moved into that same workflow also
  rebases and force-pushes under that identity, but its candidate
  filter requires `author.login == "dependabot"`, so it never reaches
  the bumper's branch.) But author alone is not sufficient: a
  maintainer who *amends* the bot's commit keeps the bot as author
  while replacing its content, so the committer is checked too — any
  committer other than the bot itself or the auto-rebase bot means the
  commit was amended by someone else, and the push is refused exactly
  like a non-bot-authored commit is. A bare `--force-with-lease` is not
  sufficient on its own since checkout's own fetch would have already
  refreshed the lease's remote-tracking ref, so a maintainer's own new
  commit (or amendment) on the branch would silently be clobbered
  otherwise.
  `--force-with-lease=<ref>:<expected>` (or `<ref>:` with an empty
  expected value when the branch doesn't yet exist) is layered on top
  as defense-in-depth against the narrower race between that check and
  the push itself.
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
  Release with a build-provenance attestation. Cutting a release is
  only the tag push: `package.json`'s `version` already moved in the
  PR that changed the code (see Conventions), so a release means
  pushing a `vX.Y.Z` tag matching whatever version `main` currently
  carries; the workflow verifies the two match before building. The
  sweep does not consume the tarball this produces — it builds from
  `main`'s source tree — so a version bump takes effect on the next
  sweep whether or not a tag ever follows. Release immutability itself
  has no REST/`gh` API surface — it is a one-time manual web-UI toggle
  (repo/org Settings > General > Releases), not something this workflow
  or any converger slice can enable programmatically; verify current
  state with `gh release view <tag>`.
- `.github/workflows/sweep.yml` — scheduled (daily) + `workflow_dispatch`
  sweep. Runs as a dedicated converger org GitHub App (org secrets
  `CONVERGER_APP_ID` / `CONVERGER_APP_PRIVATE_KEY`), distinct from the
  pr-automation App, since it needs Administration / Org administration
  scope the pr-automation App must never hold. Requires the
  org-level custom properties to be defined
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
- Every PR bumps `version` in the root `package.json`, and the bump
  must advance the `X.Y.Z` core itself past main's current value.
  "Strictly greater semver" is not the bar: `0.2.0` → `0.3.0-rc.1` →
  `0.3.0` is two valid semver steps whose second one delivers nothing,
  because the compare reads only the `MAJOR.MINOR.PATCH` core and a
  repo already stamped `0.3.0-rc.1` is therefore not behind `0.3.0`.
  Prerelease and build identifiers are consequently not usable here at
  all — `test/version.test.js` fails on a `CURRENT_VERSION` carrying
  one. The reason for the bump itself is the sweep, not release
  hygiene: `.github/workflows/sweep.yml` checks out the
  triggering ref (`main` on its daily schedule) with no `ref:`
  override, then runs `npm ci`, `npm run build`, and the CLI from that
  source tree — never from a release tarball — so `CURRENT_VERSION` is
  whatever that `package.json` says (`src/version.ts`). `isBehind`
  reports a repo already stamped at that value as not behind, and
  `decideRepo` returns `skip-current` for it
  (`src/version-compare.ts`, `src/stamp/decide.ts`). A PR that changes
  `assets/` without a bump therefore reaches no repo a prior sweep
  already stamped at that version — it merges and silently delivers
  nothing.
  - Bump in the PR itself, and re-check after a rebase: a concurrent
    merge may have taken the version you picked.
  - Semver decides which component to bump. The jump to 1.0.0 is a
    deliberate contract-stability decision, made by a human, never as
    part of routine work.
- Tests import nothing this repo does not declare in `package.json`.
  The case that comes up is YAML: tests inspect rendered workflow YAML
  with small hand-rolled string helpers, never `js-yaml`. `js-yaml` is
  in the tree only because `markdownlint-cli2` depends on it
  (`package-lock.json` lists no other dependent), so importing it would
  couple `npm test` — and therefore the `ci-required` check — to another
  package's dependency graph. Declare the dependency first if a real
  parser is ever warranted.
