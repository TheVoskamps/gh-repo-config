---
name: project-fanout-review
description: Review context for the org-wide repo-config fan-out (#11) slice PRs — what is deliberately out of PR scope; #14 (real convergence) landed via PR #31.
metadata:
  type: project
---

The org-wide repo-configuration fan-out (umbrella issue #11) is built as
a sequence of vertical slices. Slice 1 (#12, PR #20) = versioned release.
Slice 2 (#13, PR #21) = selection-loop sweep control plane. Slice 2b
(#24, PR #27) = sweep merges its own green converger PRs. Slice 3 (#14,
PR #31) = first real convergence teeth (dependabot.yml + gates/guards,
`src/converge/` + `src/github/contents.ts`). Slices #15-#18 = remaining
convergence logic (GHAS, protect-main ruleset, CodeQL, community files).

**Why:** each slice is a walking skeleton — proves one end-to-end path
before the next adds teeth. Convergence was an injectable no-op stub
through #13; #14 wired in the real one via `runSweepFromEnv` (`runSweep`
itself still takes an injectable `converge` for tests).

**How to apply when reviewing a slice PR:**
- Operator provisioning (org GitHub App registration, org custom-property
  definitions, org secrets, fixture repos) is deliberately **out of PR
  scope** — it is the operator's job via the `/gh-create-app` skill. Do
  NOT flag "workflow will fail because secrets/properties don't exist yet"
  as a defect; the PR body lists these as prerequisites and the workflow
  is designed to fail-fast until they're provisioned. That's intended.
- The issue's "Done when" for these slices is an operator acceptance run
  that depends on the above provisioning, so it can't be exercised in the
  review worktree. Judge the PR against the code implementing the slice's
  model, not against running the acceptance.
- The sweep workflow lives in *this* repo (builds from source) as a
  walking skeleton; the design doc's eventual home for the fan-out driver
  is `<org>/.github` consuming the release asset. A later slice may
  relocate it — not a defect in the current slice.
