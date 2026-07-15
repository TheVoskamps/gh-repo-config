import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSweep,
  runSweepFromEnv,
  PartialStampError,
  CURRENT_VERSION,
} from "../dist/index.js";

// A minimal fake of OrgPropertiesClient — runSweep only calls
// readOrgDefault, readAllRepoValues, and stampVersion.
function fakeClient({ orgDefault, repos, stampVersionImpl }) {
  const stamped = [];
  return {
    stamped,
    readOrgDefault: async () => orgDefault,
    readAllRepoValues: async () => repos,
    stampVersion:
      stampVersionImpl ??
      (async (names, version) => {
        stamped.push({ names: [...names], version });
      }),
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
  assert.deepEqual(report.stamped, ["fixture-process"]);
  assert.deepEqual(report.failed, []);
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
  assert.deepEqual(report.stamped, ["fixture-unset"]);
  assert.deepEqual(report.failed, []);
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
  assert.deepEqual(report.stamped, []); // nothing written, and not claimed
  assert.deepEqual(report.failed, []);
  assert.deepEqual(client.stamped, []); // nothing written
});

test("a converge-step failure is reported as failed, not skip-current, and not stamped", async () => {
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
  assert.deepEqual(report.stamped, []);
  assert.deepEqual(report.failed, ["fixture-process"]);
  assert.deepEqual(client.stamped, []);
  const result = report.results.find((r) => r.repo === "fixture-process");
  assert.equal(result.action, "failed");
  assert.notEqual(result.action, "skip-current");
});

test("a mid-batch stampVersion failure reports partial progress instead of losing it", async () => {
  const repos = [
    { repo: "fixture-a", mode: "process", version: "0.1.0" },
    { repo: "fixture-b", mode: "process", version: "0.1.0" },
    { repo: "fixture-c", mode: "process", version: "0.1.0" },
  ];
  const client = fakeClient({
    orgDefault: "opt-in",
    repos,
    // Simulate stampVersion having already written fixture-a in an
    // earlier (successful) batch before the batch containing fixture-b
    // failed, leaving fixture-c never attempted.
    stampVersionImpl: async () => {
      throw new PartialStampError(
        "simulated batch failure",
        ["fixture-a"],
        ["fixture-b"],
        ["fixture-c"],
      );
    },
  });

  const report = await runSweep(client, "TheVoskamps", V, { log: () => {} });

  // converged reflects convergence-step success for all three...
  assert.deepEqual(report.converged, ["fixture-a", "fixture-b", "fixture-c"]);
  // ...but stamped reflects only what was actually confirmed written.
  assert.deepEqual(report.stamped, ["fixture-a"]);
  // The repos whose stamp write didn't land are reported as failed, not
  // silently treated as converged/current.
  assert.deepEqual(report.failed, ["fixture-b", "fixture-c"]);
  const actions = Object.fromEntries(
    report.results.map((r) => [r.repo, r.action]),
  );
  assert.equal(actions["fixture-a"], "converge");
  assert.equal(actions["fixture-b"], "failed");
  assert.equal(actions["fixture-c"], "failed");
});

test("runSweepFromEnv drives runSweep against the real CURRENT_VERSION", async () => {
  // Finding 3: prior tests only ever drove the sweep against a
  // hardcoded "0.2.0" fixture version, never the real package.json
  // version (0.1.0) the CLI actually uses in production, and never
  // through runSweepFromEnv's env -> OrgPropertiesClient -> runSweep
  // path. runSweepFromEnv builds its own client from
  // GH_REPO_CONFIG_ORG/GH_REPO_CONFIG_TOKEN and defaults to the global
  // `fetch`, so drive it for real by substituting global.fetch for the
  // duration of this test.
  assert.equal(CURRENT_VERSION, "0.1.0");

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("/properties/schema/")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ default_value: "opt-in" }),
      };
    }
    if (url.includes("/properties/values") && method === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          {
            repository_name: "fixture-behind",
            properties: [
              { property_name: "gh-repo-config-mode", value: "process" },
              { property_name: "gh-repo-config-version", value: "0.0.1" },
            ],
          },
          {
            repository_name: "fixture-current",
            properties: [
              { property_name: "gh-repo-config-mode", value: "process" },
              {
                property_name: "gh-repo-config-version",
                value: CURRENT_VERSION,
              },
            ],
          },
        ],
      };
    }
    if (url.includes("/properties/values") && method === "PATCH") {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  try {
    const report = await runSweepFromEnv({
      GH_REPO_CONFIG_ORG: "TheVoskamps",
      GH_REPO_CONFIG_TOKEN: "test-token",
    });

    assert.equal(report.version, CURRENT_VERSION);
    assert.deepEqual(report.converged, ["fixture-behind"]);
    assert.deepEqual(report.stamped, ["fixture-behind"]);
    assert.deepEqual(report.failed, []);
    assert.equal(report.skippedCurrent, 1); // fixture-current, already at CURRENT_VERSION
    assert.ok(calls.some((c) => c.method === "PATCH"));
  } finally {
    global.fetch = originalFetch;
  }
});
