import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingPermissions } from "../dist/index.js";

test("findMissingPermissions reports an absent key as granted none", () => {
  assert.deepEqual(findMissingPermissions({}, { issues: "write" }), [
    { permission: "issues", required: "write", granted: "none" },
  ]);
});

test("findMissingPermissions reports a granted level below the required one", () => {
  assert.deepEqual(findMissingPermissions({ contents: "read" }, { contents: "write" }), [
    { permission: "contents", required: "write", granted: "read" },
  ]);
});

test("findMissingPermissions accepts an exact level", () => {
  assert.deepEqual(findMissingPermissions({ contents: "write" }, { contents: "write" }), []);
});

test("findMissingPermissions accepts a higher level for a lower requirement", () => {
  assert.deepEqual(
    findMissingPermissions(
      { contents: "write", issues: "admin" },
      { contents: "read", issues: "write" },
    ),
    [],
  );
});

test("findMissingPermissions fails closed on an unrecognized level", () => {
  assert.deepEqual(findMissingPermissions({ checks: "superuser" }, { checks: "read" }), [
    { permission: "checks", required: "read", granted: "superuser" },
  ]);
});

test("findMissingPermissions ignores granted permissions nothing requires", () => {
  assert.deepEqual(findMissingPermissions({ packages: "write" }, {}), []);
});

test("findMissingPermissions sorts the shortfall by permission name", () => {
  const missing = findMissingPermissions(
    {},
    { pull_requests: "write", actions: "read", issues: "write" },
  );
  assert.deepEqual(
    missing.map((m) => m.permission),
    ["actions", "issues", "pull_requests"],
  );
});
