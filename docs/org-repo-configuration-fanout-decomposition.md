# Org-Wide Repo-Configuration Fan-Out — Implementation Decomposition

Status: proposed issue breakdown. Authored 2026-07-13. Companion to
`org-repo-configuration-fanout-design.md` (the design). This document
resolves every open design decision to a concrete instruction, pins the
extraction boundary, records concrete source pointers, and proposes the
issue tree. **No item below is left as an open decision** — an issue is
only fileable once its body is an instruction, not a question.

## Ground-truth source pointers

The two skills the converger is extracted from are **single-file
skills** — their payloads (`*.sh`, `*.yml`) are embedded inline in the
SKILL.md as heredoc/fenced blocks, not separate files on disk. An
implementer must read the SKILL.md to recover them.

- Plugin: `github-setup`, in the **`claude-plugins-marketplace`** repo
  under this org.
- On this machine (marketplace checkout / plugin cache):
  `~/.claude/plugins/marketplaces/thevoskamps/plugins/github-setup/skills/`
- `gh-repo-setup-protection/SKILL.md` — ~130 KB, Steps 0–7.
- `gh-repo-setup-pr-automation/SKILL.md` — ~47 KB, Steps 0–8.
- Shared helpers: `github-setup/skills/lib/`.

Consuming/target repo (this repo): `TheVoskamps/gh-repo-config`
(private today; design calls for public before first relied-on release).

## Resolved decisions (the load-bearing five + follow-ons)

These replace the design's Open Items and my earlier "open questions."
Each is a settled instruction.

1. **Write-path: always branch + PR to `main`.** The core never pushes
   to `main` directly. It works on a branch and opens a PR — the same
   shape the skills use today, made deterministic. Once a repo has
   protection on, PR-to-`main` is the only way in, so first-run and
   every re-converge are uniform. **Merging that PR is the converger's
   own job** (#24): the converger App is a `pull_request` bypass actor
   in `protect-main`, and each sweep pass REST-merges open converger
   PRs whose required checks are all green — a red check leaves the PR
   open as the escalation path. It cannot be the rendered
   pr-automation workflows' job: on a newly-managed repo the first
   converger PR is the one that installs those workflows, and
   `workflow_run` / `schedule` triggers only run from the default
   branch, so the bootstrap PR would wait forever.

2. **All ecosystems, unconditionally — no confirmation.** Drop the
   protection skill's Step 2b `AskUserQuestion` ecosystem tabs entirely.
   Set up every ecosystem's gates (install-gate, pinned-gate,
   dependabot ecosystems) for every repo. A gate for an absent ecosystem
   runs, finds nothing, and passes green. This deletes the
   "detection is a proposal, not a verdict" problem — there is no
   proposal. `ResolvedConfig` carries **no** ecosystem toggle set, and
   `detect/` shrinks to near-nothing.

3. **CodeQL: advanced on, default/basic off — unconditionally.** Drop
   the entire opt-in apparatus (the `--codeql` override, the
   #91/#230 phantom-check decision logic). Every repo gets advanced
   CodeQL setup asserted on and default setup asserted off. Server state
   is still read, but only to converge to that fixed target, never to
   decide whether to act. `ResolvedConfig` carries **no** CodeQL flag.

4. **CI identity: a new dedicated converger org GitHub App.** The
   existing PR-automation App must **not** gain repo/org administration
   scope. Provision a separate least-privilege org App (via the
   `gh-create-app` skill) whose permissions are exactly the converger's
   call surface (table below). Interactive skill runs continue under the
   operator's own org-admin `gh` auth; only the CI fan-out uses the App.

5. **This repo is just another fan-out target.** First-run authoring of
   any repo (including this one) stays the interactive skills:
   `/repo-config`, `/gh-repo-setup-protection`,
   `/gh-repo-setup-pr-automation`, and optionally `/gh-repo-setup-public`
   (which wraps the two; often run separately to sit on a repo before
   going public). Once the fan-out exists, this repo is tagged/stamped
   like every other repo and the scheduled fan-out re-converges it to
   org standard on drift. No special "self-hosting" concept.

**Follow-on, also settled — the fan-out trigger is the scheduled
sweep.** There is no separate on-repo-create webhook path. The scheduled
Action lists org repos, finds any whose stamp is missing or behind the
current release, and converges them. A newly-created repo is simply an
unstamped repo the next sweep picks up. One mechanism, not two — same
"don't build a special case" logic as decisions 2 and 3.

**Follow-on, also settled — community/governance files are copied
per-repo from the consuming org's own `.github` repo, not inherited.**
GitHub's org `.github` *inheritance* is display-time fallback: the files
are never in the tree, so they evaporate on clone, fork, or mirror (the
same reason LICENSE must always be a real per-repo file). That is the
wrong treatment for governance documents, which a consumer of the repo
needs to actually *have*. So the converger treats the org `.github` repo
as a **content source it reads from** and materializes those files into
each target repo's tree — the delivery GitHub inheritance should have
been. Because the source is the *consuming* org's `.github` (not
gh-repo-config's release payload), each org propagates its own identity
content; the shared release carries only machinery, never one org's
CONTRIBUTING/SECURITY text. Settled behavior:

- **Source set** — whatever files exist in `<org>/.github` *are* the set
  to propagate. The org curates `.github`; the converger mirrors it. No
  hardcoded file list.
- **Semantics** — seed-if-absent. Never stomp a target repo's own copy
  of a community/governance file (or its LICENSE) if it has one
  deliberately.
- **Missing/empty `.github`** — skip-and-report; converge everything
  else (same posture as the entitlement-422 handling).
- **Prerequisite** — seeding `<org>/.github` itself is a documented
  manual step (swipe from `macos-setup` / `claude-config` /
  `claude-plugins-marketplace`, which should all match). The converger
  App needs **Contents: read** on `.github` and must be installed there.

## Converger App — permission set (concrete, for the org-ruleset skill + CI fan-out)

Derived from the actual REST/CLI calls the two skills make (protection
Steps 4/6, plus stamping and branch/PR write; pr-automation makes no
`orgs/`/`repos/` REST calls and its `gh secret` step is **skipped** in
fan-out mode since the App identity is already an org secret).

| Call surface | App permission |
| --- | --- |
| `PATCH repos/{o}/{r}` — merge-button + `security_and_analysis` (secret scanning, push protection) | Administration: **write** |
| `PUT .../vulnerability-alerts`, `.../automated-security-fixes` | Administration: **write** |
| `PATCH .../code-scanning/default-setup` (default off) | Code scanning / repo code-security: **write** |
| `POST`/`PUT repos/{o}/{r}/rulesets` (repo protect-main) | Administration: **write** (repo rulesets) |
| `POST orgs/{org}/rulesets` (org `~ALL` ruleset) | Organization administration: **write** |
| branch push + PR for rendered `.github/` files | Contents: **write**, Pull requests: **write** |
| rendered `.github/workflows/*` | Workflows: **write** |
| org custom-property read/write — selection + stamp (batch ≤30) | Organization custom properties: **write** |
| read the org's `<org>/.github` community files to copy per-repo | Contents: **read** (App installed on `.github`) |
| list own open PRs, read required checks, REST-merge green ones | Pull requests: **write** (already held via the render row above) |

This set is visibly broader than the PR-automation App (Contents / PR /
Workflows / Actions only) — it holds Administration and Org
administration / custom-properties — which is exactly why it is a
**separate** App (decision 4).

## Repo selection model (the sweep's control plane)

Which repos the sweep touches is a pure function of **three org custom
properties**, all read in the one paginated
`GET /orgs/{org}/properties/values` call the sweep already makes:

- **`gh-repo-config-mode`** (per-repo override): `process` | `ignore` |
  unset.
- **`gh-repo-config-default`** (org-level default for *unset* repos):
  `opt-in` | `opt-out`.
- **`gh-repo-config-version`** (the stamp): the release version last
  applied to this repo. Separate from mode — "should I manage this" and
  "what version is it at" are different questions, and conflating them
  loses the "managed but never yet converged" state.

**Precedence** (resolve managed-or-not first, then version-skip):

1. Per-repo flag beats the org default. **`ignore` beats `process`** if
   both are set — fail safe, when in doubt don't touch.
2. Unset repo follows the org default: `opt-in` ⇒ skip, `opt-out` ⇒
   process.
3. A managed repo is converged only if its stamp is missing or behind
   the current release; otherwise skipped.

This gives both operating modes from **one org-level setting**:

- **Testing / early** — default `opt-in`; flag only the throwaway test
  repo `process`. Nothing else can be touched.
- **Steady state** — flip default to `opt-out`; every repo (incl.
  brand-new) is converged automatically; flag the rare exception
  `ignore`. The flip is one property change, not a re-flag of every repo.
- **Kill switch** — default `opt-in` with no `process` flags anywhere is
  "ignore all", for free (no separate mechanism).

## Extraction boundary

Verified against the actual SKILL.md section structure. Steps split into
a **deterministic core** (moves to TS) and an **interactive shell**
(stays in the skill, calls the core). Decisions 2 and 3 remove the two
biggest shell surfaces (Step 2b and CodeQL opt-in), so the shell is now
thin.

### `gh-repo-setup-protection`

| Step | Disposition |
| --- | --- |
| 0 Payload (`*.sh`/`*.yml`) | **Core** — bundled `assets/` |
| 1 Pre-flight (repo/auth/identifiers) | **Core** |
| 2 Ecosystem detection | **Core**, reduced — all ecosystems on, so detection no longer gates anything (kept only if any dependabot entry needs per-ecosystem rendering) |
| ~~2b Operator confirmation~~ | **Removed** (decision 2) |
| 3 Render+converge `dependabot.yml` | **Core** |
| 4 GHAS/security toggles (4a–4e) | **Core** — the API mutation sequence |
| 5 CodeQL | **Core** — assert advanced on / default off (decision 3); no opt-in shell |
| 5a Read server CodeQL mode | **Core** (converge target, not decision input) |
| 5b Render+converge CodeQL workflow | **Core** — always rendered |
| 5c / 5c-pinned / 5d gates + guard | **Core** — all ecosystems, unconditional |
| 6 `protect-main` ruleset (6a–6d) | **Core** |
| 7 Commit/push/PR | **Shell** (interactive approval) / **Core** (CI: branch+PR, no halt) |

### `gh-repo-setup-pr-automation`

| Step | Disposition |
| --- | --- |
| 0 Payload | **Core** — bundled assets |
| 1 Pre-flight | **Core** |
| 2 Env-inferred placeholders | **Core** |
| 3 Resolve GitHub App | **Shell** (first-run); CI consumes the App secret |
| 4 Resolve remaining placeholders | **Core** — every value is a fixed constant of the converged standard (no per-repo detection; the skill's conditional-drop logic never applies to a managed repo) |
| 5 Halt #1 — confirm | **Shell** interactive; no halt in CI |
| 6 Render+write workflow files | **Core** |
| 6b Commit/push/PR | **Shell** / CI split as protection Step 7 |
| 7 Set App-identity secrets | **Shell** first-run; **skipped** in fan-out |
| 8 Next-steps checklist | **Shell** only |

### The boundary, stated once

The **core** takes a **`ResolvedConfig`** (org, repo, App-secret refs,
merge-method, release version to stamp — and *nothing else*, since
ecosystems and CodeQL are unconditional) plus live remote state, and is
a pure function of it: detect (minimal) → read state → render templates
→ converge files → run the API mutation sequence → converge the ruleset
→ open the branch+PR → stamp. It **never prompts**.

The **shell** (interactive skill) resolves first-run-only bits (App
identity) and the commit/PR approval gate, then calls the core. The
**CI fan-out** builds `ResolvedConfig` non-interactively and calls the
identical core. Same code, no divergence — the design's point.

## Converger shape

TypeScript, matching the all-TS stack. Proposed layout:

```text
src/
  config/        ResolvedConfig type + zod schema (the core's input contract)
  detect/        minimal: CodeQL server-mode read; ecosystem probe only if dependabot rendering needs it
  render/        template loader + __PLACEHOLDER__ substitution; assets under assets/
  converge/
    files.ts       whole-file render-then-write-if-changed; branch + PR (Steps 3, 5b–5d, pr-auto 6, 7)
    ghas.ts        read-then-PATCH GHAS + merge-button toggles (Step 4) + CodeQL default-off (5)
    ruleset.ts     protect-main create/converge (Step 6) + org-ruleset detection
    community.ts   copy <org>/.github community files into the target repo (seed-if-absent)
  stamp/         org custom-property read/write (batch ≤30), self-currency check
  github/        REST client wrapper (App-token auth in CI, gh auth interactively; pagination; -i status+body parse)
  index.ts       converge(config, {mode: 'interactive'|'ci'}) entry point
assets/          extracted *.sh / *.yml payloads, verbatim
bin/             CI entry: read release, resolve config, converge, stamp
test/
```

Entry: `converge(config: ResolvedConfig, opts): Promise<ConvergeReport>`.
`ConvergeReport` lists per-concern changed / already-converged /
skipped-and-why (feeds the skill summary and CI logs).

Idempotency + error behavior (decided, not deferred): every step is
read-then-write-if-differs; a failed step reports and continues to the
next independent concern rather than aborting (partial convergence is
re-runnable). Entitlement 422s (GHAS on unentitled private repos) are
report-and-skip, as the skills do today.

## Stamp granularity

**One stamp per release** (`gh-repo-config-version`), not per-concern.
Protection and pr-automation ship from the same repo and release tag and
do not version independently. Revisit only if the concerns ever split
release cadence.

## Proposed issue tree

Scoped to **making it work for TheVoskamps first**; Fablegate /
StationWorks rollout is deferred and not filed. Filing rules (per
operator):

- Every issue lives in the repo where the work happens.
- Structure is **one parent Feature + sub-issues**, no "epic" tier; size
  by the **Effort** field; order by **blocked-by** edges.
- GitHub sub-issue containment is **same-repo only**. Cross-repo
  dependency is expressed with **blocked-by** edges, not sub-issue nesting.
  So the marketplace work gets its own **umbrella Feature** in that repo
  (its refactors nest under it there), and the umbrella carries the
  cross-repo blocked-by edges to this repo's core. A parent with open
  sub-issues does not auto-close, so the umbrella stays open until its
  refactors close.

The spine is **vertical slices**: each issue ends in something that
testably runs against a real repo (or the release / a custom property),
not a code layer. Ordering follows "prove the control plane first, then
add one convergence at a time" — selection + version-skip come *before*
any convergence, because getting *which repos we touch* right matters
more than *what we do to them*, and because the version bump is the test
harness for every later slice.

### Test fixtures you (the operator) stand up by hand

The converger never creates repos (no repo-creation scope on the App).
Create these throwaway fixtures under TheVoskamps once; the convergence
slices target them. Keep them out of the real steady-state sweep — either
flag each `gh-repo-config-mode: ignore` and have the tests target them
directly, or keep the org default at `opt-in` during development so only
an explicitly-`process`-flagged fixture is ever touched.

- A **plain** repo flagged `process` — the main convergence target.
- A **private** repo — exercises the GHAS entitlement-422 skip path.
- A repo **with its own** community files — exercises seed-if-absent
  *not* overwriting.
- A repo flagged **`ignore`** — exercises selection exclusion.
- `TheVoskamps/.github` seeded with community files — the copy *source*.

### Tree A — `TheVoskamps/gh-repo-config` (the converger)

- **Parent Feature: Org-wide repo-configuration fan-out** — body links
  the design + this decomposition; the sub-issues below nest under it.

- **1. Release/versioning mechanism** (filed: #12, done) — build the
  converger, publish as an immutable release asset + attestation, enable
  release immutability; expose a readable "current version." Feature.
  Medium. *First — every skip-by-version check needs versions to compare
  against.* Testable: `gh release view`, `gh attestation verify`.
- **2. Selection-loop walking skeleton** (filed: #13, done) — the
  scheduled **+ `workflow_dispatch`** (manual) sweep, running as the
  converger App: reads the three selection properties, applies the
  precedence table, version-skips managed repos, stamps processed ones.
  Convergence is a stub (log / no-op). Feature. High. blocked-by 1.
  **Prereq in body, not a ticket:** provision the converger org App via
  user-scoped `gh-create-app` with the "Converger App" permission set
  (incl. Contents: read on `.github`); install on TheVoskamps +
  `.github`; store App ID + private key as org secrets. Testable: flag a
  fixture `process`/`ignore`, flip the org default, bump the version,
  manual-dispatch → watch it pick / skip / stamp correctly.
- **2b. Sweep merges green converger PRs** (filed: #24) — the merge
  pass per decision 1: each sweep tick, REST-merge open converger-App
  PRs whose required checks are all green (bypass-actor merge); red or
  pending checks leave the PR open and reported, not failed. Runs for
  every managed repo independent of the version-skip. Feature. Medium.
  blocked-by 2 only — lands before or alongside the convergence slices
  so their PRs self-merge. Testable: fixture with a green converger PR
  → dispatch → merged; red-check PR → left open + reported.
- **3. Converge `dependabot.yml` + gates/guards** (filed: #14) — first
  real teeth; extract the protection skill's payloads to `assets/`
  verbatim; establish the render pipeline (placeholder substitution,
  whole-file write-if-changed, one shared work branch + PR per repo per
  run). Feature. High. blocked-by 2. Testable: bump version, dispatch →
  PR shows the files; re-dispatch at same version → skipped.
- **3b. Converge pr-automation workflows + scripts** (filed: #25) —
  feed the pr-automation payloads (auto-merge enablement incl.
  Dependabot REST-merge, auto-rebase + `/rebase`, lockfile-regen
  scripts) through slice 3's pipeline; all placeholders are fixed
  constants of the standard. Feature. Medium. blocked-by 3 (the
  pipeline). Testable: dispatch → both workflows + both scripts in the
  fixture's PR, zero unresolved placeholders; re-dispatch → skipped.
- **4. Converge GHAS + merge-button settings** (filed: #15). Feature.
  High. blocked-by 2. Testable: dispatch → toggles flip on the
  fixture; re-dispatch → no-op; private fixture → 422 skip-and-report.
- **5. Converge protect-main ruleset** (filed: #16) — + org-ruleset
  detection, and the `pull_request` **bypass actors** as part of the
  converged shape: the AUTOMERGE App and the converger App, whenever
  the App exists in the org. Feature. Medium. blocked-by 2. Testable:
  dispatch → ruleset appears with both bypass actors; re-dispatch →
  converged.
- **6. Converge CodeQL** (filed: #17, absorbed into #16's PR — delivered
  together with slice 5 rather than as a separate PR) — advanced setup
  on, default off, plus the workflow. Feature. Medium. blocked-by 2.
  (The CodeQL server-mode read lives here, where it's used — not a
  standalone module.) Testable: dispatch → workflow in PR, default-setup
  off server-side.
- **7. Copy community files from `<org>/.github`** (filed: #18) —
  seed-if-absent, skip-and-report if `.github` missing/empty. Feature.
  Medium. blocked-by 2. Testable: dispatch → the org's
  CONTRIBUTING/SECURITY land in a bare fixture's PR; the with-own-files
  fixture keeps its own.

Slices 2b and 3–7 are parallel-safe after 2 (distinct concerns,
distinct files); 3b follows 3. They share one test recipe: bump the
release version, manual-dispatch, confirm the new thing converges *and*
that a second run at that version skips.

### Tree B — `TheVoskamps/claude-plugins-marketplace` (the skills)

- **Umbrella Feature: Wire the setup skills onto the converger core** —
  its three refactors nest under it here; the umbrella carries the
  cross-repo blocked-by edges to Tree A's core issues, and references
  Tree A's parent by URL.

- **Refactor `gh-repo-setup-protection` to a thin wrapper** — in a
  fan-out-enabled org, converging one repo interactively means: assert
  the repo's selection property (`gh-repo-config-mode: process`) and
  trigger a sweep run, then report the PR the sweep opens. Invoking the
  core locally remains only as the bootstrap path (orgs without the
  fan-out; the converger repo itself). The skill keeps first-run-only
  surfaces (App resolution, approval halts) and sheds its convergence
  logic entirely — smaller than the originally-planned
  steps-to-the-core refactor. Feature. High. blocked-by Tree A slices
  3–6 (all convergence).
- **Refactor `gh-repo-setup-pr-automation` to a thin wrapper** — same
  shape: assert the selection property + trigger a sweep; local-core
  path for bootstrap orgs only; the Step 7 secret-set stays first-run
  interactive. Feature. Medium. blocked-by Tree A slice 3b (the
  pr-automation convergence, #25) — not slice 3.
- **New skill `gh-org-setup-protection-ruleset`** — org-level
  protect-main at `~ALL` (`POST /orgs/{org}/rulesets`); teach the repo
  skill to delete the redundant repo-level copy when an org ruleset
  governs. Feature. Medium. blocked-by Tree A slice 5 (ruleset).

### Not filed (deferred / not an issue)

- **Fablegate + StationWorks rollout** — deferred until TheVoskamps
  works end-to-end.
- **Org `.github` community-file *inheritance*** — killed; replaced by
  the converger's community-file copy (Tree A). `<org>/.github` is a
  content source the converger reads, seeded manually.
- **App provisioning** — an operational step (user-scoped
  `gh-create-app`, runs anywhere), a body-note on slice 2 (the walking
  skeleton, the first slice that runs as the App), not a source
  deliverable.

## Orchestratability

Slices 2b and 3–7 are the clean parallel-safe set for
`/sdlc:orchestrate` once slices 1–2 (release + walking skeleton) land:
distinct concerns, distinct files under `src/`, no logical
inter-dependency, all blocked only by slice 2. Slice 3b joins the pool
once 3 lands. Slices 1–2 are
first-implementation work that establishes the release, the App, and the
sweep — better done as one foreground pass than fanned out. Tree B's
refactors edit `claude-plugins-marketplace`, out of a `gh-repo-config`
`issue-developer`'s single-repo worktree scope, so they are filed and
orchestrated against that repo, gated by cross-repo `blocked-by` edges to
Tree A's slices.
