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
    if (url.includes("/pulls?state=open")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => [] };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  try {
    const report = await runSweepFromEnv({
      GH_REPO_CONFIG_ORG: "TheVoskamps",
      GH_REPO_CONFIG_TOKEN: "test-token",
      GH_REPO_CONFIG_APP_SLUG: "test-converger",
    });

    assert.equal(report.version, CURRENT_VERSION);
    assert.deepEqual(report.converged, ["fixture-behind"]);
    assert.deepEqual(report.stamped, ["fixture-behind"]);
    assert.deepEqual(report.failed, []);
    assert.equal(report.skippedCurrent, 1); // fixture-current, already at CURRENT_VERSION
    assert.ok(calls.some((c) => c.method === "PATCH"));
    assert.deepEqual(report.merged, []);
    assert.deepEqual(report.awaitingChecks, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test("runSweepFromEnv requires GH_REPO_CONFIG_APP_SLUG", async () => {
  await assert.rejects(
    () =>
      runSweepFromEnv({
        GH_REPO_CONFIG_ORG: "TheVoskamps",
        GH_REPO_CONFIG_TOKEN: "test-token",
      }),
    /GH_REPO_CONFIG_APP_SLUG is required/,
  );
});

test("the merge pass runs over every managed repo independent of the version-skip decision", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [
      { repo: "fixture-current", mode: "process", version: V }, // skip-current, but may still have an open PR
    ],
  });

  const mergeCalls = [];
  const mergeClient = {
    listOwnOpenPullRequests: async (org, repo, appSlug) => {
      mergeCalls.push({ org, repo, appSlug });
      return [
        {
          number: 7,
          headSha: "abc123",
          headRef: "converger/work",
          baseRef: "main",
          authorLogin: "test-converger[bot]",
          authorType: "Bot",
        },
      ];
    },
    evaluateAndMerge: async (org, repo, pr, dryRun) => ({
      pr,
      outcome: "merged",
      checks: [{ context: "ci", state: "green" }],
      reason: "all required checks green, merged",
    }),
  };

  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    mergeClient,
    appSlug: "test-converger",
  });

  assert.equal(report.skippedCurrent, 1);
  assert.deepEqual(mergeCalls, [
    { org: "TheVoskamps", repo: "fixture-current", appSlug: "test-converger" },
  ]);
  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0].pr.number, 7);
  assert.deepEqual(report.awaitingChecks, []);
});

test("the merge pass never probes an unmanaged (skip-unmanaged) repo", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [
      { repo: "fixture-ignore", mode: "ignore", version: undefined }, // skip-unmanaged
      { repo: "fixture-process", mode: "process", version: V }, // skip-current, managed
    ],
  });

  const mergeCalls = [];
  const mergeClient = {
    listOwnOpenPullRequests: async (org, repo, appSlug) => {
      mergeCalls.push(repo);
      return [];
    },
    evaluateAndMerge: async () => {
      throw new Error("should not be called — no PRs returned");
    },
  };

  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    mergeClient,
    appSlug: "test-converger",
  });

  assert.equal(report.skippedUnmanaged, 1);
  // Scope is explicit in the iteration itself, not incidental to the
  // author filter: the unmanaged repo's name never even reaches
  // listOwnOpenPullRequests.
  assert.deepEqual(mergeCalls, ["fixture-process"]);
});

test("the merge pass merges every currently-green converger PR on a repo, with no cap", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [{ repo: "fixture-process", mode: "process", version: V }],
  });

  const openPrs = [1, 2, 3].map((number) => ({
    number,
    headSha: `sha${number}`,
    headRef: `converger/work-${number}`,
    baseRef: "main",
    authorLogin: "test-converger[bot]",
    authorType: "Bot",
  }));
  const evaluated = [];
  const mergeClient = {
    listOwnOpenPullRequests: async () => openPrs,
    evaluateAndMerge: async (org, repo, pr) => {
      evaluated.push(pr.number);
      return {
        pr,
        outcome: "merged",
        checks: [{ context: "ci", state: "green" }],
        reason: "all required checks green, merged",
      };
    },
  };

  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    mergeClient,
    appSlug: "test-converger",
  });

  assert.deepEqual(evaluated, [1, 2, 3]);
  assert.deepEqual(
    report.merged.map((m) => m.pr.number),
    [1, 2, 3],
  );
  assert.deepEqual(report.awaitingChecks, []);
});

test("a blocked/pending/awaiting-retry merge outcome is reported as awaitingChecks, not failed", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [{ repo: "fixture-a", mode: "process", version: V }],
  });

  const openPr = {
    number: 1,
    headSha: "sha1",
    headRef: "converger/work",
    baseRef: "main",
    authorLogin: "test-converger[bot]",
    authorType: "Bot",
  };
  const mergeClient = {
    listOwnOpenPullRequests: async () => [openPr],
    evaluateAndMerge: async () => ({
      pr: openPr,
      outcome: "blocked",
      checks: [{ context: "ci", state: "red" }],
      reason: "required check(s) red: ci",
    }),
  };

  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    mergeClient,
    appSlug: "test-converger",
  });

  assert.deepEqual(report.merged, []);
  assert.equal(report.awaitingChecks.length, 1);
  assert.equal(report.awaitingChecks[0].outcome, "blocked");
  // Not a sweep failure — an open-awaiting-checks PR is not `failed`.
  assert.deepEqual(report.failed, []);
});

test("appSlug is required when mergeClient is supplied", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [],
  });
  await assert.rejects(
    () =>
      runSweep(client, "TheVoskamps", V, {
        log: () => {},
        mergeClient: { listOwnOpenPullRequests: async () => [] },
      }),
    /appSlug is required/,
  );
});

test("an unexpected merge-pass error on one repo is isolated: it's recorded as failed, and other repos still get merged", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [
      { repo: "fixture-a", mode: "process", version: V },
      { repo: "fixture-b", mode: "process", version: V },
      { repo: "fixture-c", mode: "process", version: V },
    ],
  });

  const openPr = (n) => ({
    number: n,
    headSha: `sha${n}`,
    headRef: "converger/work",
    baseRef: "main",
    authorLogin: "test-converger[bot]",
    authorType: "Bot",
  });

  const listCalls = [];
  const mergeClient = {
    listOwnOpenPullRequests: async (org, repo) => {
      listCalls.push(repo);
      if (repo === "fixture-b") {
        // Simulate a transient GitHub error (e.g. a 500) while listing
        // fixture-b's PRs — this must not abort the merge pass for
        // fixture-c, which comes after it in iteration order.
        throw new Error("simulated 500 from list-PRs");
      }
      return [openPr(repo === "fixture-a" ? 1 : 3)];
    },
    evaluateAndMerge: async (org, repo, pr) => ({
      pr,
      outcome: "merged",
      checks: [{ context: "ci", state: "green" }],
      reason: "all required checks green, merged",
    }),
  };

  const logs = [];
  const report = await runSweep(client, "TheVoskamps", V, {
    log: (m) => logs.push(m),
    mergeClient,
    appSlug: "test-converger",
  });

  // All three repos were attempted — the error on fixture-b did not
  // short-circuit the loop before fixture-c was reached.
  assert.deepEqual(listCalls, ["fixture-a", "fixture-b", "fixture-c"]);

  // fixture-a and fixture-c still got their merge pass and are merged.
  assert.deepEqual(
    report.merged.map((m) => m.pr.number).sort(),
    [1, 3],
  );
  assert.deepEqual(report.awaitingChecks, []);

  // fixture-b is recorded as failed, not silently dropped.
  assert.deepEqual(report.failed, ["fixture-b"]);
  const fixtureBResult = report.results.find((r) => r.repo === "fixture-b");
  assert.equal(fixtureBResult.action, "failed");
  assert.match(fixtureBResult.reason, /merge pass failed/);
  assert.match(fixtureBResult.reason, /simulated 500 from list-PRs/);

  // fixture-a and fixture-c are not marked failed.
  assert.equal(
    report.results.find((r) => r.repo === "fixture-a").action,
    "skip-current",
  );
  assert.equal(
    report.results.find((r) => r.repo === "fixture-c").action,
    "skip-current",
  );

  assert.ok(logs.some((l) => l.includes("fixture-b: merge pass failed")));
});

test("dryRun is passed through to evaluateAndMerge so the merge pass never issues a merge", async () => {
  const client = fakeClient({
    orgDefault: "opt-in",
    repos: [{ repo: "fixture-a", mode: "process", version: "0.1.0" }],
  });

  const dryRunFlags = [];
  const openPr = {
    number: 3,
    headSha: "sha3",
    headRef: "converger/work",
    baseRef: "main",
    authorLogin: "test-converger[bot]",
    authorType: "Bot",
  };
  const mergeClient = {
    listOwnOpenPullRequests: async () => [openPr],
    evaluateAndMerge: async (org, repo, pr, dryRun) => {
      dryRunFlags.push(dryRun);
      return {
        pr,
        outcome: "merged",
        checks: [],
        reason: "[dry-run] all required checks green, would merge",
      };
    },
  };

  const report = await runSweep(client, "TheVoskamps", V, {
    dryRun: true,
    log: () => {},
    mergeClient,
    appSlug: "test-converger",
  });

  assert.deepEqual(dryRunFlags, [true]);
  assert.equal(report.merged.length, 1);
  assert.deepEqual(report.stamped, []); // dryRun symmetry with stamping
});
