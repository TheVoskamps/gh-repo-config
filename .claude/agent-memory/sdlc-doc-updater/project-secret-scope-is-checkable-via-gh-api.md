---
name: secret-scope-is-checkable-via-gh-api
description: A doc claim that a GitHub Actions secret is "a repo secret" is checkable — gh api repos/{o}/{r}/actions/secrets and .../organization-secrets settle it
metadata:
  type: project
---

# Secret-scope claims are checkable, not assumable

Prose saying a workflow reads "the `X_APP_ID` / `X_APP_PRIVATE_KEY`
repo secrets" is a structural claim. Settle it with:

```bash
gh api repos/<owner>/<repo>/actions/secrets            # repo-scoped
gh api repos/<owner>/<repo>/actions/organization-secrets # org-scoped, visible here
```

**Why:** in `gh-repo-config` the repo carries ZERO repo-level Actions
secrets — `AUTOMERGE_APP_ID`, `AUTOMERGE_APP_PRIVATE_KEY`, and both
`CONVERGER_APP_*` are org secrets — while CLAUDE.md, the `assets/`
workflow headers, and a `PR_AUTOMATION_CONSTANTS` TSDoc all called them
repo secrets. The workflows still work because `secrets.<NAME>`
resolves at either scope, so no test and no run failure ever exposed
the wrong prose.

**How to apply:** whenever a doc pass touches App-token minting or
secret provisioning, run the two API calls above before letting a
scope word ("repo secret", "org secret") stand. Prefer wording that
states the requirement ("must be org-scoped, because the payload fans
out") over wording that states an incidental current scope.

Related: [[verify-which-pass-acts-on-which-pr]]
