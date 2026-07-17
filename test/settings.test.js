import { test } from "node:test";
import assert from "node:assert/strict";
import { RepoSettingsClient } from "../dist/index.js";

// A programmable fake fetch: routes matched by (method, url-substring)
// with an optional predicate; each returns a canned body. Records calls,
// mirroring test/writer.test.js / test/merge.test.js.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    for (const route of routes) {
      const methodMatch = (route.method ?? "GET") === method;
      const urlMatch = url.includes(route.match);
      if (methodMatch && urlMatch) {
        const status = route.status ?? 200;
        return {
          ok: status < 400,
          status,
          statusText: route.statusText ?? "OK",
          json: async () => route.body ?? {},
        };
      }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const OWNER = "TheVoskamps";
const REPO = "example";

test("readSettings: vulnerability-alerts 204 -> enabled", async () => {
  const fetch = fakeFetch([
    { match: "/vulnerability-alerts", status: 204 },
    { match: "/automated-security-fixes", body: { enabled: false, paused: false } },
    { match: `/repos/${OWNER}/${REPO}`, body: {} },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const settings = await client.readSettings(OWNER, REPO);
  assert.equal(settings.vulnerabilityAlertsEnabled, true);
});

test("readSettings: vulnerability-alerts 404 -> disabled", async () => {
  const fetch = fakeFetch([
    { match: "/vulnerability-alerts", status: 404 },
    { match: "/automated-security-fixes", body: { enabled: false, paused: false } },
    { match: `/repos/${OWNER}/${REPO}`, body: {} },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const settings = await client.readSettings(OWNER, REPO);
  assert.equal(settings.vulnerabilityAlertsEnabled, false);
});

test("readSettings: automated-security-fixes reads the enabled flag from the JSON body", async () => {
  const fetch = fakeFetch([
    { match: "/vulnerability-alerts", status: 204 },
    { match: "/automated-security-fixes", body: { enabled: true, paused: false } },
    { match: `/repos/${OWNER}/${REPO}`, body: {} },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const settings = await client.readSettings(OWNER, REPO);
  assert.equal(settings.automatedSecurityFixesEnabled, true);
});

test("readSettings: reads secret scanning + push protection status and merge-button settings from the repo object", async () => {
  const fetch = fakeFetch([
    { match: "/vulnerability-alerts", status: 204 },
    { match: "/automated-security-fixes", body: { enabled: true, paused: false } },
    {
      match: `/repos/${OWNER}/${REPO}`,
      body: {
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "disabled" },
        },
        allow_merge_commit: true,
        allow_squash_merge: false,
        allow_rebase_merge: false,
        allow_auto_merge: true,
        delete_branch_on_merge: true,
      },
    },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const settings = await client.readSettings(OWNER, REPO);
  assert.equal(settings.secretScanning, "enabled");
  assert.equal(settings.secretScanningPushProtection, "disabled");
  assert.equal(settings.allowMergeCommit, true);
  assert.equal(settings.allowSquashMerge, false);
  assert.equal(settings.allowRebaseMerge, false);
  assert.equal(settings.allowAutoMerge, true);
  assert.equal(settings.deleteBranchOnMerge, true);
});

test("readSettings: missing security_and_analysis / merge-button keys read as undefined/false, not throw", async () => {
  const fetch = fakeFetch([
    { match: "/vulnerability-alerts", status: 404 },
    { match: "/automated-security-fixes", body: { enabled: false, paused: false } },
    { match: `/repos/${OWNER}/${REPO}`, body: {} },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const settings = await client.readSettings(OWNER, REPO);
  assert.equal(settings.secretScanning, undefined);
  assert.equal(settings.secretScanningPushProtection, undefined);
  assert.equal(settings.allowMergeCommit, false);
  assert.equal(settings.allowAutoMerge, false);
  assert.equal(settings.deleteBranchOnMerge, false);
});

test("enableVulnerabilityAlerts issues a bare PUT and returns the raw response", async () => {
  const fetch = fakeFetch([{ match: "/vulnerability-alerts", method: "PUT", status: 204 }]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const res = await client.enableVulnerabilityAlerts(OWNER, REPO);
  assert.equal(res.ok, true);
  const call = fetch.calls.find((c) => c.method === "PUT");
  assert.ok(call.url.includes("/vulnerability-alerts"));
});

test("enableVulnerabilityAlerts surfaces a 422 as a non-ok response rather than throwing", async () => {
  const fetch = fakeFetch([
    { match: "/vulnerability-alerts", method: "PUT", status: 422 },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const res = await client.enableVulnerabilityAlerts(OWNER, REPO);
  assert.equal(res.ok, false);
  assert.equal(res.status, 422);
});

test("patchSecurityAndAnalysis PATCHes only the requested sub-keys", async () => {
  const fetch = fakeFetch([
    { match: `/repos/${OWNER}/${REPO}`, method: "PATCH", status: 200 },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  await client.patchSecurityAndAnalysis(OWNER, REPO, { secretScanning: true });
  const call = fetch.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(call.body, {
    security_and_analysis: { secret_scanning: { status: "enabled" } },
  });
});

test("enableSecretScanningDelegatedBypass PATCHes the delegated-bypass sub-key", async () => {
  const fetch = fakeFetch([
    { match: `/repos/${OWNER}/${REPO}`, method: "PATCH", status: 200 },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  const res = await client.enableSecretScanningDelegatedBypass(OWNER, REPO);
  assert.equal(res.ok, true);
  const call = fetch.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(call.body, {
    security_and_analysis: { secret_scanning_delegated_bypass: { status: "enabled" } },
  });
});

test("patchMergeButtonSettings PATCHes only the requested keys", async () => {
  const fetch = fakeFetch([
    { match: `/repos/${OWNER}/${REPO}`, method: "PATCH", status: 200 },
  ]);
  const client = new RepoSettingsClient({ token: "t", fetch });
  await client.patchMergeButtonSettings(OWNER, REPO, {
    allowMergeCommit: true,
    allowSquashMerge: false,
  });
  const call = fetch.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(call.body, {
    allow_merge_commit: true,
    allow_squash_merge: false,
  });
});
