---
name: verify-github-semantics-from-raw-upstream
description: Verify GitHub Actions semantics claims (context availability, workflow-command defaults, action inputs) by curling raw.githubusercontent.com rather than answering from memory.
metadata:
  type: reference
---

# Verify GitHub Actions semantics from raw upstream

Reviews in this repo constantly hinge on "is this GitHub Actions
expression/behaviour actually legal?" Network is available, and the
authoritative sources are plain files you can `curl` in one call — far
cheaper than reasoning from training-data priors, and the only way to
label the claim as verified rather than a guess.

The three that keep coming up:

- **Context availability** (can `needs` be used in `runs-on`? in `if`?):
  `https://raw.githubusercontent.com/github/docs/main/content/actions/reference/workflows-and-actions/contexts.md`
  — grep for `` `jobs.<job_id>.runs-on` `` and friends; it is a Markdown
  table, one row per key.
- **Workflow-command semantics and their defaults** (e.g. `::error::`
  without `file=` defaults to `file=.github`, `line=1`, so it never
  lands on the PR's Files-changed tab):
  `.../github/docs/main/content/actions/reference/workflows-and-actions/workflow-commands.md`
  plus the reusables it includes under
  `.../github/docs/main/data/reusables/actions/`.
- **A pinned third-party action's real contract**: fetch by the SHA the
  payload pins, not by tag —
  `https://raw.githubusercontent.com/<owner>/<repo>/<40-hex-sha>/<path>`.
  This resolved both "does `codeql-action/init` take a comma-separated
  `languages` list" (`init/action.yml`) and "how is the SARIF category
  derived when `category:` is omitted" (`src/api-client.ts`,
  `getAnalysisKey` = `` `${workflowPath}:${jobName}` ``, keyed on
  `GITHUB_JOB`, i.e. the job **id**).

Related: [[exercise-workflow-run-blocks-against-real-trees]].
