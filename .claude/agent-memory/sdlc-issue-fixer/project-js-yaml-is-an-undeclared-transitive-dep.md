---
name: project-js-yaml-is-an-undeclared-transitive-dep
description: js-yaml resolves from node_modules in this repo only as a transitive dep of markdownlint-cli2 — fine for throwaway scratch scripts, wrong to import from committed test code, since npm test backs the ci-required check
metadata:
  type: project
---

# `js-yaml` is available here, but undeclared

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
cross-checked against, which is its best use here (see
[[feedback-prove-a-replacement-assertion-bites]]). Do not import it from
`test/`, `src/`, or `assets/` — CLAUDE.md's Conventions section carries
that rule for the repo as a whole. When a review finding recommends a
dependency as "reported to be available", run `npm ls <pkg>` before
using it and report which kind of available it turned out to be:
"resolves from `node_modules`" and "declared" are separate claims, and
recall is not evidence for either.
