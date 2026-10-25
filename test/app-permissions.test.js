import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPrAutomationPermissions,
  findMissingPermissions,
  PR_AUTOMATION_REQUIRED_PERMISSIONS,
} from "../dist/index.js";

const FULL_GRANT = { ...PR_AUTOMATION_REQUIRED_PERMISSIONS };

function installed(permissions) {
  return new Map([["acme-automerge", { appId: 7, permissions }]]);
}

test("PR_AUTOMATION_REQUIRED_PERMISSIONS is the set the PR-automation workflows need", () => {
  assert.deepEqual(FULL_GRANT, {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  });
});

test("assertPrAutomationPermissions passes a full grant", () => {
  assert.doesNotThrow(() =>
    assertPrAutomationPermissions(installed(FULL_GRANT), "acme", "acme-automerge"),
  );
});

test("assertPrAutomationPermissions names each missing permission with the remediation", () => {
  const { issues: _absent, ...grant } = FULL_GRANT;
  assert.throws(
    () =>
      assertPrAutomationPermissions(
        installed({ ...grant, contents: "read" }),
        "acme",
        "acme-automerge",
      ),
    (err) => {
      assert.match(err.message, /acme-automerge on acme/);
      assert.match(err.message, /^ {2}contents: read \(need write\)$/m);
      assert.match(err.message, /^ {2}issues: none \(need write\)$/m);
      assert.doesNotMatch(err.message, /pull_requests:/);
      assert.match(err.message, /only through the GitHub web UI/);
      assert.match(err.message, /no REST endpoint updates them/);
      assert.match(err.message, /owner of acme must accept the new permission request/);
      return true;
    },
  );
});

test("assertPrAutomationPermissions fails when the App is not installed", () => {
  assert.throws(
    () => assertPrAutomationPermissions(new Map(), "acme", "acme-automerge"),
    /acme-automerge is not installed on acme\. .*install it on the acme organization/,
  );
});

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
