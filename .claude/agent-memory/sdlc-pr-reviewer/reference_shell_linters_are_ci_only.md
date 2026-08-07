---
name: reference-shell-linters-are-ci-only
description: shellcheck and actionlint are not on this host and are not project deps, so a review of assets/*.sh or a workflow cannot reproduce the ci.yml lint step — substitute bash -n plus the payload self-tests and say plainly that the gap is unclosed.
metadata:
  type: reference
---

# `shellcheck` and `actionlint` are CI-only here

`.github/workflows/ci.yml` runs `shellcheck assets/*.sh scripts/*.sh`
and `actionlint .github/workflows/*.yml`. Neither binary is on the
host — `command -v shellcheck` and `command -v actionlint` both return
nothing — and neither is a project dependency or an `npx` target, so
installing either would breach the host-integrity rule in
`rules/install-discipline.md`. Do not go hunting for them, and do not
escalate their absence as a blocker: this repo's payload reviews touch
`assets/*.sh` constantly, so the probe would repeat on every one.

What actually substitutes, in descending value:

- `bash -n <script>` on every touched script (catches syntax, not
  quoting or unused-variable classes).
- The payload self-tests, which are the real coverage:
  `assets/test-*.sh` and `scripts/test-*.sh`, each runnable as
  `bash <file>` with no arguments. They are fully offline.
- For a comment-only delta, check whether the diff adds or removes a
  `# shellcheck disable=` directive. If it does not, the residual
  shellcheck risk is small — but it is still not zero.

**Say so in the review.** A `pr-reviewer` that quietly omits the lint
step reads as though it ran. State that the step was not reproduced,
name why, and name the substitutes — the whole value of the report is
that the orchestrator can tell verified from unverified. See
`rules/label-uncertainty.md`.

The `issue-fixer` hit the same wall and holds its own copy of this
fact, so a report claiming "shellcheck not run" from that agent is
expected rather than a process failure to flag.

Related: [[exercise-workflow-run-blocks-against-real-trees]],
[[verify-github-semantics-from-raw-upstream]].
