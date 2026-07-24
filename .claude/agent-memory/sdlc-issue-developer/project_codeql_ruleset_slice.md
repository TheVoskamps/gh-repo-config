---
name: project-codeql-ruleset-slice
description: CodeQL + protect-main ruleset convergence design decisions — where the converger's ruleset/default-setup behavior deviates from the upstream github-setup skill model, and the ordering-gate model.
metadata:
  type: project
---

The converger's protection-convergence surface covers CodeQL file
convergence, server-side CodeQL default-setup off, and the
`protect-main` ruleset (part of fan-out [[project-fanout-slices]]).

**Where the converger DEVIATES from the interactive skill model
(non-obvious):**

- **Default-setup**: the interactive skill model shows the operator
  the detected state and asks confirmation before disabling a live
  default setup. The converger runs UNATTENDED: unconditional
  converge-to-`not-configured` on difference (read-first,
  write-only-on-diff). 403/404 (feature/plan unavailable) →
  report-and-skip; auth/scope errors are real failures.
- **Bypass actors**: the interactive skill model ensures only the
  admin entry (`actor_id:5, RepositoryRole, pull_request`). The
  converger ensures THREE: admin + AUTOMERGE App + converger App, each
  App as `{app_id, Integration, pull_request}`. App ids resolved at
  sweep time via `GET /orgs/{org}/installations` (converger slug from
  env `GH_REPO_CONFIG_APP_SLUG`; AUTOMERGE slug is the constant
  `thevoskamps-pr-automations`). An App not installed in the org →
  omit its entry + report, never fail. Resolve app_ids dynamically at
  sweep time — never hardcode a specific id.
- **Ruleset requires all four aggregator contexts from first
  assertion**: `codeql-required`, `install-gate-required`,
  `pinned-gate-required`, `no-back-merging-guard`.

**Ordering gate:** per repo per tick — file render/PR → merge pass →
ruleset step runs ONLY once the repo's converger PR merged this tick
OR there was no diff (noop). If the PR is still open (awaiting checks
/ just opened this tick), skip the ruleset AND do not stamp; next tick
retries. This guards against ever requiring a status-check context
whose producing workflow isn't yet on the target's default branch. In
`runSweep` this means the ruleset step runs AFTER the merge pass,
gated on `convergeResult.noop || (this repo had a PR that the merge
pass merged this tick)`.

**code_quality 422 retry**: the ruleset PUT/POST may 422 on the
`code_quality` rule (limited availability). Retry the same write with
that rule dropped, report "code quality: skipped (rule type not
available)" — don't fail the whole convergence.

**Semantic compare** before deciding to PUT: `ref_name.include`
converged when it contains `~DEFAULT_BRANCH` or concrete
`refs/heads/<default>` (superset ok); required checks compared on
`context` set only (ignore `integration_id`); bypass actors compared
as `(actor_id|app_id, actor_type, bypass_mode)` tuples with
set-containment.

**This repo's own `no-back-merging-guard.yml` and
`dependency-pinned-gate.sh` carry hardening beyond the interactive
skill model's baseline** (least-privilege permissions,
order-independent negated-glob matching). When extracting a NEW
payload from the upstream skill model, do NOT overwrite these
already-hardened existing assets.
