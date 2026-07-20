---
name: project-codeql-ruleset-slice
description: Issue #16 (CodeQL + protect-main ruleset convergence) design decisions — where the converger's ruleset/default-setup spec deviates from the gh-repo-setup-protection skill, and the ordering-gate model.
metadata:
  type: project
---

Issue #16 (part of fan-out [[project-fanout-slices]] #11) adds the last
protection-convergence teeth: CodeQL file convergence (absorbing #17),
server-side CodeQL default-setup off, and the `protect-main` ruleset.
Authority is the `gh-repo-setup-protection` skill (github-setup plugin,
0.11.2 in cache) SKILL.md Step 5a/5b (CodeQL) and Step 6b/6c/6d
(ruleset). Payloads extracted verbatim from
`~/.claude/plugins/cache/thevoskamps/github-setup/0.11.2/payload/gh-repo-setup-protection/`.

**Where the converger DEVIATES from the skill (non-obvious):**

- **Default-setup**: the skill (Step 5a) shows the operator the detected
  state and asks confirmation before disabling a live default setup. The
  converger runs UNATTENDED, so issue #16 spec §2 replaces that with an
  unconditional converge-to-`not-configured` on difference (read-first,
  write-only-on-diff). 403/404 (feature/plan unavailable) → report-and-
  skip; auth/scope errors are real failures.
- **Bypass actors**: the skill's Step 6b ensures only the admin entry
  (`actor_id:5, RepositoryRole, pull_request`). Issue #16 §3.4 ensures
  THREE: admin + AUTOMERGE App + converger App, each App as
  `{app_id, Integration, pull_request}`. App ids resolved at sweep time
  via `GET /orgs/{org}/installations` (converger slug from env
  `GH_REPO_CONFIG_APP_SLUG`; AUTOMERGE slug is the constant
  `thevoskamps-pr-automations`). An App not installed in the org → omit
  its entry + report, never fail. Confirmed live app_ids (issue body):
  AUTOMERGE=3835765, converger=4319606 — but resolve dynamically, don't
  hardcode.
- **Ruleset requires all four aggregator contexts from first assertion**
  (`codeql-required`, `install-gate-required`, `pinned-gate-required`,
  `no-back-merging-guard`) because CodeQL ships in THIS issue. The
  2026-07-17 addendum's "omit codeql-required until CodeQL ships" is
  explicitly superseded.

**Ordering gate (issue #16 §4):** per repo per tick — file render/PR →
merge pass → ruleset step runs ONLY once the repo's converger PR merged
this tick OR there was no diff (noop). If the PR is still open
(awaiting checks / just opened this tick), skip the ruleset AND do not
stamp; next tick retries. This is the #91/#230 phantom-check guard:
never require a status-check context whose producing workflow isn't yet
on the target's default branch. In `runSweep` this means the ruleset
step runs AFTER the merge pass, gated on
`convergeResult.noop || (this repo had a PR that the merge pass merged
this tick)`.

**code_quality 422 retry**: the ruleset PUT/POST may 422 on the
`code_quality` rule (limited availability). Retry the same write with
that rule dropped, report "code quality: skipped (rule type not
available)" — don't fail the whole convergence.

**Semantic compare (§3.5)** before deciding to PUT: `ref_name.include`
converged when it contains `~DEFAULT_BRANCH` or concrete
`refs/heads/<default>` (superset ok); required checks compared on
`context` set only (ignore `integration_id`); bypass actors compared as
`(actor_id|app_id, actor_type, bypass_mode)` tuples with set-containment.

**Repo assets carry hardening beyond upstream 0.11.2**: the repo's
`no-back-merging-guard.yml` and `dependency-pinned-gate.sh` differ from
the 0.11.2 payloads (PR #33 least-privilege, PR #35 order-independent
negated-glob). When extracting NEW payloads verbatim, take them from
0.11.2, but do NOT overwrite the already-hardened existing assets.
