---
name: project-verify-assets-against-upstream
description: How to independently verify this repo's assets/ provenance claims against the github-setup plugin — clone claude-plugins-marketplace into .claude/tmp and diff, rather than trusting a PR body's "verified upstream" claim.
metadata:
  type: project
---

`gh-repo-config`'s `assets/` payloads claim to be extracted verbatim
from the `github-setup` plugin. Any PR that touches `assets/` and
asserts "matches upstream" / "preserves our local fix" is making a
**load-bearing claim that is directly checkable** — check it, don't
take the PR body's word.

**Why:** the local plugin *cache* holds only `SKILL.md`, not
`payload/`, which historically made reviewers believe the claim was
unverifiable (an earlier PR #40 review flagged it as such). That
belief was wrong: `payload/` lives in the marketplace **source repo**.

**How to apply:** from the worktree root,

```bash
git clone --depth 1 https://github.com/TheVoskamps/claude-plugins-marketplace.git .claude/tmp/<slug>/mp
rm -rf .claude/tmp/<slug>/mp/.git   # nested .git trips the cross-repo read guard
cat .claude/tmp/<slug>/mp/plugins/github-setup/.claude-plugin/plugin.json  # confirm the version under review
diff -rq assets .claude/tmp/<slug>/mp/plugins/github-setup/payload/gh-repo-setup-protection
diff -rq assets .claude/tmp/<slug>/mp/plugins/github-setup/payload/gh-repo-setup-pr-automation
```

Write scratch clones under `.claude/tmp/` inside the worktree — the
session scratchpad under `/private/tmp/...` is **outside** the repo
root and the sandbox refuses to read it. Delete the clone before
finishing so `git status` stays clean.

Two gotchas worth knowing:

- Several `assets/` entries have **no upstream counterpart at all**
  (`protect-main-ruleset.json`, and the `CONTRIBUTORS`/`LICENSE`/
  `PATENTS`/`PRIOR_ART.md` community files). A blanket "everything
  else is byte-identical to upstream" doc claim is therefore false for
  those; check the taxonomy covers them.
- Divergence is often **local-ahead on purpose** (upstream is behind).
  A file differing from upstream is not automatically drift — see
  [[project-fanout-review]] for the slice context.
