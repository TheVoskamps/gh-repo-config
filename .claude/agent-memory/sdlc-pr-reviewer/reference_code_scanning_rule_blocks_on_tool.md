---
name: reference-code-scanning-rule-blocks-on-tool
description: A ruleset `code_scanning` rule blocks merges per TOOL, not per check-run name or SARIF category — so a CodeQL job losing its required-status-check name does not lose alert enforcement. Check the ruleset before grading such a gap.
metadata:
  type: reference
---

# The `code_scanning` ruleset rule blocks on the tool, not the check name

GitHub has **two independent** merge gates for CodeQL, and reviews in
this repo keep conflating them:

1. `required_status_checks` — matches a **check-run name**
   (`codeql-required`). A job that is not named in the list is
   advisory.
2. The `code_scanning` ruleset rule — keyed on the **tool**
   (`{"tool": "CodeQL", "security_alerts_threshold": ..., "alerts_threshold": ...}`).
   Per
   `github/docs`'s `data/reusables/code-scanning/merge-protection-rulesets-conditions.md`,
   it blocks when *a required tool finds an alert of the defined
   severity*, when *a required tool's analysis is still in progress*,
   or when *a required tool is not configured for the repository*. No
   check-run name and no SARIF category appear in any of the three
   conditions.

`assets/protect-main-ruleset.json` carries **both**. So when a
refactor drops a CodeQL job out of the required-check list (issue #77
did exactly this to `analyze-swift`), the coverage actually lost is
much narrower than it first looks: **alerts** from that job still
block via gate 2; only a job that *fails to run at all* stops
blocking. Grade the finding on that narrower consequence, and read
`assets/protect-main-ruleset.json` before grading — the first-pass
reading ("Swift security is now unenforced") is wrong.

The mirror-image trap, which `assets/codeql.yml`'s own header warns
about: do **not** propose fixing such a gap by adding the job's name
to `required_status_checks`. On a repo lacking that language the job
never runs, the required check never concludes, and every PR hangs —
the #91/#230 phantom-check bug.

Verify the upstream semantics rather than recalling them; see
[[verify-github-semantics-from-raw-upstream]] for the fetch method,
and note the conditions live in a **reusable**, not in
`available-rules-for-rulesets.md`, which only `{% data %}`-includes it.
