---
name: reference-verify-a-test-actually-bites
description: Three cheap ways to check a new test is real rather than decorative — replay it against the pre-change payload via `git archive origin/main`, cross-check a hand-rolled structural helper against a real parser in node_modules, and inject the bug into `dist/` when the test's subject is a fixture constant rather than a payload.
metadata:
  type: reference
---

# Verifying that a new assertion actually bites

A test added to pin an invariant is worthless if it passes against the
state it was meant to reject. Two checks settle it without re-deriving
the change, and both are a handful of tool calls.

## 1. Replay the new test against the pre-change payload

`git archive` gives a clean tree of any ref with no branch claim and no
worktree bookkeeping:

```bash
git -C "$W" archive origin/main | tar -x -C "$W/.claude/tmp/<slug>/main-tree"
ln -s "$W/node_modules" "$W/.claude/tmp/<slug>/main-tree/node_modules"
# then: npx tsc -p tsconfig.json, cp the PR's new test file over the old
# one, and node --test --test-name-pattern '<the new test>' <test file>
```

The symlinked `node_modules` avoids a second `npm ci`, since the PR
under review is almost never changing dependencies. Wrap the whole
thing in a `.sh` file — the harness refuses compound commands with
redirects (see [[feedback-sandbox-git-replay-constraints]], whose
point 3 also explains why that symlink must be torn down before you
run `npm run lint:md`).

A green result here is the finding: the assertion is decorative. A red
result, with the diff naming the old shape, is the proof the fixer's
"it fails against `origin/main`" claim is true rather than asserted.

## 2. Cross-check a hand-rolled helper against a real parser

When a repo deliberately hand-rolls structural parsing in tests (this
one refuses to import `js-yaml` because it is only a transitive dev
dep of `markdownlint-cli2`), the helper is exactly where a
same-class-as-the-bug-it-fixed defect hides. The library the *test*
may not import is still sitting in `node_modules` and the *reviewer*
may import it freely:

```js
import { load } from "js-yaml";           // review-only, never in a test
console.log(Object.keys(load(content).jobs));
```

If the helper's output is identical to the real parser's on every file
the payload actually renders, the helper is sound *on the payload*,
which is the claim that matters. Then reason separately about what a
future edit could sneak past it — and check whether the miss fails
open (test stays green, extra thing exists) or closed (test goes red).
Only fail-open is worth writing up.

## 3. Inject the bug into `dist/` when the subject is a fixture value

Method 1 cannot settle a change whose subject is a *fixture constant*
(`const V = "0.2.0"` → `"9.9.9"`), because replaying against
`origin/main` moves the implementation and the real constant together
and isolates neither. Mutate the implementation instead. Tests here
import from `dist/`, so the injection point is the compiled file and no
rebuild is needed:

```bash
cp dist/sweep.js "$TMP/sweep.js.orig"
perl -0pi -e 's/export async function runSweep\(client, org, version = CURRENT_VERSION/.../' dist/sweep.js
node --test test/sweep.test.js        # new fixture: expect a failure
perl -0pi -e 's/^const V = "9\.9\.9";$/const V = "0.2.0";/m' test/sweep.test.js
node --test test/sweep.test.js        # old fixture: expect all green
cp "$TMP/sweep.js.orig" dist/sweep.js # restore BOTH files, then re-run the suite
```

The bug to inject is the one the fixture was hiding — usually a
defaulted parameter the implementation could read instead of its
argument (`runSweep(client, org, version = CURRENT_VERSION, …)`). Green
under the old fixture and red under the new one is the proof; anything
else means the distinctness is decorative and should be graded as such.
Restore from the copies and re-run the whole suite before writing the
review, so the worktree you later commit memory from is clean.

**How to apply:** run whichever fits whenever a review round's whole
subject is a replaced or newly-added assertion — 1 for a payload or
behaviour change, 3 for a fixture-value change, 2 alongside either when
a hand-rolled helper is involved. Asking the fixer's report to be taken
on faith is the failure mode; each check is cheaper than one round of
re-review.
