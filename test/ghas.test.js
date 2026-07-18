import { test } from "node:test";
import assert from "node:assert/strict";
import { convergeGhasSettings } from "../dist/index.js";

const OWNER = "TheVoskamps";
const REPO = "example";

// A minimal fake of RepoSettingsClient — convergeGhasSettings only calls
// readSettings plus the five write methods.
function fakeClient({ current, writeStatuses = {} }, calls = []) {
  const status = (name) => writeStatuses[name] ?? 200;
  const response = (name) => ({ ok: status(name) < 400, status: status(name) });
  return {
    readSettings: async () => current,
    enableVulnerabilityAlerts: async () => {
      calls.push("vulnerability-alerts");
      return response("vulnerability-alerts");
    },
    enableAutomatedSecurityFixes: async () => {
      calls.push("automated-security-fixes");
      return response("automated-security-fixes");
    },
    patchSecurityAndAnalysis: async (owner, repo, patch) => {
      calls.push({ patchSecurityAndAnalysis: patch });
      return response("secret-scanning");
    },
    enableSecretScanningDelegatedBypass: async () => {
      calls.push("push-protection-bypass");
      return response("push-protection-bypass");
    },
    patchMergeButtonSettings: async (owner, repo, patch) => {
      calls.push({ patchMergeButtonSettings: patch });
      return response("merge-button");
    },
  };
}

function fullyConverged() {
  return {
    vulnerabilityAlertsEnabled: true,
    automatedSecurityFixesEnabled: true,
    secretScanning: "enabled",
    secretScanningPushProtection: "enabled",
    allowMergeCommit: true,
    allowSquashMerge: false,
    allowRebaseMerge: false,
    allowAutoMerge: true,
    deleteBranchOnMerge: true,
  };
}

function nothingConverged() {
  return {
    vulnerabilityAlertsEnabled: false,
    automatedSecurityFixesEnabled: false,
    secretScanning: undefined,
    secretScanningPushProtection: undefined,
    allowMergeCommit: false,
    allowSquashMerge: true,
    allowRebaseMerge: true,
    allowAutoMerge: false,
    deleteBranchOnMerge: false,
  };
}

test("a fully-converged repo reports noop: true even though push-protection-bypass still fires", async () => {
  const calls = [];
  const client = fakeClient({ current: fullyConverged() }, calls);
  const result = await convergeGhasSettings(client, OWNER, REPO, false);
  // Every setting this converger can actually *read* the current state
  // of reports already-converged with no write issued; `noop` reflects
  // that (the bypass call is excluded from the noop calculation — see
  // the next test).
  assert.equal(result.noop, true);
  const readGated = result.results.filter(
    (r) => r.setting !== "push-protection-delegated-bypass",
  );
  assert.ok(readGated.every((r) => r.outcome === "already-converged"));
});

test("push-protection-bypass is always attempted, even on an otherwise-converged repo (best effort, not read-gated)", async () => {
  const calls = [];
  const client = fakeClient({ current: fullyConverged() }, calls);
  const result = await convergeGhasSettings(client, OWNER, REPO, false);
  // GitHub exposes no stable per-repo GET for this sub-key's current
  // state (per the issue's own constraint), so this call always fires,
  // best-effort, on every converge pass -- unlike the other, read-gated
  // settings. Its own outcome does not gate `noop` (see the previous
  // test), since otherwise `noop` would be false on every single pass.
  assert.deepEqual(calls, ["push-protection-bypass"]);
  const bypass = result.results.find((r) => r.setting === "push-protection-delegated-bypass");
  assert.equal(bypass.outcome, "changed");
});

test("a not-yet-converged repo writes exactly the settings that differ", async () => {
  const calls = [];
  const client = fakeClient({ current: nothingConverged() }, calls);
  const result = await convergeGhasSettings(client, OWNER, REPO, false);
  assert.equal(result.noop, false);

  assert.ok(calls.includes("vulnerability-alerts"));
  assert.ok(calls.includes("automated-security-fixes"));
  assert.ok(calls.includes("push-protection-bypass"));

  const secPatch = calls.find((c) => c.patchSecurityAndAnalysis)?.patchSecurityAndAnalysis;
  assert.deepEqual(secPatch, { secretScanning: true, secretScanningPushProtection: true });

  const mergePatch = calls.find((c) => c.patchMergeButtonSettings)?.patchMergeButtonSettings;
  assert.deepEqual(mergePatch, {
    allowMergeCommit: true,
    allowSquashMerge: false,
    allowRebaseMerge: false,
    allowAutoMerge: true,
    deleteBranchOnMerge: true,
  });

  const byName = Object.fromEntries(result.results.map((r) => [r.setting, r.outcome]));
  assert.equal(byName["vulnerability-alerts"], "changed");
  assert.equal(byName["automated-security-fixes"], "changed");
  assert.equal(byName["secret-scanning"], "changed");
  assert.equal(byName["secret-scanning-push-protection"], "changed");
  assert.equal(byName["merge-button-settings"], "changed");
});

test("secret scanning already enabled but push protection not -> PATCHes only push protection", async () => {
  const calls = [];
  const current = {
    ...nothingConverged(),
    secretScanning: "enabled",
    secretScanningPushProtection: "disabled",
  };
  const client = fakeClient({ current }, calls);
  await convergeGhasSettings(client, OWNER, REPO, false);
  const secPatch = calls.find((c) => c.patchSecurityAndAnalysis)?.patchSecurityAndAnalysis;
  assert.deepEqual(secPatch, { secretScanningPushProtection: true });
});

test("allow_update_branch is never part of the merge-button patch (deliberate divergence from gh-repo-setup-protection)", async () => {
  const calls = [];
  const client = fakeClient({ current: nothingConverged() }, calls);
  await convergeGhasSettings(client, OWNER, REPO, false);
  const mergePatch = calls.find((c) => c.patchMergeButtonSettings)?.patchMergeButtonSettings;
  assert.ok(!("allowUpdateBranch" in mergePatch));
});

test("a 422 entitlement error on vulnerability-alerts is reported as skipped, not thrown, and other settings still converge", async () => {
  const calls = [];
  const client = fakeClient(
    {
      current: nothingConverged(),
      writeStatuses: { "vulnerability-alerts": 422 },
    },
    calls,
  );
  const result = await convergeGhasSettings(client, OWNER, REPO, false);
  const va = result.results.find((r) => r.setting === "vulnerability-alerts");
  assert.equal(va.outcome, "skipped");
  assert.match(va.reason, /422/);

  // Other settings still got attempted and converged.
  const merge = result.results.find((r) => r.setting === "merge-button-settings");
  assert.equal(merge.outcome, "changed");
});

test("a 422 on the merge-button PATCH is reported as skipped, not thrown", async () => {
  const calls = [];
  const client = fakeClient(
    {
      current: nothingConverged(),
      writeStatuses: { "merge-button": 422 },
    },
    calls,
  );
  const result = await convergeGhasSettings(client, OWNER, REPO, false);
  const merge = result.results.find((r) => r.setting === "merge-button-settings");
  assert.equal(merge.outcome, "skipped");
});

test("push-protection-bypass failure (404/422) is reported as skipped, never thrown -- best effort per gh-repo-setup-protection posture", async () => {
  const calls = [];
  const client = fakeClient(
    {
      current: fullyConverged(),
      writeStatuses: { "push-protection-bypass": 422 },
    },
    calls,
  );
  const result = await convergeGhasSettings(client, OWNER, REPO, false);
  const bypass = result.results.find((r) => r.setting === "push-protection-delegated-bypass");
  assert.equal(bypass.outcome, "skipped");
  assert.match(bypass.reason, /Code security settings/);
});

test("a 500 (unexpected error) on a write throws, rather than being silently swallowed", async () => {
  const calls = [];
  const client = fakeClient(
    {
      current: nothingConverged(),
      writeStatuses: { "vulnerability-alerts": 500 },
    },
    calls,
  );
  await assert.rejects(
    () => convergeGhasSettings(client, OWNER, REPO, false),
    /500/,
  );
});

test("dryRun computes the diff without issuing any writes", async () => {
  const calls = [];
  const client = fakeClient({ current: nothingConverged() }, calls);
  const result = await convergeGhasSettings(client, OWNER, REPO, true);
  assert.deepEqual(calls, []); // no writes issued
  assert.equal(result.noop, false);
  const byName = Object.fromEntries(result.results.map((r) => [r.setting, r.outcome]));
  assert.equal(byName["vulnerability-alerts"], "changed");
  assert.equal(byName["merge-button-settings"], "changed");
});

test("dryRun on a fully-converged repo reports already-converged for read-gated settings", async () => {
  const calls = [];
  const client = fakeClient({ current: fullyConverged() }, calls);
  const result = await convergeGhasSettings(client, OWNER, REPO, true);
  assert.deepEqual(calls, []);
  const byName = Object.fromEntries(result.results.map((r) => [r.setting, r.outcome]));
  assert.equal(byName["vulnerability-alerts"], "already-converged");
  assert.equal(byName["merge-button-settings"], "already-converged");
});
