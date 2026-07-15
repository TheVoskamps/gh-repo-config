import { test } from "node:test";
import assert from "node:assert/strict";
import { runSweep } from "../dist/index.js";

// A minimal fake of OrgPropertiesClient — runSweep only calls
// readOrgDefault, readAllRepoValues, and stampVersion.
function fakeClient({ orgDefault, repos }) {
  const stamped = [];
  return {
    stamped,
    readOrgDefault: async () => orgDefault,
    readAllRepoValues: async () => repos,
    stampVersion: async (names, version) => {
      stamped.push({ names: [...names], version });
    },
  };
}

const V = "0.2.0";

test("sweep converges behind managed repos, skips others, and stamps them", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [
      { repo: "fixture-process", mode: "process", version: "0.1.0" },
      { repo: "fixture-ignore", mode: "ignore", version: "0.1.0" },
      { repo: "fixture-unset", mode: undefined, version: undefined },
      { repo: "fixture-current", mode: "process", version: "0.2.0" },
    ],
  });

  const logs = [];
  const report = await runSweep(client, "TheVoskamps", V, {
    log: (m) => logs.push(m),
  });

  assert.deepEqual(report.converged, ["fixture-process"]);
  assert.equal(report.skippedUnmanaged, 2); // ignore + unset(opt-in)
  assert.equal(report.skippedCurrent, 1); // fixture-current
  assert.equal(report.orgDefault, "opt-in");
  assert.deepEqual(client.stamped, [
    { names: ["fixture-process"], version: V },
  ]);
});

test("flipping org default to opt-out converges the unset repo", async () => {
  const client = fakeClient({
    orgDefault: "opt-out",
    repos: [{ repo: "fixture-unset", mode: undefined, version: undefined }],
  });
  const report = await runSweep(client, "TheVoskamps", V, { log: () => {} });
  assert.deepEqual(report.converged, ["fixture-unset"]);
});

test("dry-run decides but does not stamp", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [{ repo: "fixture-process", mode: "process", version: "0.1.0" }],
  });
  const report = await runSweep(client, "TheVoskamps", V, {
    dryRun: true,
    log: () => {},
  });
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.converged, ["fixture-process"]);
  assert.deepEqual(client.stamped, []); // nothing written
});

test("a converge-step failure is not stamped", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [{ repo: "fixture-process", mode: "process", version: "0.1.0" }],
  });
  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    converge: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(report.converged, []);
  assert.deepEqual(client.stamped, []);
});
