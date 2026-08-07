import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRepo, decideRepoFromRaw } from "../dist/index.js";

// Fixture "current version" the decision is taken against, 9.9.9 by
// the same convention test/sweep.test.js's V follows: never equal to
// the real CURRENT_VERSION, so no assertion here can pass merely
// because the fixture happens to match package.json. Unlike runSweep,
// decideRepo/decideRepoFromRaw take the version as a required
// argument with no CURRENT_VERSION default, so here the distinctness
// is convention rather than a live hole being closed.
const V = "9.9.9";

test("ignore is skip-unmanaged even when behind", () => {
  const d = decideRepo({ mode: "ignore", version: "0.1.0" }, "opt-out", V);
  assert.equal(d.action, "skip-unmanaged");
});

test("unset under opt-in is skip-unmanaged", () => {
  const d = decideRepo({ mode: undefined, version: undefined }, "opt-in", V);
  assert.equal(d.action, "skip-unmanaged");
});

test("process + missing stamp converges", () => {
  const d = decideRepo({ mode: "process", version: undefined }, "opt-in", V);
  assert.equal(d.action, "converge");
});

test("process + behind stamp converges", () => {
  const d = decideRepo({ mode: "process", version: "0.1.0" }, "opt-in", V);
  assert.equal(d.action, "converge");
});

test("process + current stamp is skip-current", () => {
  const d = decideRepo({ mode: "process", version: V }, "opt-in", V);
  assert.equal(d.action, "skip-current");
});

test("unset under opt-out + behind converges", () => {
  const d = decideRepo({ mode: undefined, version: "0.1.0" }, "opt-out", V);
  assert.equal(d.action, "converge");
});

test("unset under opt-out + current is skip-current", () => {
  const d = decideRepo({ mode: undefined, version: V }, "opt-out", V);
  assert.equal(d.action, "skip-current");
});

test("decideRepoFromRaw normalizes a garbage org default to opt-in", () => {
  const d = decideRepoFromRaw(
    { mode: undefined, version: undefined },
    "garbage",
    V,
  );
  assert.equal(d.action, "skip-unmanaged");
});
