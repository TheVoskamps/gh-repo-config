---
name: reference-job-shape-changes-orphan-script-outputs
description: When a PR reshapes which jobs a converged workflow emits, grep the payload scripts for GITHUB_OUTPUT writes and diff their consumers against origin/main — a retired detect job leaves script-side outputs that nothing reads.
metadata:
  type: reference
---

# A job-shape change orphans script-side `GITHUB_OUTPUT` writes

The `assets/` payload scripts and the `assets/` workflows are two
files that have to agree, and the agreement is invisible from either
one alone: a script writes `<key>=<json>` into `$GITHUB_OUTPUT`, and a
workflow reads it as `steps.<id>.outputs.<key>`. When a PR changes the
job/step topology — collapsing a `detect` job into a step, merging
jobs, renaming a step — the workflow side gets rewritten and the
script side silently keeps writing a key nobody reads.

This is invisible to every gate the repo has: `bash -n` passes, the
self-tests pass (they do not set `GITHUB_OUTPUT` for these scripts),
`npm test` passes, and it is not a shellcheck class either. It is only
findable by looking.

The check, two commands:

```bash
grep -rn "GITHUB_OUTPUT" assets/*.sh assets/*.yml
git show origin/main:assets/<workflow>.yml | grep -n "outputs"
```

Then match each script-side key against a live consumer in the PR's
version of the workflow. A key with a consumer on `main` and none on
the branch is dead code the PR created. Watch for the sharper variant:
a run step with **no `id:`** cannot expose outputs at all, so anything
the script writes from inside it is unreachable rather than merely
unread.

Grade it **Low** — an unread step output has no behavioural, security
or acceptance-criterion consequence — but do report it, because these
scripts ship verbatim to every managed repo.

Generalisation worth carrying: when a fixer reports sweeping a class
"comment-and-prose only", look for the member of that same class that
is *code*. A comment-only sweep structurally cannot reach it, so it is
exactly what survives the sweep.
