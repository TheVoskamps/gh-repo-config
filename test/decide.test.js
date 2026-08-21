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

test("opt-out is skip-unmanaged even when behind", () => {
  const d = decideRepo({ mode: "opt-out", version: "0.1.0" }, "opt-in", V);
  assert.equal(d.action, "skip-unmanaged");
});

test("unset under an opt-out default is skip-unmanaged", () => {
  const d = decideRepo({ mode: undefined, version: undefined }, "opt-out", V);
  assert.equal(d.action, "skip-unmanaged");
});

test("opt-in + missing stamp converges", () => {
  const d = decideRepo({ mode: "opt-in", version: undefined }, "opt-out", V);
  assert.equal(d.action, "converge");
});

test("opt-in + behind stamp converges", () => {
  const d = decideRepo({ mode: "opt-in", version: "0.1.0" }, "opt-out", V);
  assert.equal(d.action, "converge");
});

test("opt-in + current stamp is skip-current", () => {
  const d = decideRepo({ mode: "opt-in", version: V }, "opt-out", V);
  assert.equal(d.action, "skip-current");
});

test("unset under an opt-in default + behind converges", () => {
  const d = decideRepo({ mode: undefined, version: "0.1.0" }, "opt-in", V);
  assert.equal(d.action, "converge");
});

test("unset under an opt-in default + current is skip-current", () => {
  const d = decideRepo({ mode: undefined, version: V }, "opt-in", V);
  assert.equal(d.action, "skip-current");
});

test("a repo still carrying the retired 'process' token follows the default", () => {
  // The token is not recognized, so it collapses to unset — under an
  // opt-out default that means unmanaged, which is the fail-safe read of
  // a value the new vocabulary has no meaning for.
  assert.equal(
    decideRepo({ mode: "process", version: "0.1.0" }, "opt-out", V).action,
    "skip-unmanaged",
  );
  assert.equal(
    decideRepo({ mode: "process", version: "0.1.0" }, "opt-in", V).action,
    "converge",
  );
});

test("decideRepoFromRaw normalizes a garbage default to opt-out", () => {
  const d = decideRepoFromRaw(
    { mode: undefined, version: undefined },
    "garbage",
    V,
  );
  assert.equal(d.action, "skip-unmanaged");
});
