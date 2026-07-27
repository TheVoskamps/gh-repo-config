# Rulesets

This directory holds checked-in source-of-record copies of repo-level
GitHub rulesets that are **operator-managed** — created and maintained
by a human via the rules API or the web UI, not by this repo's
converger sweep. The JSON here is a recreate-from-source artifact, not
something any code in this repo asserts or reverts.

## `repo-required-checks.json`

Requires the `ci-required` status check (produced by
`.github/workflows/ci.yml`) on the default branch.

This is deliberately a separate ruleset from `protect-main` rather
than a context added to `protect-main` — `protect-main` is converged
by this repo's own sweep code (`src/converge/ruleset.ts`) against
`assets/protect-main-ruleset.json` using an exact-set compare on
required-check contexts, so a hand-added context there would be
reverted as drift. GitHub aggregates all active rulesets on a branch,
so a check required by `repo-required-checks` is required even though
`protect-main` doesn't list it.

Note that `protect-main` is intentionally **not** tracked in this
directory — it has its own canonical source under `assets/` and is
converger-managed. `repo-required-checks` is the one operator-managed
ruleset tracked here.

## Recreating the ruleset

If the live ruleset is ever deleted, recreate it from the checked-in
file:

```bash
gh api repos/<owner>/<repo>/rulesets -X POST \
  --input .github/rulesets/repo-required-checks.json
```
