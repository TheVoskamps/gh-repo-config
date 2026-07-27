import { test } from "node:test";
import assert from "node:assert/strict";

// DEMO ONLY — deliberately-failing test for issue #58 acceptance criterion 2:
// "A deliberately failing unit test turns `ci-required` red (demonstrate on
// the work branch, then remove)." This file is committed, pushed, observed
// turning `ci-required` red on PR #65, then reverted in a follow-up commit.
test("demo: deliberately failing to turn ci-required red", () => {
  assert.equal(1, 2);
});
