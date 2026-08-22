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
(`docs/codeartifact-auth.md`, `docs/github-app-converger.md`,
`docs/repo-selection.md`). Read a
`docs/` file's first lines for a status marker before editing it.

## Verifying dependency claims in a fresh worktree

A subagent worktree here starts with no `node_modules`, and even the
primary clone often has only prod deps installed. So `npm ls <pkg>`
returns `(empty)` for every dev-tree package, which looks like evidence
the package is absent. Run `npm ci` (lockfile-honoring, allowed) before
concluding anything, and prefer `package-lock.json` as the durable
citation in prose since it is present regardless of install state.

**Why:** a test docstring that justifies hand-rolling a YAML helper
with claims about `js-yaml` being an undeclared transitive dep of
`markdownlint-cli2`, and about its ESM export shape, states two true
things that are nonetheless uncheckable until `npm ci` has run — the
docstring's own suggested check (`npm ls js-yaml`) reproduces as empty
in a fresh worktree, which reads as a refutation and is not one.

**How to apply:** when a doc comment or doc file asserts something
about a package's presence, dependents, version, or export shape,
install from the lockfile and verify it empirically (`node
--input-type=module -e "import ..."` settles export shape). Then
rewrite the prose to cite `package-lock.json` and name the pinned
version, since that file is present whatever the install state.

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
heading. The same path-based glob reaches scratch Markdown under
`.claude/tmp/<task slug>/` — a PR body staged for `gh pr edit
--body-file`, say — which is gitignored but linted anyway, and fails
`MD041` and often `MD012`. Delete the scratch directory before running
`lint:md`; never fix the scratch file's lint errors and never add a
config exclusion for it.

```bash
npm run lint:md
```

`shellcheck`, which `.github/workflows/ci.yml` runs over `assets/*.sh`
and `scripts/*.sh`, is a runner-image binary rather than a project
dependency: it is absent from this host, from `package.json`, and from
`node_modules/.bin`, with no `npx` fallback. Its absence is neither a
blocker to escalate nor grounds for a `brew install`. Substitute what
is local — `bash -n <script>` for syntax, the matching
`assets/test-*.sh` / `scripts/test-*.sh` self-test for behaviour, and
`scripts/check-pin-shape.sh` when any `assets/*.yml` changed — and say
in the report that shellcheck did not run, rather than implying the CI
lint set passed.

## Structure

- `src/` — TypeScript source, compiled to `dist/` by `npm run build`.
  `dist/` is gitignored; tests and `bin/gh-repo-config.js` import from
  `dist/`, not `src/`.
  - `src/config/selection.ts` — managed-or-not precedence over the one
    `gh-repo-config-mode` custom property (issue #68), which carries
    both levels of the decision: a repo's own `opt-in`/`opt-out` value,
    and — in the same property's schema — the `default_value` an unset
    repo reads through to. Both levels state the repo's state, so
    `opt-in` always means managed. The contract, the truth table, the
    422 that forces `required: true`, and the operator runbook are in
    `docs/repo-selection.md` (as-built, no status marker).
  - `src/config/org-config.ts` — the per-org config file (issue #91):
    the seam that lets one released tarball serve every org. The model
    is that each org runs the sweep from its own private sweeper repo,
    which carries this file as org-owned content the converger never
    converges (the sweeper repo's own workflow IS a payload — issue #92,
    see `assets/sweeper-sweep.yml` — but `gh-repo-config.json` itself
    never is, under any policy); `runSweepFromEnv` reads its
    path from `GH_REPO_CONFIG_FILE` (unset or empty — the shape an
    unset Actions expression renders as — → every value takes its
    baked default and the sweep behaves exactly as it did before,
    whereas a path that is set but unreadable throws, since an
    explicitly named file that is not there is a misconfiguration and
    never a silent fall back to the defaults). The
    format is **JSON**, one top-level object, because the release
    tarball is dependency-free (no YAML parser at runtime) and the
    sweeper workflow (`assets/sweeper-sweep.yml`) must read the version
    pin out of the same file in bash with `jq` before the tarball
    exists. Keys,
    all optional and all kebab-case: `named-dependabot-groups` (group
    name → non-empty pattern array; a **full replacement** of
    `DEFAULT_NAMED_DEPENDABOT_GROUPS`, so `{}` renders no named groups),
    `pr-automation-identity` (all of `app-name`,
    `app-client-id-secret`, `app-private-key-secret`, `bot-slug`
    required together — a partial identity mixes one org's App with
    another's secret names; `app-client-id-secret` maps to
    `PrAutomationIdentity.appClientIdSecret` and names the secret
    holding the App's **Client ID**, not its numeric App ID, since
    that is the value `actions/create-github-app-token`'s
    `client-id:` input takes),
    `version-pin` (`vX.Y.Z`; absent means latest, and there is
    deliberately no per-target-repo pinning, since the sweep runs one
    tarball version per tick and per-repo pins would institutionalize
    skew the stamp/`isBehind` model has no endpoint for — the escape
    hatch for one repo is `gh-repo-config-mode: opt-out`), and
    `sweeper-update-policy` (`manual` | `auto` | `off`, default
    `manual`; its consumer is the sweeper-workflow payload, issue #92 —
    `off` drops the workflow from the payload set entirely, while
    `manual` and `auto` both render it and differ only in whether the
    resulting PR may merge unattended). Every malformed value
    is a thrown `Error` naming the key, raised before the sweep's first
    API call — a silently-ignored pin or policy is worse than a failed
    tick. Unknown keys, top-level or inside `pr-automation-identity`,
    are one stderr warning line each and never stop the sweep — emitted
    through a caller-supplied sink (`OrgConfigWarningSink`, defaulting to
    stderr) as each key is found, in one pass ahead of all validation, so
    a malformed value elsewhere in the same file cannot swallow the
    warning by throwing first. Editing this file does NOT on its own
    re-converge a repo already stamped at `CURRENT_VERSION`: the version
    skip reads only the `gh-repo-config-version` stamp, which no
    config-file change moves, so a new named group or a new identity
    reaches already-current repos only once the converger's own
    `version` is bumped (or those repos' stamps are cleared) — the same
    hazard Conventions documents for an un-bumped `assets/` change.
    `assertVersionPinSatisfied` is the pin's defense-in-depth check
    (the sweeper workflow's own `jq` read is the primary enforcement):
    strip the leading `v`, compare to `CURRENT_VERSION`, throw naming
    both on mismatch.
    `parseSweeperRepo` validates `GH_REPO_CONFIG_SWEEPER_REPO` —
    absent or empty means no repo is the sweeper this tick, anything
    else must be `owner/repo` or it throws. That value is the
    sweeper repo's own `owner/repo`, which reaches the sweep via
    environment rather than this file because the invoking workflow
    states its own `$GITHUB_REPOSITORY`, so no org Actions variable (and
    no extra converger-App scope) is needed and the identity cannot
    drift.
  - `src/version-compare.ts` — `isBehind`, the version-skip check
    against `gh-repo-config-version`.
  - `src/stamp/decide.ts` — combines selection + version-skip into a
    single per-repo verdict (`skip-unmanaged` / `skip-current` /
    `converge`).
  - `src/github/properties.ts` — dependency-free `fetch`-based REST
    client for the org custom properties (paginated read,
    batched ≤30 stamp write). `readDefaultMode` reads the
    `gh-repo-config-mode` SCHEMA's `default_value` and returns a
    `DefaultModeRead` discriminated union carrying **provenance**, not a
    bare value (issues #67, #68): `set` (200 with a `default_value`,
    whose unvalidated `raw` string rides along), `defined-no-value` (200
    with none), `not-defined` (404 — the property does not exist on the
    org). The distinction exists because `normalizeDefaultMode`'s
    fail-safe collapse to `opt-out` makes an unprovisioned org read
    exactly like a genuinely opt-out one, which once masked a real
    outage: the selection properties did not exist on TheVoskamps until
    2026-07-26 (issue #59), and every tick from the sweep workflow's
    first run reported all repos unmanaged. Only the `set` arm's `raw`
    is ever normalized, so the provenance never decides selection by
    itself — both no-value arms feed the same fail-safe collapse and
    resolve alike, and only a `set` arm's `raw` moves the verdict. Those
    two arms additionally exit the CLI non-zero, since a `default_value`
    is accepted only on a `required: true` property and so a mode
    property carrying none is provisioning drift rather than a steady
    state.
  - `src/github/merge.ts` — `MergeClient`, same dependency-free-`fetch`
    shape as `properties.ts`. Lists the converger App's own open PRs on
    a repo, resolves required checks via the rules API
    (`GET /repos/{o}/{r}/rules/branches/{branch}`, not legacy branch
    protection), and REST-merges (merge-commit only) whichever are
    green. A 405/409 from the merge call itself is `awaiting-retry`,
    not a failure. `evaluateAndMerge`'s `humanApprovalPaths` option
    (issue #92) reserves target paths for a human: when the PR's changed
    files (`GET /repos/{o}/{r}/pulls/{n}/files`, paginated) include one,
    the attempt settles as `awaiting-human` — never merged, not a
    failure, and not something a later tick resolves on its own. The
    check runs BEFORE the check-state rollup, since the outcome cannot
    change with the checks, and an empty/absent list costs no extra
    request at all. `src/sweep.ts` is the only production caller that
    populates it.
    This is the SECOND of two locks on the same paths and covers only
    the converger's own merge call; the one that binds every merge
    mechanism — including GitHub-native auto-merge, which the rendered
    `auto-enable-automerge.yml` turns on and this pass has no say over —
    is the draft state `src/converge/writer.ts` puts the PR in. Keep
    both: a human who marks the held PR ready without merging it clears
    the draft lock until the next tick that commits re-applies it, and
    the path list is what holds the PR in that window.
    A DRAFT PR is `awaiting-human` too, on every repo and with no
    reserved paths in play: `OpenPullRequest` carries the list
    endpoint's own `draft` flag, and `evaluateAndMerge` settles on it
    right after the reserved-path check, before any check-state read.
    Without that, a PR a maintainer hand-drafts would spend the rollup
    reads to earn a merge PUT GitHub rejects outright, cycling
    `awaiting-retry` every tick forever. The reserved-path check keeps
    the earlier position deliberately: the anchor PR under `manual` is
    both drafted and reserved, and naming the reserved path is the more
    actionable report. Both settle as `awaiting-human` rather than a
    new outcome value, since that value already means "no later tick
    resolves this, a person does" and one PR must not get two outcomes
    depending on which check ran first.
  - `src/github/contents.ts` — `ContentsClient`, same dependency-free-
    `fetch` shape as `properties.ts` / `merge.ts`. The converger's
    file-write path: reads a target repo's default branch and current
    file state, then commits changed files via the **git-data API**
    (blobs → tree → commit → ref) so scripts land mode `100755` (the
    contents API cannot set the executable bit), and opens or updates a
    single PR to the default branch. Also carries `readFileIfPresent`,
    the one contents-API read (`GET /repos/{o}/{r}/contents/{path}`),
    absent-tolerant — a 404 (repo or path missing), a directory, or a
    non-file all return `undefined`; any other non-2xx throws — used
    only by the community-file seed lookup (`src/converge/community.ts`).
    `createPullRequest` takes a `draft` flag, and
    `convertPullRequestToDraft` / `markPullRequestReadyForReview` are the
    module's ONLY GraphQL calls (bare `fetch` to `/graphql`, so the
    zero-dependency shape is unchanged), sharing one private
    `pullRequestDraftMutation` helper: `draft` is writable on the REST
    create call only, and `PATCH /repos/{o}/{r}/pulls/{n}` carries no
    such field, so flipping an open PR's draft state EITHER way has no
    REST surface at all. A GraphQL error arrives as
    HTTP 200 with an `errors` array, so both the status and that array
    are checked. Do not "simplify" either into a PATCH.
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
      SKILL.md Step 3). Each ecosystem block also carries the org's
      named Dependabot groups — ONE union of its lockstep/stack groups,
      rendered identically into every armed ecosystem — not scoped per
      ecosystem, per the same arm-everything-unconditionally/
      repo-identity principle `DEPENDABOT_ECOSYSTEMS` itself follows. A
      group whose patterns match nothing in a given ecosystem is inert
      there. The registry is a per-org input (issue #88):
      `OrgRenderOptions.namedDependabotGroups` (a `NamedDependabotGroups`
      map of group name → patterns), threaded from `buildDesiredFiles`
      through `renderDependabotYml`; when absent, the baked
      `DEFAULT_NAMED_DEPENDABOT_GROUPS` (`codeql-action`, `aws-cdk`,
      `vite-toolchain`, `fastapi-stack`, `sqlalchemy-stack`, `auth-stack`,
      `aws-sdk`, `test-stack`) renders byte-for-byte as before, and
      `NAMED_DEPENDABOT_GROUPS` remains exported as that default's
      rendered text. `renderNamedGroupsBlock` produces the block from
      either registry, at the fixed 6/8/10-space indents the `groups:`
      map needs; an empty registry drops the placeholder line (the same
      empty-block collapse `__VERSIONING_STRATEGY_BLOCK__` gets), and a
      group whose pattern list is empty throws (a valueless `patterns:`
      key is not the list shape Dependabot accepts — fail loud, like the
      unresolved-token assertion, rather than ship it).
      Precedence is unchanged either way: named groups are listed before
      each ecosystem's `*-minor-and-patch` catch-all, so a dependency
      matching both lands in the named group. `renderPrAutomationTemplate`
      renders the PR-automation workflows' extra placeholders, split
      along the identity/contract line (issue #89):
      `PR_AUTOMATION_CONSTANTS` are the fixed, org-agnostic contract
      constants (merge method, do-not-merge label, required-check/
      install-gate workflow names, and `__INSTALL_GATE_CHECK__` — the
      install gate's single required-check job name, which the
      lockfile-regen pass keys off) with deliberately no override path;
      the App-identity slice (`__APP_NAME__`, `__APP_CLIENT_ID_SECRET__`,
      `__APP_PRIVATE_KEY_SECRET__`, `__BOT_SLUG__`) is the per-org
      `OrgRenderOptions.prAutomationIdentity` (a `PrAutomationIdentity`),
      defaulting to `DEFAULT_PR_AUTOMATION_IDENTITY`, because each org
      owns its own PR-automation App. `botSlug` is a pattern that may
      carry the per-repo tokens — the default `__GH_REPO__-auto-rebase[bot]`
      is the historical `<repo>-auto-rebase[bot]` derivation, resolved by
      the final `renderTemplate` pass; a fixed org bot identity is a plain
      string. Both are layered on top of the
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
      `PRIOR_ART.md` — the paths are exported as `COMMUNITY_FILE_PATHS`)
      at repo root; these are the one payload kind that
      is **seed-if-absent** rather than converge-and-overwrite, flagged
      by the optional `honoredLocations` field on `DesiredFile` —
      present only on `COMMUNITY_FILES` entries, absent (and therefore
      always converge-and-overwrite) on every other payload. They are
      also the one payload kind whose CONTENT is not an asset of this
      repo (issue #90): `buildDesiredFiles(ctx, options)` takes it as
      `DesiredFilesOptions.communityFiles` (a path → content map, the
      org's own copies as read from its `.github` repo by
      `community.ts`) and emits a `DesiredFile` only for the paths the
      map carries — a path absent from the map is silently not a
      payload (no error, no empty file), and an absent map seeds
      nothing. `DesiredFilesOptions` extends `OrgRenderOptions`, so the
      same object carries the render inputs (`namedDependabotGroups`,
      `prAutomationIdentity`, each with a baked default);
      `communityFiles` is the one field with no baked default. The
      sweeper workflow (issue #92, `assets/sweeper-sweep.yml` →
      `SWEEPER_WORKFLOW_PATH`, `.github/workflows/sweep.yml`) is the one
      payload CONDITIONAL on which repo is being converged: it renders
      only when `DesiredFilesOptions.sweeperRepo` equals the converging
      repo's own `<org>/<repo>` AND `sweeperUpdatePolicy` is not `off`.
      It goes through the plain three-token render path despite carrying
      no placeholder today, so a future per-repo value needs no plumbing
      change. `gh-repo-config.json` is never a payload under any policy.
      This file also owns `sweeperHumanApprovalPaths` — the ONE
      definition of which paths that repo's converger PRs may not reach
      the default branch over without a human (`[SWEEPER_WORKFLOW_PATH]`
      on the sweeper repo under `manual`, empty everywhere else). It
      lives beside the render decision so the two halves of one policy
      cannot disagree about what an absent key means, and BOTH
      enforcement sites read it: `writer.ts` (draft state) and
      `sweep.ts` (the merge pass's `humanApprovalPaths`). Do not give
      either site a second copy of the rule. Its release,
      `sweeperPolicyReleasesHold` (true on the sweeper repo under any
      policy that no longer reserves the anchor — `auto` AND `off` —
      false everywhere else), lives here for the same reason and has the
      one consumer `writer.ts`.
    - `community.ts` — `readOrgCommunityFiles(client, org)`: the
      community-file seed source (issue #90). Looks each
      `COMMUNITY_FILE_PATHS` entry up at the root of the target org's
      `.github` repo (`COMMUNITY_SOURCE_REPO`) via
      `ContentsClient.readFileIfPresent` and returns the present ones by
      path; a file missing there, or an org with no `.github` repo at
      all, is simply left out — never an error — composing with the
      seed-if-absent semantics as "nothing to seed". A non-404 read
      failure propagates. This is a **deliberate, narrow exception** to
      the converger's no-external-source-of-truth contract, confined to
      community files; workflows, scripts, gates, and the ruleset stay
      canonical in `assets/`. The converger App's org-wide installation
      already grants the read.
    - `writer.ts` — `convergeRepoFiles`: whole-file compare (a right-
      content-wrong-mode script counts as differing), commit changed
      files onto the fixed `gh-repo-config/converge` branch, open/update
      one PR per repo. No diff → no branch, no PR. Never pushes to the
      default branch directly; the merge pass merges the PR once its
      required checks are green. A `DesiredFile` carrying
      `honoredLocations` is skipped entirely — never compared for
      drift, never overwritten — once the target repo has its own copy
      at the file's own path or at any of `honoredLocations` (repo
      root, `.github/`, `docs/` for the current community files). Takes
      the same `DesiredFilesOptions` as `buildDesiredFiles`; when the
      caller supplies no `communityFiles` it reads them itself via
      `readOrgCommunityFiles` (so a bare call still seeds at sweep
      time), while `runSweepFromEnv` reads them once per sweep, lazily,
      and passes the same map to every repo's converge. That read is
      one memoized promise, so a non-404 failure on it (auth, rate
      limit) fails every repo's converge that tick — each recorded
      `failed`, none stamped — and the next tick retries; only a
      404 (no `.github` repo, or a file missing from it) is "nothing to
      seed". A commit whose changed paths hit
      `sweeperHumanApprovalPaths` (issue #92) makes the PR a DRAFT:
      opened draft, or an open non-draft one converted via
      `ContentsClient.convertPullRequestToDraft`. Draft state IS the
      hold — nothing merges a draft PR — so it binds GitHub-native
      auto-merge as well as the converger's own merge pass, and does not
      rest on a `protect-main` ruleset a first-tick sweeper repo has not
      got yet. The decision reads THIS commit's changed paths, which are
      diffed against the DEFAULT branch — so the anchor is in every
      tick's changed set until the PR merges, and the draft is
      re-asserted on every tick that commits. A maintainer who marks the
      held PR ready and then waits has it drafted again; landing it means
      marking it ready and merging it in one sitting. That failure
      direction is deliberate (more holding, never an unattended merge),
      and both `writer.ts`'s own PR-body note and `merge.ts`'s
      `humanApprovalPaths` doc say so — do not restore prose claiming a
      readied PR stays ready.
      The body note explaining the hold is written by the CREATE path
      only: a converger PR's body is never rewritten on a later tick, so
      a PR converted mid-life keeps the body it opened with. That is
      accepted rather than papered over with a body-update call — the
      standing explanation a maintainer reads is
      `assets/sweeper-sweep.yml`'s own header, which covers the
      conversion case explicitly.
      Under a policy that no longer reserves the anchor — `auto` or
      `off` — the release runs instead (`sweeperPolicyReleasesHold`, the
      sibling of `sweeperHumanApprovalPaths` and defined beside it): an
      already-draft converger PR on the sweeper repo is marked ready via
      `ContentsClient.markPullRequestReadyForReview`. Without it the
      manual→auto transition would strand the drafted anchor PR as a
      draft forever — nothing else in the system ever marks a converger
      PR ready — and the sweeper repo would silently stop converging its
      own trust anchor; manual→off would strand it the same way, with
      the sweep's own litter then blocking every later payload change on
      that branch. The release runs AFTER the branch reset and only on a
      tick that commits, which is load-bearing under `off`: the reset is
      what drops the anchor from the branch, so marking a PR ready
      without one would offer an unattended merge exactly the anchor the
      org just switched off. The consequence for a human is that
      hand-drafting a converger PR is NOT a hold under `auto` or `off`;
      flipping the policy back to `manual` is.
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
      unioning in App bypass actors (converger + the org's
      PR-automation App, each resolved to an `app_id` at sweep time —
      an uninstalled App's entry is omitted and reported, never a
      failure) onto the existing bypass list (never dropping an
      operator's own bypasses). Both slugs arrive as the `appBypass`
      argument; this module holds no slug constant of its own (issue
      #91 removed the `AUTOMERGE_APP_SLUG` export), so a second source
      cannot drift from the identity the rendered workflows use. When an
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
      other field — including rule parameters and `ref_name.exclude` —
      compared directly against the
      canonical asset; any difference is drift corrected by the PUT.
      The rule-parameter compare is one-directional over the canonical
      body: ONE loop over every rule that body carries, each running
      `compareRuleParams` over that rule's own parameter keys. Neither
      the server's rules nor its parameter keys are ever iterated, so
      both a parameter added to an existing rule and a whole rule added
      to `assets/protect-main-ruleset.json` come under comparison with
      no code edit. Do not reintroduce a hardcoded rule-name or
      parameter-name enumeration; anything the enumeration missed would
      silently go uncompared, and `test/ruleset.test.js` derives its
      expectations from the asset — plus pins the added-rule case
      directly — to catch that. A rule the SERVER lacks is skipped
      entirely (the rule-types set compare already reports it as
      `rules` drift), which is what keeps a `code_quality` rule dropped
      by a prior 422 retry from producing a parameter diff of its own;
      a canonical rule with no parameters at all (`deletion`,
      `non_fast_forward`) iterates an empty key set and is harmless.
      There is exactly ONE parameter skip, keyed by rule type in
      `PARAM_COMPARE_SKIPS`:
      `required_status_checks`'s own `required_status_checks` list,
      compared as a context-name set instead so the server-supplied
      `integration_id` inside each entry is ignored. A
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
    `runSweepFromEnv` wires the real implementations in production. It
    resolves the per-org config file (`src/config/org-config.ts`, issue
    #91) and the sweeper repo BEFORE building any client, so a malformed
    file fails the tick with no API call made, then hands every repo's
    converge a `DesiredFilesOptions` carrying `communityFiles` (read
    from the org's `.github` repo, above) plus whichever of
    `namedDependabotGroups` / `prAutomationIdentity` the file supplied;
    an org with no config file omits both and renders the baked
    `DEFAULT_NAMED_DEPENDABOT_GROUPS` / `DEFAULT_PR_AUTOMATION_IDENTITY`
    byte-for-byte. The pr-automation App slug the ruleset step ensures
    as a `protect-main` bypass actor is derived from that same RESOLVED
    identity's `appName`, so an org running its own App gets that App as
    the bypass actor rather than a default it has not installed; there
    is deliberately no baked slug constant beside it, since a second
    source would drift from the identity the rendered workflows use.
    `sweeperRepo` and `sweeperUpdatePolicy` are passed on the options,
    echoed onto `SweepReport`, and consumed (issue #92) by reaching
    every repo's converge as `DesiredFilesOptions` — which decides both
    whether the sweeper workflow is a payload there and whether the
    resulting PR is a draft — and by feeding
    `sweeperHumanApprovalPaths` (defined in `converge/files.ts`, not
    here) the merge pass's per-repo `humanApprovalPaths`. The hold fires
    ONLY for the sweeper repo under `manual`, and every half defaults an
    absent policy to `manual` — a disagreement between them about what
    an absent key means would be exactly the render-then-auto-merge loop
    the policy exists to break. A sweeper-repo PR that bundles the
    workflow with other payload changes waits for the human as a whole,
    which is intended: those changes then ride the same human-reviewed
    approval rather than a lower bar. The repo is also not stamped while
    that PR sits open, since the existing ruleset ordering gate already
    defers on an unmerged file PR. The merge pass runs independently of
    the version-skip decision, over every repo the properties API
    returns, so an unmerged converger PR from a prior tick still gets
    picked up. The `convergeRuleset` step runs in a separate pass
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
  against at runtime — the one exception being the community files,
  which are the target org's own content read from its `.github` repo
  (see `src/converge/community.ts`) and are not in `assets/` at all.
  The set: `dependabot.yml` +
  `ecosystem-block.yml` templates, the gate/guard `.yml` workflows, the
  CodeQL payload set (`codeql.yml` workflow, `codeql-config.yml`,
  `codeql-language-present.sh` runtime language-detection script + its
  `test-codeql-language-present.sh` self-test), the
  `protect-main-ruleset.json` ruleset body template, the `auto-enable-
  automerge.yml` + `auto-rebase-prs.yml` workflows, the
  `auto-rebase-lockfile-regen.sh` script + its
  `test-auto-rebase-lockfile-regen.sh` self-test, the
  CodeArtifact-auth payload set (`codeartifact-auth-action.yml` composite
  action, `codeartifact-auth.sh` + its `test-codeartifact-auth.sh`
  self-test), and `sweeper-sweep.yml` (the per-org sweeper workflow,
  issue #92). All `.sh` scripts ship verbatim and executable.
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
    least-privilege permissions. The PR-automation workflows are
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
    Both mint their App installation token through
    `actions/create-github-app-token`'s `client-id:` input, fed from
    `__APP_CLIENT_ID_SECRET__` (`AUTOMERGE_APP_CLIENT_ID` under the
    default identity, see `render.ts`'s
    `DEFAULT_PR_AUTOMATION_IDENTITY`). The action still accepts
    `app-id:` but carries a `deprecationMessage` on it, so shipping
    that input would warn on every managed repo on every run;
    `test/files.test.js` pins the ban by asserting no line of these two
    rendered workflows opens an `app-id:` key; the assertion is anchored
    to a line-leading key, not to the bare word, because both headers
    name the deprecated input in prose, and it is scoped to these two
    workflows, not to the whole payload. The switch also changed which
    secret is read — an App's Client ID and its numeric App ID are
    different values — so `AUTOMERGE_APP_CLIENT_ID` is a separate
    operator-provisioned secret, not a rename of `AUTOMERGE_APP_ID`;
    `/gh-repo-setup-pr-automation` seeds only `<prefix>_APP_ID`, so the
    Client ID secret is set by hand. BOTH secrets the rendered workflows
    read — `AUTOMERGE_APP_CLIENT_ID` and `AUTOMERGE_APP_PRIVATE_KEY` —
    must be ORG secrets with all-repositories visibility, present in
    BOTH org secret stores, the Actions one and the Dependabot one; the
    `assets/auto-enable-automerge.yml` header carries the one full
    statement of why, and is the copy a managed repo's maintainer reads.
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
    - `sweeper-sweep.yml` (issue #92) is ONE job named `sweep`. Its
      resolve / download / verify / unpack / mint / run stages are
      STEPS, which is where their ordering guarantee already comes from;
      splitting them into jobs would multiply the sweeper repo's daily
      cost for isolation the ordering already provides.
    - The constraint is PINNED, not just documented:
      `test/files.test.js`'s `EXPECTED_JOBS` table names every rendered
      workflow's exact job-id list, and the test asserts the table's key
      set equals the set of rendered `.github/workflows/` paths — so a
      new workflow cannot escape the constraint by omission, and a
      re-split fails `npm test`. That test builds the payload AS THE
      SWEEPER REPO, since the sweeper workflow is otherwise not in the
      set and would escape the constraint by being conditional. Adding
      a job means editing that table, which is the point: the edit is
      where the billing cost gets argued. Job ids are read with the file's `workflowJobIds` helper,
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
  - `sweeper-sweep.yml` is the per-org SWEEPER workflow (issue #92),
    rendered to `.github/workflows/sweep.yml` on the org's sweeper repo
    and nowhere else. It is a payload rather than a template-repo file
    because a template COPY cannot pull from its template (unrelated
    histories, no upstream), and the converger's render-PR-merge channel
    already does exactly that job. Step order is load-bearing: resolve
    `version-pin` out of `gh-repo-config.json` with `jq` (absent → the
    latest release, resolved to a concrete tag before download), fetch
    the tarball, `gh attestation verify` it, unpack, mint the converger
    App token, run the sweep. Nothing from the tarball is unpacked or
    executed before the verify passes, and the App token is minted only
    after it, so no privileged credential is live while an unverified
    archive is being handled — the same scoping rationale
    `assets-pin-bump.yml` applies to untrusted upstream text. The mint
    uses `client-id:` (secret `CONVERGER_APP_CLIENT_ID`, the App's
    Client ID — a distinct value from the numeric App ID
    `.github/workflows/sweep.yml` here still uses), never the deprecated
    `app-id:` input; `test/files.test.js` pins that, the SHA-pinning,
    and the verify-before-unpack order. The sweep's own
    `assertVersionPinSatisfied` stays the defense-in-depth re-check of
    the pin against the tarball actually fetched; this workflow's `jq`
    read is the primary enforcement. Its header's `sweeper-update-policy`
    bullets are the copy a sweeper repo's maintainer reads, so keep the
    `manual` bullet's DRAFT wording in step with `writer.ts` — a bullet
    that says only "the merge pass refuses to merge it" understates the
    hold and invites someone to remove the draft half — and keep the
    release half on BOTH the `auto` and the `off` bullet, which is the
    only warning a maintainer gets that hand-drafting a converger PR
    does not hold it under either policy.
  This repo's own `.github/actions/`, `.github/scripts/`, and
  `.github/workflows/` — the
  live copies the sweep renders onto this repo itself — are **not**
  hand-maintained: they converge on their own when the fanout sweep
  runs over this repo, the same way it converges every other managed
  repo. The authoritative payload is always the file under `assets/`;
  the live copy is an output of the sweep and must never be hand-
  edited to match it.
  Separately, this repo's own root `CONTRIBUTORS`, `LICENSE`,
  `PATENTS`, and `PRIOR_ART.md` are just that — this repo's own. They
  are NOT copied into `assets/` and are not what managed repos receive:
  the seed-if-absent community payload every managed repo gets is the
  target org's own copy of each, read from the org's `.github` repo at
  sweep time (issue #90; see `files.ts`'s `COMMUNITY_FILES` and
  `community.ts`). `assets/` is packed into the release tarball
  (`.github/workflows/release.yml`) alongside `dist`/`bin`/
  `package.json`.
- `bin/gh-repo-config.js` — CLI entry point (`package.json` `bin`).
  Subcommands: `version` (default) and `sweep` (reads
  `GH_REPO_CONFIG_ORG` / `GH_REPO_CONFIG_TOKEN` /
  `GH_REPO_CONFIG_APP_SLUG` / optional `GH_REPO_CONFIG_DRY_RUN` /
  optional `GH_REPO_CONFIG_FILE` / optional
  `GH_REPO_CONFIG_SWEEPER_REPO` from
  the environment; exits non-zero when any repo's convergence or stamp
  write failed, so a scheduled sweep run cannot fail silently). It
  exits non-zero on one further condition (issues #67, #68): a
  `SweepReport.defaultModeProvenance` of `not-defined` or
  `defined-no-value`, meaning `gh-repo-config-mode` declares no
  `default_value` and every repo without a value of its own fell back to
  the fail-safe `opt-out`. That check is
  `describeDefaultModeProvenanceFailure` in `src/sweep.ts` — the decision
  lives there, not in the CLI, so it is unit-testable without spawning
  the CLI against the live API — and the full tick still runs before it
  fires. The sweep summary also prints each repo's CodeQL default-setup
  and `protect-main` ruleset outcomes, plus any ruleset-deferred repos.
  Its counts split `SweepReport.awaitingChecks` in two (issue #92): the
  `awaiting-human` entries are counted as "held for a human" and
  subtracted from the "awaiting checks" count, because a held PR waits
  on a person rather than on a check. `awaitingChecks` is the one
  bucket on the report for both, so the split lives here — a summary
  calling a held PR "awaiting checks" reads as a transient state an
  operator can wait out, which it is not.
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
  `AUTOMERGE_APP_PRIVATE_KEY` secrets (the same PR-operations App
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
  (`gh-repo-config-mode`, `gh-repo-config-version`) — an
  operator-provisioning step, not something the workflow itself
  creates. `gh-repo-config-mode` must be `required: true` with a schema
  `default_value`, since GitHub rejects a default on an optional
  property; a mode property that is undefined, or defined without a
  default, fails the run loudly (issues #67, #68, see
  `bin/gh-repo-config.js`) rather than reading as a quiet
  all-unmanaged tick. Surfacing the effective value on every repo's
  custom-properties display is the accepted cost of that; it is a
  display of an INHERITED value, not a value written onto the repo —
  GitHub recomputes inheritance when the schema `default_value` changes,
  and an explicit per-repo value survives such a change independently, so
  changing the default converts exactly the repos carrying no value of
  their own. `docs/repo-selection.md` records the probe that measured
  this, under "Truth table". Also passes
  `GH_REPO_CONFIG_APP_SLUG` (read from the token-mint step's own
  `app-slug` output, not a separate secret) so the merge pass can
  match `user.login === "<slug>[bot]"` and never merge a PR authored
  by anyone else. It sets neither `GH_REPO_CONFIG_FILE` nor
  `GH_REPO_CONFIG_SWEEPER_REPO` (issue #91): this repo is not a
  per-org sweeper repo, so its own sweep runs on the baked defaults.
  No repo is therefore the sweeper on its ticks, which is also why the
  issue-#92 sweeper-workflow payload never lands on any repo this
  workflow converges. A sweeper repo's own copy of this concern is
  `assets/sweeper-sweep.yml`, which is a payload and renders to THIS
  FILE'S OWN PATH (`SWEEPER_WORKFLOW_PATH`). So unlike `ci.yml`,
  `pin-shape.yml`, and `assets-pin-bump.yml`, this hand-maintained file
  is NOT protected by having no `assets/` counterpart — it is protected
  only by the sweeper-repo condition, which holds because this repo
  names no sweeper. Setting `GH_REPO_CONFIG_SWEEPER_REPO` to this repo
  would have the payload converge over this file.

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
  parser is ever warranted. Throwaway scratch under
  `.claude/tmp/<task slug>/` is the one place it may be imported, and
  is its best use here: a real parse is the oracle a hand-rolled YAML
  helper gets cross-checked against. The hoisted version is
  ESM-with-named-exports-only, so `import yaml from "js-yaml"` throws
  `does not provide an export named 'default'` and the import must be
  `import * as yaml`.
- A claim in prose or a doc comment about a package's presence,
  dependents, version, or export shape is checked only after `npm ci`.
  A subagent worktree starts with no `node_modules`, and the primary
  clone often carries prod deps only, so `npm ls <pkg>` answers
  `(empty)` for every dev-tree package — which reads as evidence the
  package is absent and is not. Cite `package-lock.json` and the
  pinned version in the prose itself, since that file is present
  whatever the install state, and settle an export-shape claim
  empirically (`node --input-type=module -e "import ..."`).
- A claim about how long something lasted, or about a date range, is
  settled against `git log` before it stands. Duration prose
  ("a months-long outage", "broken since the first release") is a
  structural claim with no test behind it: no suite fails when the
  described behaviour is right and only the span is invented. Check it
  with `git log --diff-filter=A -- <the file that introduced the
  behaviour>` plus whatever dated record exists, and write the dated
  fact a reader can re-check rather than the span.
- A claim that some workflow pass "also pushes to" or "also rebases" a
  given branch or PR is settled against that pass's CANDIDATE
  SELECTION, not against the presence of a `git push` in its body. Two
  passes in the same job share an identity and a push while selecting
  disjoint PR sets — the `author.login == "dependabot"` filter
  described under `.github/workflows/assets-pin-bump.yml` above is the
  live instance. Read the pass's `select(...)` chain and the target
  PR's author before such a sentence stands, especially when the
  sentence is authored in the same commit as the code it describes:
  the guard's described BEHAVIOUR can be correct while the stated
  REASON is false, and no test catches that.
- A sentence naming a test, lint rule, ruleset, or CI gate as the
  reason a narrower implementation is safe stands only after that
  guarantee is opened and run against the value the narrow
  implementation mishandles. The name is not the contract: a test
  called `semver-shaped` whose regex is unanchored accepts
  `0.3.0-rc.1`, the exact value a core-only version compare cannot
  survive. Prefer prose that states the rejection positively ("a
  prerelease fails `npm test`") over prose that states a shape
  passively ("is pinned to `X.Y.Z`"), since the positive form is
  falsifiable in one command; when the guarantee turns out not to
  hold, strengthening it is the fix and the prose then becomes true.
- A claim that behaviour is "identical across all arms" of a
  discriminated union is settled against the consumer that reads the
  union, not accepted. The usual shape is that one arm carries a
  payload and the rest collapse to a fallback, so the collapsing arms
  resolve alike while the payload arm can resolve either way — the
  ternary at the call site is the answer, and the tests pin the
  resolution without asserting any sentence about it. State the
  narrower true thing: the discriminant never decides on its own.
- A test's TITLE is prose describing the code, and is checked against
  the fixture in its own body whenever a diff renames a vocabulary or
  inverts a meaning. A flipped fixture under an unflipped title leaves
  every test passing and the title false; no suite can catch it. Grep
  the changed test files for the retired token and for the old sense.
- A fact about GitHub's API established by running something rather
  than by reading GitHub's documentation ships with the experiment
  that established it: the exact `gh api` calls, the org and date they
  ran on, and what each returned, as copy-pasteable commands with real
  values inlined. A conclusion with no probe beside it cannot be
  re-checked once the API's behaviour changes.
- A structural change — a job shape, a file move, a renamed export —
  is swept for prose it falsified by grepping the RETIRED term across
  the whole repo (`--exclude-dir=node_modules --exclude-dir=dist`),
  not by re-reading the files in the diff: the prose the diff
  falsified is mostly in files the diff never touched, such as a doc
  comment in `src/` describing a workflow's job shape. Triage each
  hit — historical narration ("this workflow USED TO be…") stays, a
  present-tense claim is a defect, and a design record carrying a
  status marker is never a hit at all (see this file's opening
  section). Fixing an out-of-diff one-line comment is in scope; a
  refactor is not.
- When a later commit on a PR downgrades a claim about external
  behaviour to "unsettled" or "unverified", the earlier prose still
  asserting it as fact is now false, including paragraphs earlier in
  the same file. On a re-run over a PR that already carries doc
  commits, read the newest commits first, take the term each hedge is
  about, and grep the repo for the unhedged form: the newest statement
  is the researched one and the earlier one is what gets corrected.
- A finding of the form "this assertion passes by coincidence" is
  discharged by watching the replacement FAIL on the input it exists
  to reject, not by watching the suite stay green — green proves only
  that the assertion accepts the current input. Feed it the pre-change
  shape (`git show origin/main:<path>`) from a scratch `.mjs` under
  `.claude/tmp/<task slug>/` rather than by editing the payload;
  editing gitignored `dist/` to introduce the bug is fine, since
  `npm run build` restores it. Cross-check any hand-rolled parser
  against a real parse of the same input, and prefer asserting the
  exact expected VALUE over a count — a leaked entry names itself in
  the failure message, where a count only says `2 !== 1`.
- A test fixture standing in for a real runtime value is chosen so it
  can never coincide with that value — `9.9.9` for a version that only
  moves up — and a change that makes the two equal is a defect closed
  in the same PR, not a trap reported for later. Replacing the literal
  with the symbolic constant beats editing two literals. Sweep every
  sibling test for the same constant, and keep the report honest about
  which instances were load-bearing: load-bearing means a code path
  can reach the real value on its own, as `runSweep`'s `version`
  parameter does by defaulting to `CURRENT_VERSION`, where `decideRepo`
  and `OrgPropertiesClient.stampVersion` take it as a required
  argument and cannot.
- Replacing a hardcoded enumeration with a mechanism driven by the
  canonical source is not done until the enclosing SELECTOR has been
  checked for the same hardcoding: whatever picks the things now being
  looped over is usually hardcoded by the same author in the same
  style. Grep the changed function for any remaining string literal
  naming a member of the canonical asset, and ask whether that asset
  could grow a member the literal would miss. The prose describing the
  mechanism is rewritten at both levels, not just the inner one.
- An issue's acceptance criteria are a description of intent, not a
  contract that outranks correctness. When a review finding shows an
  AC or a Design section encodes the wrong design, implement the
  single correct mechanism and update the issue body to match — never
  keep the old mechanism alongside the new one so the criterion's
  literal wording stays true. Reconcile against every AC on the live
  issue, not only the ones the finding names.
- A Bash call this repo's agents make against git must be statically
  simple, or the harness refuses it before anything runs. `git -C
  <path> <cmd>` is refused outright, a single call chaining several
  `cd`/`git` steps is refused as too complex to prove it stays inside
  the worktree, and so is a heredoc redirect into a repo file — the
  classification is static, so it cannot prove the target of a dynamic
  token and declines instead of guessing. The moves that pass: put a
  multi-step git sequence in a `.sh` file under `.claude/tmp/<task
  slug>/` and run `bash <abs path>`, which does its own `cd`; write a
  commit message to a file and use `git commit -F <file>` instead of
  `git commit -m "$(cat <<'EOF' … EOF)"`; and edit a repo file with
  `Edit` or `Write` rather than a shell redirect. A refused call
  executes none of its parts, so re-stage anything a blocked
  `git add` was chained to. The refusal text for `git -C` suggests a
  bare `cd` in a prior call, which does not help a subagent: a
  subagent's cwd resets between Bash calls.
- The same static classification refuses non-git Bash calls, so it is
  not a git rule with a wider reach. A call carrying output
  redirection, a heredoc, or a `for`/`while` loop is refused whatever
  binary it runs, because the classifier cannot prove where the write
  lands; `sed -i '' -e … <file>` is refused separately, its empty
  BSD backup suffix being parsed as a path that "resolves outside the
  current repository". Edit repo files with `Edit`/`Write`, which are
  worktree-anchored and never refused, and when a mechanical pass
  really is the right tool, `Write` it to a `.py`/`.sh` under
  `.claude/tmp/<task slug>/` and invoke the single static command
  `python3 <abs path>` / `bash <abs path>`. A plain
  `cmd > <abs path inside the worktree>` with no other shell structure
  does pass, as do `|`-pipelines and `&&` chains of non-git commands.
  Run the suite after any mechanical retokenization: it misses value
  assertions whose key was renamed separately.
- `cp` is wrapped interactively in the shell the harness starts, and
  `cp -f` does not defeat the wrapper. Overwriting an existing file
  prints `overwrite <path>? (y/n [n]) not overwritten` and the `&&`
  chain after it stops — the prompt is unanswerable, since the Bash
  tool supplies no stdin. This bites on the restore leg of a mutation
  check, where a half-done restore leaves a deliberately corrupted
  file in the worktree that is easy to commit by accident. Restore
  with `/bin/cp -f <bak> <dst>`, or with a command that writes rather
  than copies, and confirm with `git status --porcelain`.
- A leftover sibling worktree can hold this repo's branch claim, so
  `git checkout <branch>` fails with `already used by worktree at
  .claude/worktrees/agent-<other>` — the cleanup step of an agent that
  died never ran. Neither escalate nor delete another agent's
  worktree. Inspect it with a bare `git worktree list` from your own,
  confirm `git rev-parse origin/<branch>` equals that HEAD so no
  unpushed work is at risk, then `git checkout --detach <tip>` and
  push with an explicit refspec, `git push origin
  HEAD:refs/heads/<branch>`, which claims the branch at no point and
  so leaves the end-of-run cleanup nothing to release.
- A `git push` here intermittently dies with `ssh: connect to host
  github.com port 22: Operation timed out`. It is a connection that
  never opened, not an authentication failure, and the message's
  trailing "make sure you have the correct access rights" invites the
  credential-surfaces stop-and-report path wrongly. Re-run the
  identical push a couple of times, changing nothing about the remote,
  the URL, or the credential agent, and escalate only if every retry
  times out.
- A subagent working in a worktree anchors every absolute path to
  `git rev-parse --show-toplevel`, never to the primary clone's path
  under `Workspaces/`. An `Edit` against the primary-clone path is
  refused outright with a message naming the worktree, so it fails
  loudly. A `Read` against it does not: it can return the file as the
  PRIMARY CLONE has it — `main`'s text, with the branch's own
  additions missing — which reads exactly like "the branch does not
  contain that change" and invites re-adding what the branch already
  carries. When a `Read` disagrees with a `grep` of the same file,
  believe the `grep`, and re-read through the worktree-rooted path.

## `js-yaml` is available here, but undeclared

`package.json` declares exactly three devDependencies (`@types/node`,
`markdownlint-cli2`, `typescript`) and zero runtime dependencies.
`js-yaml` nonetheless resolves from `node_modules` after `npm ci` —
`npm ls js-yaml` shows one path only, `markdownlint-cli2 -> js-yaml`.

**Why it matters:** "available from node_modules" and "safe to import
from committed code" are different claims. `npm test` backs the
`ci-required` status check, so importing an undeclared transitive dep
there couples a required check to another package's dependency graph. A
markdownlint-cli2 bump that drops js-yaml, or moves it to a major with a
different export shape, reddens `ci-required` on an unrelated PR. The
export shape is a live hazard, not hypothetical: the version hoisted
there is ESM-with-named-exports-only, so `import yaml from "js-yaml"`
throws `does not provide an export named 'default'` and you need
`import * as yaml`. Adding it as a declared dep is not an option for a
subagent either — that is `npm install <pkg>`, forbidden by
`rules/install-discipline.md`.

**How to apply:** use it freely in throwaway scratch under
`.claude/tmp/<slug>/` — including as the oracle a hand-rolled parser is
cross-checked against, which is its best use here (see the
"assertion passes by coincidence" bullet under Conventions). Do not
import it from
`test/`, `src/`, or `assets/` — CLAUDE.md's Conventions section carries
that rule for the repo as a whole. When a review finding recommends a
dependency as "reported to be available", run `npm ls <pkg>` before
using it and report which kind of available it turned out to be:
"resolves from `node_modules`" and "declared" are separate claims, and
recall is not evidence for either.
