---
name: yaml-render-test-indentation
description: Tests over rendered YAML templates in this repo must pin exact indentation, not use .trim()/\s* regexes — a mis-indent is a silent Dependabot/GitHub-Actions config-rejection, not a visible failure.
metadata:
  type: feedback
---

When adding or reviewing tests over `src/converge/render.ts` output
(or any other rendered-YAML payload in this repo — CodeQL config,
PR-automation workflows), assertions must be indentation-preserving:
compare exact contiguous substrings or anchor regexes to the literal
number of spaces at each nesting level, never `.trim()` a line before
comparing or use `\s*`/`\s+` between structural lines.

**Why:** caught in PR #46 review (issue #36, named Dependabot groups).
The original tests verified group-name presence and ordering but used
`npm.includes(line.trim())` and `\s*`-separated regexes, which pass
identically whether the rendered YAML is correctly indented or
silently broken. For `dependabot.yml` specifically (and any GitHub
Actions / config YAML broadly), a wrong indent is not a visible
failure — it is invalid or misnested YAML that the consumer (GitHub)
silently rejects at config-parse time. A test suite whose whole
purpose is to catch rendering regressions is worthless against that
exact failure mode if its assertions are indentation-blind.

**How to apply:** when writing a test that checks a multi-line
rendered block:

- Build the expected block as a literal string (or derive it from the
  source-of-truth export, e.g. `NAMED_DEPENDABOT_GROUPS`, applying the
  same indent the placeholder line supplies) and assert
  `rendered.includes(expectedBlock)` — a full contiguous match, not a
  per-line loop with `.trim()`.
- When a full verbatim match is overkill, anchor line-level regexes to
  the exact indent (e.g. `^      groupName:$` for a known 6-space
  depth), never `^\s+groupName:$`.
- Verify the test actually catches regressions before trusting it: run
  it once against a deliberately mis-indented and once against a
  deliberately reordered version of the source asset, confirm both
  fail, then revert. This repo's `assets/*.yml` files are small enough
  that this is a cheap, worthwhile check whenever the fidelity of the
  test is itself the point (as opposed to routine content-presence
  tests, where trim-based matching is fine).

See [[project_ruleset_canonical_authoritative]] for a related but
distinct concern (semantic vs. literal compare) in this same repo's
converge pipeline.
