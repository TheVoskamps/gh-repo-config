---
name: feedback-a-cited-guarantee-must-be-read
description: When prose justifies a narrow implementation by citing a test/gate as the guarantee that makes it safe, open that guarantee and check it actually forbids the case — a plausible-looking assertion often does not
metadata:
  type: feedback
---

# A cited guarantee has to be read, not just named

Prose of the form "X is safe because Y pins Z" is two claims: that Y
exists, and that Y actually excludes the case X would break on. The
first is cheap and almost always true; the second is the one that
fails. Open Y and evaluate it against the input X cannot survive.

**Why:** on PR #79 a docstring justified `version-compare.ts` parsing
only the `MAJOR.MINOR.PATCH` core by saying `test/version.test.js`
"pins `CURRENT_VERSION` to a plain `X.Y.Z` shape". The test existed and
its name said `semver-shaped`, but its regex was unanchored
(`/^\d+\.\d+\.\d+/`), so it accepted `0.3.0-rc.1` — the exact value
that breaks the core-only compare, since `isBehind("0.3.0-rc.1",
"0.3.0")` is `false` and such a repo never converges. The safety
argument rested on a guarantee that did not exist, and the whole thing
was caught by reading one regex. The same trap sits in prose rules: a
convention saying a bump must be "strictly greater semver" reads as
airtight but admits `0.2.0` -> `0.3.0-rc.1` -> `0.3.0`, whose second
step is valid and delivers nothing.

**How to apply:** whenever you write or review a sentence naming a
test, lint rule, ruleset, or CI gate as the reason something narrower
is safe, do three things. Read the assertion itself, not the test
name — names drift from bodies and a name is not a contract. Construct
the specific value the narrow implementation mishandles and run the
guarantee against it. And prefer prose that states the rejection
positively ("a prerelease fails `npm test`") over prose that states a
shape passively ("is pinned to `X.Y.Z`"), because the positive form is
falsifiable in one command. When the guarantee turns out not to hold,
strengthening it is usually the fix and the prose then becomes true;
prove it per [[feedback-prove-a-replacement-assertion-bites]]. Sibling:
[[feedback-sweep-past-the-diff-for-falsified-prose]] covers prose a
change falsified rather than prose that was never true.
