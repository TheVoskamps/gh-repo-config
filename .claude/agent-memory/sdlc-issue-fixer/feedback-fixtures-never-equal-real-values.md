---
name: feedback-fixtures-never-equal-real-values
description: A test fixture standing in for a real runtime value must be chosen so it can never coincide with that value; when a change makes them equal, fix the fixture rather than noting that nothing currently breaks
metadata:
  type: feedback
---

# A fixture must never equal the real value it stands in for

When a fixture constant and the real value it substitutes for become
numerically equal, that is a defect to close in the same PR, even when
nothing currently fails. Pick a value the real one can never reach —
`9.9.9` for a version that only ever moves up — rather than one that
merely differs today.

**Why:** Edwin directed this on PR #79 (issue #77) after a fix round
bumped `package.json` to `0.2.0`, making `test/sweep.test.js`'s
`const V = "0.2.0"` equal the real `CURRENT_VERSION`. That round
verified nothing broke and flagged it instead of fixing it; he called
it "exactly the 'passes for the wrong reason' class this PR already
removed once" (the job-count assertion that counted trigger keys and
passed by coincidence) and sent it back. Reporting a trap you could
have closed costs a whole round.

**How to apply:** when a value bump collides with a fixture, change
the fixture, then sweep every sibling test for the same constant
rather than only the one that was reported — but keep the report
honest about which instances were load-bearing and which were swept
for uniformity. Load-bearing means a code path can reach the real
value on its own: in this repo `runSweep`'s `version` parameter
defaults to `CURRENT_VERSION`, so its tests could hide an
ignored-argument bug, while `decideRepo` and
`OrgPropertiesClient.stampVersion` take the version as a required
argument and cannot. Prefer replacing a second literal with the
symbolic constant over editing two literals. Prove it per
[[feedback-prove-a-replacement-assertion-bites]].
