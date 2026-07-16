import { test } from "node:test";
import assert from "node:assert/strict";
import { MergeClient } from "../dist/index.js";

// Build a fake fetch that records calls and returns canned responses
// keyed by URL substring + method, mirroring test/properties.test.js.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body });
    for (const route of routes) {
      if (url.includes(route.match) && (route.method ?? "GET") === method) {
        return {
          ok: route.status ? route.status < 400 : true,
          status: route.status ?? 200,
          statusText: route.statusText ?? "OK",
          json: async () => route.body,
        };
      }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function pr(overrides = {}) {
  return {
    number: 1,
    user: { login: "my-converger[bot]", type: "Bot" },
    head: { sha: "sha1", ref: "converger/work" },
    base: { ref: "main" },
    ...overrides,
  };
}

test("listOwnOpenPullRequests matches login AND type, filtering out other authors", async () => {
  const fetch = fakeFetch([
    {
      match: "/pulls?state=open",
      body: [
        pr({ number: 1, user: { login: "my-converger[bot]", type: "Bot" } }),
        pr({ number: 2, user: { login: "dependabot[bot]", type: "Bot" } }),
        pr({ number: 3, user: { login: "a-human", type: "User" } }),
        // Same login text but not actually a Bot — must not match.
        pr({ number: 4, user: { login: "my-converger[bot]", type: "User" } }),
      ],
    },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const prs = await client.listOwnOpenPullRequests("Org", "repo", "my-converger");
  assert.deepEqual(
    prs.map((p) => p.number),
    [1],
  );
});

test("getRequiredCheckContexts extracts required_status_checks contexts, ignoring other rule types", async () => {
  const fetch = fakeFetch([
    {
      match: "/rules/branches/main",
      body: [
        { type: "pull_request" },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "build" }, { context: "test" }],
          },
        },
      ],
    },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const contexts = await client.getRequiredCheckContexts("Org", "repo", "main");
  assert.deepEqual(contexts, ["build", "test"]);
});

test("getRequiredCheckContexts returns empty for an unprotected branch", async () => {
  const fetch = fakeFetch([{ match: "/rules/branches/main", body: [] }]);
  const client = new MergeClient({ token: "t", fetch });
  const contexts = await client.getRequiredCheckContexts("Org", "repo", "main");
  assert.deepEqual(contexts, []);
});

test("evaluateRequiredChecks conclusion-mapping table", async () => {
  const fetch = fakeFetch([
    {
      match: "/commits/sha1/check-runs",
      body: {
        check_runs: [
          { name: "success-check", status: "completed", conclusion: "success" },
          { name: "skipped-check", status: "completed", conclusion: "skipped" },
          { name: "neutral-check", status: "completed", conclusion: "neutral" },
          { name: "failure-check", status: "completed", conclusion: "failure" },
          { name: "cancelled-check", status: "completed", conclusion: "cancelled" },
          { name: "timed-out-check", status: "completed", conclusion: "timed_out" },
          {
            name: "action-required-check",
            status: "completed",
            conclusion: "action_required",
          },
          { name: "queued-check", status: "queued", conclusion: null },
          { name: "in-progress-check", status: "in_progress", conclusion: null },
        ],
      },
    },
    { match: "/commits/sha1/status", body: { statuses: [] } },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const results = await client.evaluateRequiredChecks("Org", "repo", "sha1", [
    "success-check",
    "skipped-check",
    "neutral-check",
    "failure-check",
    "cancelled-check",
    "timed-out-check",
    "action-required-check",
    "queued-check",
    "in-progress-check",
    "missing-check", // not reported at all yet
  ]);
  const byContext = Object.fromEntries(results.map((r) => [r.context, r.state]));
  assert.equal(byContext["success-check"], "green");
  assert.equal(byContext["skipped-check"], "green");
  assert.equal(byContext["neutral-check"], "green");
  assert.equal(byContext["failure-check"], "red");
  assert.equal(byContext["cancelled-check"], "red");
  assert.equal(byContext["timed-out-check"], "red");
  assert.equal(byContext["action-required-check"], "red");
  assert.equal(byContext["queued-check"], "pending");
  assert.equal(byContext["in-progress-check"], "pending");
  assert.equal(byContext["missing-check"], "pending");
});

test("evaluateRequiredChecks falls back to the legacy combined status when a context has no check-run", async () => {
  const fetch = fakeFetch([
    { match: "/commits/sha1/check-runs", body: { check_runs: [] } },
    {
      match: "/commits/sha1/status",
      body: {
        statuses: [
          { context: "legacy-success", state: "success" },
          { context: "legacy-failure", state: "failure" },
          { context: "legacy-error", state: "error" },
          { context: "legacy-pending", state: "pending" },
        ],
      },
    },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const results = await client.evaluateRequiredChecks("Org", "repo", "sha1", [
    "legacy-success",
    "legacy-failure",
    "legacy-error",
    "legacy-pending",
  ]);
  const byContext = Object.fromEntries(results.map((r) => [r.context, r.state]));
  assert.equal(byContext["legacy-success"], "green");
  assert.equal(byContext["legacy-failure"], "red");
  assert.equal(byContext["legacy-error"], "red");
  assert.equal(byContext["legacy-pending"], "pending");
});

test("evaluateRequiredChecks with an empty required-context list makes no network calls and returns empty", async () => {
  const fetch = async () => {
    throw new Error("should not be called");
  };
  const client = new MergeClient({ token: "t", fetch });
  const results = await client.evaluateRequiredChecks("Org", "repo", "sha1", []);
  assert.deepEqual(results, []);
});

test("mergePullRequest issues a merge-commit-only PUT and returns true on success", async () => {
  const fetch = fakeFetch([
    { match: "/pulls/5/merge", method: "PUT", status: 200, body: { merged: true } },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const merged = await client.mergePullRequest("Org", "repo", 5);
  assert.equal(merged, true);
  const call = fetch.calls.find((c) => c.method === "PUT");
  assert.equal(JSON.parse(call.body).merge_method, "merge");
});

test("mergePullRequest returns false (not throw) on 405/409", async () => {
  for (const status of [405, 409]) {
    const fetch = fakeFetch([
      { match: "/pulls/5/merge", method: "PUT", status, body: {} },
    ]);
    const client = new MergeClient({ token: "t", fetch });
    const merged = await client.mergePullRequest("Org", "repo", 5);
    assert.equal(merged, false, `status ${status} should return false, not throw`);
  }
});

test("mergePullRequest throws on other non-ok statuses", async () => {
  const fetch = fakeFetch([
    { match: "/pulls/5/merge", method: "PUT", status: 500, body: {} },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  await assert.rejects(() => client.mergePullRequest("Org", "repo", 5), /500/);
});

test("evaluateAndMerge: all green -> merges and reports merged", async () => {
  const fetch = fakeFetch([
    {
      match: "/rules/branches/main",
      body: [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci" }] },
        },
      ],
    },
    {
      match: "/commits/sha1/check-runs",
      body: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
    },
    { match: "/commits/sha1/status", body: { statuses: [] } },
    { match: "/pulls/1/merge", method: "PUT", body: { merged: true } },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const result = await client.evaluateAndMerge(
    "Org",
    "repo",
    { number: 1, headSha: "sha1", headRef: "work", baseRef: "main" },
    false,
  );
  assert.equal(result.outcome, "merged");
  assert.ok(fetch.calls.some((c) => c.method === "PUT"));
});

test("evaluateAndMerge: empty required-check set on an unprotected branch merges too", async () => {
  const fetch = fakeFetch([
    { match: "/rules/branches/main", body: [] },
    { match: "/pulls/1/merge", method: "PUT", body: { merged: true } },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const result = await client.evaluateAndMerge(
    "Org",
    "repo",
    { number: 1, headSha: "sha1", headRef: "work", baseRef: "main" },
    false,
  );
  assert.equal(result.outcome, "merged");
  assert.deepEqual(result.checks, []);
});

test("evaluateAndMerge: a red required check blocks and never calls merge", async () => {
  const fetch = fakeFetch([
    {
      match: "/rules/branches/main",
      body: [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci" }] },
        },
      ],
    },
    {
      match: "/commits/sha1/check-runs",
      body: { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] },
    },
    { match: "/commits/sha1/status", body: { statuses: [] } },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const result = await client.evaluateAndMerge(
    "Org",
    "repo",
    { number: 1, headSha: "sha1", headRef: "work", baseRef: "main" },
    false,
  );
  assert.equal(result.outcome, "blocked");
  assert.ok(!fetch.calls.some((c) => c.method === "PUT"));
});

test("evaluateAndMerge: a pending required check waits and never calls merge", async () => {
  const fetch = fakeFetch([
    {
      match: "/rules/branches/main",
      body: [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci" }] },
        },
      ],
    },
    {
      match: "/commits/sha1/check-runs",
      body: { check_runs: [{ name: "ci", status: "in_progress", conclusion: null }] },
    },
    { match: "/commits/sha1/status", body: { statuses: [] } },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const result = await client.evaluateAndMerge(
    "Org",
    "repo",
    { number: 1, headSha: "sha1", headRef: "work", baseRef: "main" },
    false,
  );
  assert.equal(result.outcome, "pending");
  assert.ok(!fetch.calls.some((c) => c.method === "PUT"));
});

test("evaluateAndMerge: dryRun decides but never issues the merge call", async () => {
  const fetch = fakeFetch([
    {
      match: "/rules/branches/main",
      body: [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci" }] },
        },
      ],
    },
    {
      match: "/commits/sha1/check-runs",
      body: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
    },
    { match: "/commits/sha1/status", body: { statuses: [] } },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const result = await client.evaluateAndMerge(
    "Org",
    "repo",
    { number: 1, headSha: "sha1", headRef: "work", baseRef: "main" },
    true,
  );
  assert.equal(result.outcome, "merged");
  assert.ok(result.reason.includes("dry-run"));
  assert.ok(!fetch.calls.some((c) => c.method === "PUT"));
});

test("evaluateAndMerge: a 405/409 from the merge call itself is reported as awaiting-retry, not a failure", async () => {
  const fetch = fakeFetch([
    {
      match: "/rules/branches/main",
      body: [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci" }] },
        },
      ],
    },
    {
      match: "/commits/sha1/check-runs",
      body: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
    },
    { match: "/commits/sha1/status", body: { statuses: [] } },
    { match: "/pulls/1/merge", method: "PUT", status: 409, body: {} },
  ]);
  const client = new MergeClient({ token: "t", fetch });
  const result = await client.evaluateAndMerge(
    "Org",
    "repo",
    { number: 1, headSha: "sha1", headRef: "work", baseRef: "main" },
    false,
  );
  assert.equal(result.outcome, "awaiting-retry");
});
