---
name: dependabot-render-spec
description: The dependabot.yml __DEPENDABOT_ECOSYSTEMS__ expansion rules the converger's render pipeline must reproduce (resolution spec lives in the github-setup plugin's gh-repo-setup-protection SKILL.md Step 3).
metadata:
  type: project
---

The converger's `dependabot.yml` render (`src/converge/`) is NOT a
plain `__…__` substitution. Its `__DEPENDABOT_ECOSYSTEMS__` token
expands to one rendered `ecosystem-block.yml` copy per armed ecosystem.
The authoritative resolution spec lives in the **github-setup plugin**
at `skills/gh-repo-setup-protection/SKILL.md` "Step 3".

**Why:** the source-of-truth for the per-ecosystem-class variant
resolution is that external plugin doc, not this repo. If the render
ever looks wrong, re-read that Step 3 rather than guessing — a wrong
variant (e.g. `versioning-strategy` on docker) makes Dependabot reject
the whole config.

**How to apply** — the spec:

- Armed set (sorted): `bundler, cargo, composer, docker, github-actions,
  gomod, gradle, maven, npm, pip, terraform`. Blocks rendered sorted by
  ecosystem name for deterministic (byte-stable) output.
- Three classes: **npm/pip** (rich tier), **github-actions** (fixed dir,
  weekly, default-days only), **everything else** (recursing dir, daily,
  default-days only).
- `__ECOSYSTEM__` = the ecosystem value.
- `__SCHEDULE_INTERVAL__` = `weekly` for github-actions, else `daily`.
- `__DIRECTORY_BLOCK__`: github-actions → `directory: "/"` (singular);
  everyone else → `directories:` + `- "**/*"` (root globstar).
- `__VERSIONING_STRATEGY_BLOCK__`: npm/pip → `versioning-strategy: increase`;
  else EMPTY → drop the whole placeholder line (empty-block collapse; no
  whitespace-only line left behind).
- `__COOLDOWN_BLOCK__`: npm/pip → `cooldown:` with semver-major-days 14,
  semver-minor-days 7, semver-patch-days 7, default-days 7. Everyone else
  → `cooldown:` with `default-days: 7` only (semver tiers rejected there).
- Block first line carries no leading indent (template's 4-space indent
  supplies it); continuation lines carry their own 6-space absolute indent.
- Strip the leading comment block from BOTH `ecosystem-block.yml` and the
  outer `dependabot.yml` before rendering (everything up to and including
  the `# Indentation …` comment for the block; the comment header for the
  outer template).
- Gate/guard `.yml` workflows carry only `__DEFAULT_BRANCH__`. `.sh`
  scripts are verbatim (no tokens, ship mode 100755 under .github/scripts).
