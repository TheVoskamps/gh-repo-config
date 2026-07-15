import { test } from "node:test";
import assert from "node:assert/strict";
import { isBehind } from "../dist/index.js";

test("missing or empty stamp is behind (never converged)", () => {
  assert.equal(isBehind(undefined, "0.1.0"), true);
  assert.equal(isBehind(null, "0.1.0"), true);
  assert.equal(isBehind("", "0.1.0"), true);
  assert.equal(isBehind("not-a-version", "0.1.0"), true);
});

test("older stamp is behind", () => {
  assert.equal(isBehind("0.0.9", "0.1.0"), true);
  assert.equal(isBehind("0.1.0", "0.2.0"), true);
  assert.equal(isBehind("1.9.9", "2.0.0"), true);
});

test("equal stamp is not behind", () => {
  assert.equal(isBehind("0.1.0", "0.1.0"), false);
});

test("newer stamp is not behind (stale run must not downgrade)", () => {
  assert.equal(isBehind("0.2.0", "0.1.0"), false);
  assert.equal(isBehind("1.0.0", "0.9.9"), false);
});

test("tolerates a v prefix and trailing metadata", () => {
  assert.equal(isBehind("v0.1.0", "0.2.0"), true);
  assert.equal(isBehind("0.1.0-rc.1", "0.1.0"), false); // same core
  assert.equal(isBehind("0.1.0", "v0.1.0"), false);
});

test("rejects a corrupted stamp that merely starts with a valid core", () => {
  // A stamp that isn't cleanly X.Y.Z (optionally + pre-release/build)
  // must be treated as unparseable -> never converged -> behind, not
  // silently truncated to its leading X.Y.Z and treated as current.
  assert.equal(isBehind("1.2.3junk", "1.2.3"), true);
  assert.equal(isBehind("1.2.3.4", "1.2.3"), true);
});

test("still tolerates real pre-release/build metadata after the corrupted-stamp tightening", () => {
  assert.equal(isBehind("1.2.3-rc.1", "1.2.3"), false);
  assert.equal(isBehind("1.2.3+build5", "1.2.3"), false);
});

test("throws when the current version is unparseable", () => {
  assert.throws(() => isBehind("0.1.0", "garbage"), /CURRENT_VERSION/);
});
