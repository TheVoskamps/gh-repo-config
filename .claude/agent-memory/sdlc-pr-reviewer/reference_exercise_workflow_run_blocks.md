---
name: exercise-workflow-run-blocks-against-real-trees
description: How to actually run an assets/*.yml workflow `run:` block locally — no pyyaml on this machine (use js-yaml from node_modules, or yq), build scratch git trees under .claude/tmp and stub the gate script to observe argv.
metadata:
  type: reference
---

# Exercising an `assets/*.yml` run block locally

Most of this repo's risk lives inside workflow `run:` blocks that no unit
test covers, so reviewing them by inspection is how latent shell bugs get
through. They are runnable locally with almost no setup.

Environment facts worth not rediscovering:

- **`pyyaml` is NOT installed** and installing it is out of bounds for a
  subagent. Two substitutes are already here: `yq`
  (`/opt/homebrew/bin/yq`), and — better, because it is a declared project
  dep that `npm ci` already brought in — **`js-yaml` in `node_modules`**,
  reachable from a `.mjs` via `createRequire`. Either answers "does this
  parse" and "what are the job ids"; `js-yaml` needs no host tool at all.
  Substitute every `__PLACEHOLDER__` with a literal first or the parse is
  meaningless. For pulling a `run:` block out verbatim, a ~25-line Python
  script that finds `- name: <step>`, then `run: |`, then dedents by the
  block's own indent is simpler than fighting a YAML lib.
- `jq`, `git`, `node`, `npm` are all present. `actionlint` and
  `shellcheck` are **not** — CI covers those, so don't claim you ran them.

The method that finds real bugs:

1. Extract the `run:` block verbatim into a `.sh` file (verbatim matters —
   a retyped copy tests your transcription, not the payload).
2. Build scratch git repos under `.claude/tmp/<slug>/trees/` with
   `git init` + a seeded tree, one per shape you care about (empty,
   single-ecosystem, multi-ecosystem, failing, pip-only, ...). Copy the
   `assets/*.sh` payload into the tree's `.github/scripts/` — this repo's
   own `.github/scripts/` copies are sweep output and can lag `assets/`.
3. Export the runner variables the block writes to
   (`GITHUB_STEP_SUMMARY`, `GITHUB_OUTPUT`) as plain files and read them
   back; that is how you check summary tables and step outputs.
4. **To prove an argv-splitting claim, stub the invoked script** with one
   that echoes `argc=$#` / `argv=[$*]`. "Three invocations, each argc=1"
   is direct evidence; "the loop looks right" is not. This is the
   difference the #77 issue body called out — the bug it describes passed
   review by inspection right up until it ran.

Related: [[verify-github-semantics-from-raw-upstream]].
