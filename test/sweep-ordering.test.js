import { test } from "node:test";
import assert from "node:assert/strict";
import { runSweep } from "../dist/index.js";

// The #16 ordering gate: the protect-main ruleset step runs (and the repo
// is stamped) only once the repo's file convergence has reached the
// default branch this tick — file convergence was a no-op (nothing to
// merge) OR its converger PR merged this tick. When the file PR is opened
// this tick but not merged, the ruleset is deferred and the repo is not
// stamped.

function fakeClient({ repos }) {
  const stamped = [];
  return {
    stamped,
    readOrgDefault: async () => "opt-in",
    readAllRepoValues: async () => repos,
    stampVersion: async (names, version) => {
      stamped.push({ names: [...names], version });
    },
  };
}

const V = "0.2.0";

function openPr(number, repo) {
  return {
    number,
    headSha: `sha-${repo}`,
    headRef: "gh-repo-config/converge",
    baseRef: "main",
    authorLogin: "conv[bot]",
    authorType: "Bot",
  };
}

test("ordering gate: a repo whose file PR merged this tick has its ruleset run and is stamped", async () => {
  const client = fakeClient({ repos: [{ repo: "merged-repo", mode: "process", version: "0.1.0" }] });
  const rulesetCalls = [];
  const report = await runSweep(client, "O", V, {
    log: () => {},
    converge: () => ({
      changed: [".github/workflows/codeql.yml"],
      pullRequest: { number: 3, url: "u", updated: false },
      noop: false,
    }),
    convergeRuleset: (repo) => {
      rulesetCalls.push(repo);
      return { outcome: "created" };
    },
    mergeClient: {
      listOwnOpenPullRequests: async () => [openPr(3, "merged-repo")],
      evaluateAndMerge: async (o, r, pr) => ({ pr, outcome: "merged", checks: [], reason: "merged" }),
    },
    appSlug: "conv",
  });

  assert.deepEqual(rulesetCalls, ["merged-repo"], "ruleset step ran after the merge");
  assert.deepEqual(report.rulesetDeferred, []);
  assert.deepEqual(report.converged, ["merged-repo"]);
  assert.deepEqual(report.stamped, ["merged-repo"]);
  assert.equal(report.rulesetResults.length, 1);
  assert.equal(report.rulesetResults[0].result.outcome, "created");
});

test("ordering gate: a ruleset result carrying unknownParams passes through the sweep report untouched (report/CLI surfacing, never blocks stamping)", async () => {
  const client = fakeClient({ repos: [{ repo: "merged-repo", mode: "process", version: "0.1.0" }] });
  const report = await runSweep(client, "O", V, {
    log: () => {},
    converge: () => ({
      changed: [".github/workflows/codeql.yml"],
      pullRequest: { number: 3, url: "u", updated: false },
      noop: false,
    }),
    convergeRuleset: () => ({
      outcome: "unchanged",
      unknownParams: ["pull_request.some_new_param"],
    }),
    mergeClient: {
      listOwnOpenPullRequests: async () => [openPr(3, "merged-repo")],
      evaluateAndMerge: async (o, r, pr) => ({ pr, outcome: "merged", checks: [], reason: "merged" }),
    },
    appSlug: "conv",
  });

  assert.equal(report.rulesetResults.length, 1);
  assert.equal(report.rulesetResults[0].result.outcome, "unchanged");
  assert.deepEqual(report.rulesetResults[0].result.unknownParams, ["pull_request.some_new_param"]);
  // A surfaced unknownParams warning is not a failure and does not
  // block stamping — the repo still converges and stamps normally.
  assert.deepEqual(report.stamped, ["merged-repo"]);
  assert.deepEqual(report.failed, []);
});

test("ordering gate: a repo whose file PR did NOT merge this tick is deferred and NOT stamped", async () => {
  const client = fakeClient({ repos: [{ repo: "pending-repo", mode: "process", version: "0.1.0" }] });
  const rulesetCalls = [];
  const report = await runSweep(client, "O", V, {
    log: () => {},
    // File converge opened a PR (noop: false) — it exists but has not
    // reached the default branch.
    converge: () => ({
      changed: [".github/workflows/codeql.yml"],
      pullRequest: { number: 3, url: "u", updated: false },
      noop: false,
    }),
    convergeRuleset: (repo) => {
      rulesetCalls.push(repo);
      return { outcome: "created" };
    },
    mergeClient: {
      listOwnOpenPullRequests: async () => [openPr(3, "pending-repo")],
      // Checks pending → not merged this tick.
      evaluateAndMerge: async (o, r, pr) => ({
        pr,
        outcome: "pending",
        checks: [{ context: "codeql-required", state: "pending" }],
        reason: "required check(s) pending",
      }),
    },
    appSlug: "conv",
  });

  // The ruleset step must NOT run for a repo whose producing workflows
  // are not yet on the default branch (the #91/#230 phantom-check guard).
  assert.deepEqual(rulesetCalls, [], "ruleset step did not run");
  assert.deepEqual(report.rulesetDeferred, ["pending-repo"]);
  assert.deepEqual(report.converged, [], "not stamp-eligible this tick");
  assert.deepEqual(report.stamped, []);
  assert.deepEqual(client.stamped, [], "stampVersion never called");
  // Deferral is not a failure — the next tick retries.
  assert.deepEqual(report.failed, []);
  assert.equal(report.rulesetResults.length, 0);
});

test("ordering gate: a no-op file convergence (nothing to merge) still runs the ruleset and stamps", async () => {
  const client = fakeClient({ repos: [{ repo: "noop-repo", mode: "process", version: "0.1.0" }] });
  const rulesetCalls = [];
  const report = await runSweep(client, "O", V, {
    log: () => {},
    // Already-converged files: no diff, no PR.
    converge: () => ({ changed: [], noop: true }),
    convergeRuleset: (repo) => {
      rulesetCalls.push(repo);
      return { outcome: "unchanged" };
    },
    mergeClient: {
      listOwnOpenPullRequests: async () => [],
      evaluateAndMerge: async () => {
        throw new Error("no PRs to evaluate");
      },
    },
    appSlug: "conv",
  });

  assert.deepEqual(rulesetCalls, ["noop-repo"], "ruleset ran despite no file PR");
  assert.deepEqual(report.rulesetDeferred, []);
  assert.deepEqual(report.stamped, ["noop-repo"]);
});

test("ordering gate: a ruleset step failure marks the repo failed and skips stamping", async () => {
  const client = fakeClient({ repos: [{ repo: "bad-ruleset", mode: "process", version: "0.1.0" }] });
  const report = await runSweep(client, "O", V, {
    log: () => {},
    converge: () => ({ changed: [], noop: true }),
    convergeRuleset: () => {
      throw new Error("administration write denied");
    },
    mergeClient: {
      listOwnOpenPullRequests: async () => [],
      evaluateAndMerge: async () => {
        throw new Error("unused");
      },
    },
    appSlug: "conv",
  });

  assert.deepEqual(report.failed, ["bad-ruleset"]);
  assert.deepEqual(report.stamped, []);
  assert.deepEqual(report.converged, []);
});

test("without a ruleset step injected, stamping keeps pre-#16 behavior (no ordering gate)", async () => {
  const client = fakeClient({ repos: [{ repo: "legacy", mode: "process", version: "0.1.0" }] });
  const report = await runSweep(client, "O", V, {
    log: () => {},
    // A file PR was opened but not merged — yet with no ruleset step,
    // stamping is gated on the converge steps alone.
    converge: () => ({
      changed: [".github/dependabot.yml"],
      pullRequest: { number: 1, url: "u", updated: false },
      noop: false,
    }),
  });
  assert.deepEqual(report.stamped, ["legacy"]);
  assert.deepEqual(report.rulesetDeferred, []);
  assert.deepEqual(report.rulesetResults, []);
});
