import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runSweep,
  runSweepFromEnv,
  describeDefaultModeProvenanceFailure,
  PartialStampError,
  CURRENT_VERSION,
  isBehind,
  DEFAULT_PR_AUTOMATION_IDENTITY,
  PR_AUTOMATION_REQUIRED_PERMISSIONS,
  SWEEPER_WORKFLOW_PATH,
} from "../dist/index.js";

// A minimal fake of OrgPropertiesClient — runSweep only calls
// readDefaultMode, readAllRepoValues, and stampVersion.
// `defaultMode` is the raw property value the org carries; tests that care
// about provenance (issue #67) pass `defaultModeRead` instead, which is the
// full discriminated union readDefaultMode returns.
function fakeClient({ defaultMode, defaultModeRead, repos, stampVersionImpl }) {
  const stamped = [];
  return {
    stamped,
    readDefaultMode: async () => defaultModeRead ?? { provenance: "set", raw: defaultMode },
    readAllRepoValues: async () => repos,
    stampVersion:
      stampVersionImpl ??
      (async (names, version) => {
        stamped.push({ names: [...names], version });
      }),
  };
}

// The fixture "current version" every runSweep call below is driven
// with. Deliberately 9.9.9 — far ahead of anything this package will
// plausibly carry — so it can never coincide with the real
// CURRENT_VERSION read from package.json. That distinctness is
// load-bearing: runSweep's `version` parameter DEFAULTS to
// CURRENT_VERSION (src/sweep.ts), so while the fixture equalled the
// real value, an implementation that ignored the argument and read
// CURRENT_VERSION instead would have passed these tests unnoticed.
// Repo stamps written as "0.1.0" below are the behind case against
// this V; a repo stamped at V itself is the skip-current case.
const V = "9.9.9";

test("sweep converges behind managed repos, skips others, and stamps them", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [
      { repo: "fixture-opt-in", mode: "opt-in", version: "0.1.0" },
      { repo: "fixture-opt-out", mode: "opt-out", version: "0.1.0" },
      { repo: "fixture-unset", mode: undefined, version: undefined },
      { repo: "fixture-current", mode: "opt-in", version: V },
    ],
  });

  const logs = [];
  const report = await runSweep(client, "TheVoskamps", V, {
    log: (m) => logs.push(m),
  });

  assert.deepEqual(report.converged, ["fixture-opt-in"]);
  assert.deepEqual(report.stamped, ["fixture-opt-in"]);
  assert.deepEqual(report.failed, []);
  assert.equal(report.skippedUnmanaged, 2); // opt-out + unset(default opt-out)
  assert.equal(report.skippedCurrent, 1); // fixture-current
  assert.equal(report.defaultMode, "opt-out");
  assert.deepEqual(client.stamped, [{ names: ["fixture-opt-in"], version: V }]);
  // The default no-op converge/convergeGhas stubs return nothing, so no
  // convergeResults/ghasResults entries are contributed.
  assert.deepEqual(report.convergeResults, []);
  assert.deepEqual(report.ghasResults, []);
});

test("a converge step's returned ConvergeResult is surfaced in the sweep report, per repo", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [
      { repo: "fixture-opened", mode: "opt-in", version: "0.1.0" },
      { repo: "fixture-updated", mode: "opt-in", version: "0.1.0" },
      { repo: "fixture-unchanged", mode: "opt-in", version: "0.1.0" },
      { repo: "fixture-noop", mode: "opt-in", version: "0.1.0" },
    ],
  });

  const logs = [];
  const report = await runSweep(client, "TheVoskamps", V, {
    log: (m) => logs.push(m),
    converge: (repo) => {
      if (repo === "fixture-opened") {
        return {
          changed: [".github/dependabot.yml"],
          pullRequest: {
            number: 12,
            url: "https://example/pr/12",
            updated: false,
          },
          noop: false,
        };
      }
      if (repo === "fixture-updated") {
        return {
          changed: [".github/dependabot.yml"],
          pullRequest: {
            number: 13,
            url: "https://example/pr/13",
            updated: true,
          },
          noop: false,
        };
      }
      if (repo === "fixture-unchanged") {
        return {
          changed: [".github/dependabot.yml"],
          pullRequest: {
            number: 14,
            url: "https://example/pr/14",
            updated: false,
            unchanged: true,
          },
          noop: false,
        };
      }
      // fixture-noop: no diff, no PR.
      return { changed: [], noop: true };
    },
  });

  assert.deepEqual(report.convergeResults.map((c) => c.repo).sort(), [
    "fixture-noop",
    "fixture-opened",
    "fixture-unchanged",
    "fixture-updated",
  ]);

  const byRepo = Object.fromEntries(report.convergeResults.map((c) => [c.repo, c.result]));
  assert.equal(byRepo["fixture-opened"].pullRequest.number, 12);
  assert.equal(byRepo["fixture-opened"].pullRequest.updated, false);
  assert.equal(byRepo["fixture-updated"].pullRequest.number, 13);
  assert.equal(byRepo["fixture-updated"].pullRequest.updated, true);
  assert.equal(byRepo["fixture-noop"].noop, true);
  assert.equal(byRepo["fixture-noop"].pullRequest, undefined);

  // The per-repo outcome is also logged, so a sweep run's console output
  // shows what convergence actually did per repo.
  assert.ok(logs.includes("  fixture-opened: PR #12 opened (https://example/pr/12)"));
  assert.ok(logs.includes("  fixture-updated: PR #13 updated (https://example/pr/13)"));
  assert.ok(logs.includes("  fixture-unchanged: PR #14 unchanged (https://example/pr/14)"));
  assert.ok(logs.some((l) => l.includes("fixture-noop") && l.includes("no diff, no PR")));
});

test("a convergeGhas step's returned GhasConvergeResult is surfaced in the sweep report, per repo", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [
      { repo: "fixture-changed", mode: "opt-in", version: "0.1.0" },
      { repo: "fixture-noop", mode: "opt-in", version: "0.1.0" },
    ],
  });

  const logs = [];
  const report = await runSweep(client, "TheVoskamps", V, {
    log: (m) => logs.push(m),
    convergeGhas: (repo) => {
      if (repo === "fixture-changed") {
        return {
          results: [
            { setting: "vulnerability-alerts", outcome: "changed" },
            { setting: "merge-button-settings", outcome: "already-converged" },
          ],
          noop: false,
        };
      }
      return {
        results: [{ setting: "vulnerability-alerts", outcome: "already-converged" }],
        noop: true,
      };
    },
  });

  assert.deepEqual(report.ghasResults.map((r) => r.repo).sort(), [
    "fixture-changed",
    "fixture-noop",
  ]);
  const byRepo = Object.fromEntries(report.ghasResults.map((r) => [r.repo, r.result]));
  assert.equal(byRepo["fixture-changed"].noop, false);
  assert.equal(byRepo["fixture-noop"].noop, true);

  assert.ok(logs.some((l) => l.includes("fixture-changed") && l.includes("1 changed")));
  assert.ok(logs.some((l) => l.includes("fixture-noop") && l.includes("already converged")));

  // Both repos still converge and stamp normally.
  assert.deepEqual(report.converged.sort(), ["fixture-changed", "fixture-noop"]);
  assert.deepEqual(report.failed, []);
});

test("a convergeGhas failure marks the repo failed and not-stamped, independent of a successful file converge", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [{ repo: "fixture-opt-in", mode: "opt-in", version: "0.1.0" }],
  });

  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    converge: () => ({ changed: [".github/dependabot.yml"], noop: false }),
    convergeGhas: () => {
      throw new Error("boom-ghas");
    },
  });

  assert.deepEqual(report.converged, []);
  assert.deepEqual(report.stamped, []);
  assert.deepEqual(report.failed, ["fixture-opt-in"]);
  const result = report.results.find((r) => r.repo === "fixture-opt-in");
  assert.equal(result.action, "failed");
  assert.match(result.reason, /GHAS settings convergence failed/);
  assert.match(result.reason, /boom-ghas/);

  // The file convergence result still surfaced even though GHAS failed —
  // the two concerns are independent.
  assert.equal(report.convergeResults.length, 1);
  assert.equal(report.convergeResults[0].repo, "fixture-opt-in");
});

test("a file-converge failure marks the repo failed even when convergeGhas succeeds", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [{ repo: "fixture-opt-in", mode: "opt-in", version: "0.1.0" }],
  });

  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    converge: () => {
      throw new Error("boom-files");
    },
    convergeGhas: () => ({
      results: [{ setting: "vulnerability-alerts", outcome: "changed" }],
      noop: false,
    }),
  });

  assert.deepEqual(report.converged, []);
  assert.deepEqual(report.stamped, []);
  assert.deepEqual(report.failed, ["fixture-opt-in"]);
  const result = report.results.find((r) => r.repo === "fixture-opt-in");
  assert.match(result.reason, /convergence failed/);
  assert.match(result.reason, /boom-files/);

  // The GHAS result still surfaced even though file convergence failed.
  assert.equal(report.ghasResults.length, 1);
  assert.equal(report.ghasResults[0].repo, "fixture-opt-in");
});

test("a declared default of opt-in converges the unset repo", async () => {
  const client = fakeClient({
    defaultMode: "opt-in",
    repos: [{ repo: "fixture-unset", mode: undefined, version: undefined }],
  });
  const report = await runSweep(client, "TheVoskamps", V, { log: () => {} });
  assert.deepEqual(report.converged, ["fixture-unset"]);
  assert.deepEqual(report.stamped, ["fixture-unset"]);
  assert.deepEqual(report.failed, []);
});

test("dry-run decides but does not stamp", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [{ repo: "fixture-opt-in", mode: "opt-in", version: "0.1.0" }],
  });
  const report = await runSweep(client, "TheVoskamps", V, {
    dryRun: true,
    log: () => {},
  });
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.converged, ["fixture-opt-in"]);
  assert.deepEqual(report.stamped, []); // nothing written, and not claimed
  assert.deepEqual(report.failed, []);
  assert.deepEqual(client.stamped, []); // nothing written
});

test("a converge-step failure is reported as failed, not skip-current, and not stamped", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [{ repo: "fixture-opt-in", mode: "opt-in", version: "0.1.0" }],
  });
  const report = await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    converge: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(report.converged, []);
  assert.deepEqual(report.stamped, []);
  assert.deepEqual(report.failed, ["fixture-opt-in"]);
  assert.deepEqual(client.stamped, []);
  const result = report.results.find((r) => r.repo === "fixture-opt-in");
  assert.equal(result.action, "failed");
  assert.notEqual(result.action, "skip-current");
});

test("a mid-batch stampVersion failure reports partial progress instead of losing it", async () => {
  const repos = [
    { repo: "fixture-a", mode: "opt-in", version: "0.1.0" },
    { repo: "fixture-b", mode: "opt-in", version: "0.1.0" },
    { repo: "fixture-c", mode: "opt-in", version: "0.1.0" },
  ];
  const client = fakeClient({
    defaultMode: "opt-out",
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
  const actions = Object.fromEntries(report.results.map((r) => [r.repo, r.action]));
  assert.equal(actions["fixture-a"], "converge");
  assert.equal(actions["fixture-b"], "failed");
  assert.equal(actions["fixture-c"], "failed");
});

test("runSweepFromEnv drives runSweep against the real CURRENT_VERSION", async () => {
  // Finding 3: prior tests only ever drove the sweep against the
  // hardcoded fixture version V they pass in themselves — which is
  // 9.9.9, chosen so it can never equal the real package.json version
  // the CLI uses in production — and never went through
  // runSweepFromEnv's env -> OrgPropertiesClient -> runSweep path
  // (runSweepFromEnv takes no version argument at all — it reads
  // CURRENT_VERSION itself). runSweepFromEnv builds its own client
  // from GH_REPO_CONFIG_ORG/GH_REPO_CONFIG_TOKEN and defaults to the
  // global `fetch`, so drive it for real by substituting global.fetch
  // for the duration of this test. This is therefore the only test in
  // the file whose outcome tracks package.json at all, and the only
  // one a version bump can legitimately affect.
  //
  // The guard below pins no version literal, so the test holds at
  // whatever version package.json carries. It asserts only what the
  // fixture data below needs to mean anything: that fixture-behind's
  // "0.0.1" stamp is behind the real version. isBehind throws
  // outright if CURRENT_VERSION is not parseable X.Y.Z, so an empty or
  // corrupted package.json version fails here too. The other side of
  // the pair, fixture-current, reads CURRENT_VERSION directly rather
  // than a literal, so it tracks the bump by construction.
  // `test/version.test.js` pins CURRENT_VERSION === pkg.version.
  assert.equal(isBehind("0.0.1", CURRENT_VERSION), true);

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
              { property_name: "gh-repo-config-mode", value: "opt-in" },
              { property_name: "gh-repo-config-version", value: "0.0.1" },
            ],
          },
          {
            repository_name: "fixture-current",
            properties: [
              { property_name: "gh-repo-config-mode", value: "opt-in" },
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
    // The merge pass lists the converger's own open PRs per managed repo
    // (its list carries no `head=` filter, unlike the writer's
    // findOpenPullRequest which does). fixture-behind's converge step
    // opens PR #1 this tick; return it to the merge pass so it can merge
    // it, letting fixture-behind clear the #16 ordering gate (file
    // convergence reaches the default branch this tick) so its ruleset
    // step runs and it gets stamped. The writer's own head-filtered list
    // returns [] so a fresh PR is created (not treated as pre-existing).
    if (url.includes("/fixture-behind/pulls?state=open") && !url.includes("head=")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          {
            number: 1,
            user: { login: "test-converger[bot]", type: "Bot" },
            head: { sha: "prheadsha", ref: "gh-repo-config/converge" },
            base: { ref: "main" },
          },
        ],
      };
    }
    if (url.includes("/pulls?state=open")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => [] };
    }
    // Merge pass: no required checks on the base branch (empty rules), so
    // the PR is mergeable outright; the merge PUT succeeds.
    if (url.includes("/rules/branches/main")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => [] };
    }
    if (url.match(/\/pulls\/1\/merge$/) && method === "PUT") {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ merged: true }) };
    }
    // CodeQL default-setup convergence (issue #16): read reports
    // `configured`, so the converger PATCHes it to not-configured.
    if (url.includes("/code-scanning/default-setup") && method === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ state: "configured", languages: ["actions"] }),
      };
    }
    if (url.includes("/code-scanning/default-setup") && method === "PATCH") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ state: "not-configured" }),
      };
    }
    // Stale-configuration deletion: the shipped CodeQL
    // workflow is on the default branch, and default setup left a
    // two-analysis `/language:actions` configuration beside a third-party
    // tool's category, which survives.
    if (url.includes("/fixture-behind/contents/.github/workflows/codeql.yml")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          type: "file",
          encoding: "base64",
          content: Buffer.from("jobs:\n  codeql-required:\n").toString("base64"),
        }),
      };
    }
    if (url.includes("/code-scanning/analyses?") && method === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [
          { id: 11, category: "/language:actions" },
          { id: 12, category: "other-tool" },
          { id: 10, category: "/language:actions" },
        ],
      };
    }
    if (url.endsWith("/code-scanning/analyses/11") && method === "DELETE") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          next_analysis_url: null,
          confirm_delete_url: "https://api.github.com/x/code-scanning/analyses/10?confirm_delete",
        }),
      };
    }
    if (url.endsWith("/code-scanning/analyses/10?confirm_delete") && method === "DELETE") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ next_analysis_url: null, confirm_delete_url: null }),
      };
    }
    // Org installations: resolve both the converger and AUTOMERGE App
    // slugs to app_ids for the ruleset bypass actors, with the
    // PR-automation App granted everything its preflight requires.
    if (url.includes("/installations")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          installations: [
            { app_id: 4319606, app_slug: "test-converger" },
            {
              app_id: 3835765,
              app_slug: DEFAULT_PR_AUTOMATION_IDENTITY.appName,
              permissions: PR_AUTOMATION_REQUIRED_PERMISSIONS,
            },
          ],
        }),
      };
    }
    // protect-main ruleset convergence (issue #16): no existing ruleset,
    // no org ruleset governs, so the converger creates it.
    if (url.includes("/rulesets") && method === "GET" && !url.match(/\/rulesets\/\d+/)) {
      return { ok: true, status: 200, statusText: "OK", json: async () => [] };
    }
    if (url.includes("/rulesets") && method === "POST") {
      return {
        ok: true,
        status: 201,
        statusText: "Created",
        json: async () => ({ id: 42, name: "protect-main" }),
      };
    }
    // The real GHAS/merge-button settings-convergence step (issue #15)
    // also runs for the `converge`-decision repo. Serve its read-then-
    // write path: everything reads as not-yet-converged so every write
    // endpoint gets exercised (vulnerability-alerts, automated-security-
    // fixes, secret scanning + push protection + delegated bypass, and
    // the merge-button settings), and each write succeeds.
    if (url.includes("/vulnerability-alerts") && method === "GET") {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    if (url.includes("/vulnerability-alerts") && method === "PUT") {
      return { ok: true, status: 204, statusText: "No Content", json: async () => ({}) };
    }
    if (url.includes("/automated-security-fixes") && method === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ enabled: false, paused: false }),
      };
    }
    if (url.includes("/automated-security-fixes") && method === "PUT") {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
    }
    // The real converge step (issue #14) runs for the `converge`-decision
    // repo (fixture-behind). Serve the git-data read+write path so
    // convergence completes (opening a PR of the rendered files) and the
    // repo is stamped. An empty target tree makes every desired file
    // "changed", so the write path exercises blobs/tree/commit/ref/PR.
    // This same bare-repo-object route also serves RepoSettingsClient's
    // read (security_and_analysis + merge-button state) and its PATCH
    // writes (secret scanning, push-protection bypass, merge-button).
    // The community-file seed lookup (issue #90) reads the org's
    // `.github` repo once for the whole sweep; an org without one 404s
    // every path, which seeds nothing and is not a failure.
    if (url.includes("/repos/TheVoskamps/.github/contents/") && method === "GET") {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    if (url.endsWith("/repos/TheVoskamps/fixture-behind") && method === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ default_branch: "main" }),
      };
    }
    if (url.endsWith("/repos/TheVoskamps/fixture-behind") && method === "PATCH") {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
    }
    if (url.includes("/git/ref/heads/main")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ object: { sha: "basecommit" } }),
      };
    }
    if (url.includes("/git/trees/basecommit")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ tree: [], truncated: false }),
      };
    }
    if (url.includes("/git/blobs") && method === "POST") {
      return {
        ok: true,
        status: 201,
        statusText: "Created",
        json: async () => ({ sha: "newblob" }),
      };
    }
    if (url.includes("/git/trees") && method === "POST") {
      return {
        ok: true,
        status: 201,
        statusText: "Created",
        json: async () => ({ sha: "newtree" }),
      };
    }
    if (url.includes("/git/commits") && method === "POST") {
      return {
        ok: true,
        status: 201,
        statusText: "Created",
        json: async () => ({ sha: "newcommit" }),
      };
    }
    if (url.includes("/git/refs") && (method === "POST" || method === "PATCH")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
    }
    if (url.includes("/pulls") && method === "POST") {
      return {
        ok: true,
        status: 201,
        statusText: "Created",
        json: async () => ({
          number: 1,
          html_url: "https://example/pr/1",
          head: { ref: "gh-repo-config/converge" },
        }),
      };
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
    // fixture-behind converges (file PR #1 opened), the merge pass merges
    // PR #1 this tick, so it clears the #16 ordering gate and its ruleset
    // step runs — leaving it stamp-eligible. Nothing is deferred.
    assert.deepEqual(report.converged, ["fixture-behind"]);
    assert.deepEqual(report.stamped, ["fixture-behind"]);
    assert.deepEqual(report.rulesetDeferred, []);
    assert.deepEqual(report.failed, []);
    assert.equal(report.skippedCurrent, 1); // fixture-current, already at CURRENT_VERSION
    assert.ok(calls.some((c) => c.method === "PATCH"));
    // The PR-automation preflight and the ruleset bypass actors share
    // one installations read.
    assert.equal(calls.filter((c) => c.url.includes("/installations")).length, 1);
    // The merge pass merged fixture-behind's converger PR #1 this tick.
    assert.equal(report.merged.length, 1);
    assert.equal(report.merged[0].pr.number, 1);
    assert.deepEqual(report.awaitingChecks, []);

    // CodeQL default-setup was `configured` → driven to not-configured.
    assert.equal(report.defaultSetupResults.length, 1);
    assert.equal(report.defaultSetupResults[0].repo, "fixture-behind");
    assert.equal(report.defaultSetupResults[0].result.outcome, "changed");
    assert.deepEqual(report.defaultSetupResults[0].result.staleConfigurationsDeleted, [
      "/language:actions",
    ]);
    assert.ok(!calls.some((c) => c.method === "DELETE" && c.url.endsWith("/analyses/12")));

    // protect-main ruleset: no existing/org ruleset → created, with both
    // Apps resolved to bypass actors.
    assert.equal(report.rulesetResults.length, 1);
    assert.equal(report.rulesetResults[0].repo, "fixture-behind");
    assert.equal(report.rulesetResults[0].result.outcome, "created");
    assert.equal(report.rulesetResults[0].result.uninstalledApps, undefined);

    // Finding: runSweepFromEnv's converge callback must not discard the
    // ConvergeResult — the real convergeRepoFiles() write path opened a
    // PR for fixture-behind (an empty target tree makes every desired
    // file "changed"), and that outcome must surface in the report.
    assert.equal(report.convergeResults.length, 1);
    assert.equal(report.convergeResults[0].repo, "fixture-behind");
    const convergeResult = report.convergeResults[0].result;
    assert.equal(convergeResult.noop, false);
    assert.ok(convergeResult.changed.length > 0);
    assert.equal(convergeResult.pullRequest.number, 1);
    assert.equal(convergeResult.pullRequest.url, "https://example/pr/1");
    assert.equal(convergeResult.pullRequest.updated, false);

    // The real convergeGhasSettings() write path also ran for
    // fixture-behind and its outcome surfaces in the report.
    assert.equal(report.ghasResults.length, 1);
    assert.equal(report.ghasResults[0].repo, "fixture-behind");
    const ghasResult = report.ghasResults[0].result;
    assert.equal(ghasResult.noop, false);
    assert.ok(ghasResult.results.some((r) => r.outcome === "changed"));
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

/**
 * Run `runSweepFromEnv` against an org whose installations response is
 * `installations`, recording every call. Resolves to the sweep's
 * rejection as `error`, or `undefined` when it completed, together with
 * the recorded `calls`. Any call past the installations read throws from
 * the fake `fetch`, so it lands in `calls` and the returned `error`
 * names that call rather than a permission shortfall.
 */
async function sweepAgainstInstallations(installations, extraEnv = {}) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    if (url.includes("/installations")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ installations }) };
    }
    throw new Error(`the sweep went past the preflight: ${init.method ?? "GET"} ${url}`);
  };
  try {
    const outcome = await runSweepFromEnv({
      GH_REPO_CONFIG_ORG: "TheVoskamps",
      GH_REPO_CONFIG_TOKEN: "test-token",
      GH_REPO_CONFIG_APP_SLUG: "test-converger",
      ...extraEnv,
    }).then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    );
    return { ...outcome, calls };
  } finally {
    global.fetch = originalFetch;
  }
}

test("the PR-automation preflight fails the sweep before any repo is read or converged", async () => {
  const { issues: _absent, ...grant } = PR_AUTOMATION_REQUIRED_PERMISSIONS;
  const { error, calls } = await sweepAgainstInstallations([
    { app_id: 4319606, app_slug: "test-converger" },
    { app_id: 3835765, app_slug: DEFAULT_PR_AUTOMATION_IDENTITY.appName, permissions: grant },
  ]);
  assert.ok(error, "the sweep must throw");
  assert.match(error.message, /issues: none \(need write\)/);
  assert.match(
    error.message,
    new RegExp(`${DEFAULT_PR_AUTOMATION_IDENTITY.appName} on TheVoskamps`),
  );
  assert.deepEqual(
    calls.map((c) => c.url.replace(/\?.*/, "")),
    ["https://api.github.com/orgs/TheVoskamps/installations"],
  );
});

test("the PR-automation preflight fails the sweep when the App is not installed", async () => {
  const { error, calls } = await sweepAgainstInstallations([
    { app_id: 4319606, app_slug: "test-converger" },
  ]);
  assert.ok(error, "the sweep must throw");
  assert.match(
    error.message,
    new RegExp(`${DEFAULT_PR_AUTOMATION_IDENTITY.appName} is not installed on TheVoskamps`),
  );
  assert.equal(calls.length, 1);
});

test("the PR-automation preflight runs and fails under dry run", async () => {
  const { error, calls } = await sweepAgainstInstallations(
    [
      {
        app_id: 3835765,
        app_slug: DEFAULT_PR_AUTOMATION_IDENTITY.appName,
        permissions: { ...PR_AUTOMATION_REQUIRED_PERMISSIONS, contents: "read" },
      },
    ],
    { GH_REPO_CONFIG_DRY_RUN: "true" },
  );
  assert.ok(error, "the sweep must throw under dry run too");
  assert.match(error.message, /contents: read \(need write\)/);
  assert.equal(calls.length, 1);
});

test("the merge pass runs over every managed repo independent of the version-skip decision", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [
      { repo: "fixture-current", mode: "opt-in", version: V }, // skip-current, but may still have an open PR
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
    evaluateAndMerge: async (org, repo, pr) => ({
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
    defaultMode: "opt-out",
    repos: [
      { repo: "fixture-opt-out", mode: "opt-out", version: undefined }, // skip-unmanaged
      { repo: "fixture-opt-in", mode: "opt-in", version: V }, // skip-current, managed
    ],
  });

  const mergeCalls = [];
  const mergeClient = {
    listOwnOpenPullRequests: async (org, repo) => {
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
  assert.deepEqual(mergeCalls, ["fixture-opt-in"]);
});

test("the merge pass merges every currently-green converger PR on a repo, with no cap", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [{ repo: "fixture-opt-in", mode: "opt-in", version: V }],
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
    defaultMode: "opt-out",
    repos: [{ repo: "fixture-a", mode: "opt-in", version: V }],
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
    defaultMode: "opt-out",
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
    defaultMode: "opt-out",
    repos: [
      { repo: "fixture-a", mode: "opt-in", version: V },
      { repo: "fixture-b", mode: "opt-in", version: V },
      { repo: "fixture-c", mode: "opt-in", version: V },
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
  assert.deepEqual(report.merged.map((m) => m.pr.number).sort(), [1, 3]);
  assert.deepEqual(report.awaitingChecks, []);

  // fixture-b is recorded as failed, not silently dropped.
  assert.deepEqual(report.failed, ["fixture-b"]);
  const fixtureBResult = report.results.find((r) => r.repo === "fixture-b");
  assert.equal(fixtureBResult.action, "failed");
  assert.match(fixtureBResult.reason, /merge pass failed/);
  assert.match(fixtureBResult.reason, /simulated 500 from list-PRs/);

  // fixture-a and fixture-c are not marked failed.
  assert.equal(report.results.find((r) => r.repo === "fixture-a").action, "skip-current");
  assert.equal(report.results.find((r) => r.repo === "fixture-c").action, "skip-current");

  assert.ok(logs.some((l) => l.includes("fixture-b: merge pass failed")));
});

test("dryRun is passed through to evaluateAndMerge so the merge pass never issues a merge", async () => {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [{ repo: "fixture-a", mode: "opt-in", version: "0.1.0" }],
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

// Stale `/language:*` configuration deletion after the merge pass. Each
// repo is behind and opens a converger PR; `merges` names the repos whose
// PR the merge pass merges. `defaultSetup` stands in for the default-setup
// step, which runs before that merge, and `deleteStale` for the post-merge
// deletion.
function staleRerunSweep({ repos, merges, defaultSetup, deleteStale }) {
  const events = [];
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: repos.map((repo) => ({ repo, mode: "opt-in", version: "0.1.0" })),
    stampVersionImpl: async (names) => {
      events.push(`stamp ${names.join(",")}`);
    },
  });
  const openPr = (repo) => ({
    number: 1,
    headSha: `sha-${repo}`,
    headRef: "converger/work",
    baseRef: "main",
    authorLogin: "test-converger[bot]",
    authorType: "Bot",
  });
  const mergeClient = {
    listOwnOpenPullRequests: async (org, repo) => [openPr(repo)],
    evaluateAndMerge: async (org, repo, pr) => {
      const outcome = merges.includes(repo) ? "merged" : "pending";
      events.push(`${outcome} ${repo}`);
      return { pr, outcome, checks: [], reason: outcome };
    },
  };
  const options = {
    log: () => {},
    mergeClient,
    appSlug: "test-converger",
    converge: () => ({ noop: false, changed: [".github/workflows/codeql.yml"] }),
    convergeDefaultSetup: (repo) => {
      events.push(`default-setup ${repo}`);
      return defaultSetup(repo);
    },
    deleteStaleConfigurations: async (repo) => {
      events.push(`delete ${repo}`);
      return deleteStale(repo);
    },
    convergeRuleset: (repo) => {
      events.push(`ruleset ${repo}`);
    },
  };
  return { client, events, options };
}

const GUARD_SKIP =
  "the default branch has no .github/workflows/codeql.yml with a codeql-required job";

test("a repo whose codeql.yml merges in the merge pass has its /language:* configurations deleted before it is stamped", async () => {
  const { client, events, options } = staleRerunSweep({
    repos: ["fixture-a"],
    merges: ["fixture-a"],
    defaultSetup: () => ({
      outcome: "changed",
      reason: "was configured → not-configured",
      staleConfigurationsDeleted: [],
      staleConfigurationsSkipped: GUARD_SKIP,
    }),
    deleteStale: () => ({ deleted: ["/language:python", "/language:actions"] }),
  });

  const report = await runSweep(client, "TheVoskamps", V, options);

  assert.deepEqual(events, [
    "default-setup fixture-a",
    "merged fixture-a",
    "delete fixture-a",
    "ruleset fixture-a",
    "stamp fixture-a",
  ]);
  assert.deepEqual(report.stamped, ["fixture-a"]);
  assert.deepEqual(report.defaultSetupResults, [
    {
      repo: "fixture-a",
      result: {
        outcome: "changed",
        reason: "was configured → not-configured",
        staleConfigurationsDeleted: ["/language:python", "/language:actions"],
      },
    },
  ]);
});

test("the post-merge deletion keeps what the default-setup step deleted, and reports its own skip", async () => {
  const { client, options } = staleRerunSweep({
    repos: ["fixture-a"],
    merges: ["fixture-a"],
    defaultSetup: () => ({
      outcome: "already-converged",
      staleConfigurationsDeleted: ["/language:go"],
    }),
    deleteStale: () => ({
      deleted: ["/language:go", "/language:ruby"],
      skipped: "code scanning analysis deletion unavailable (403) at /language:swift",
    }),
  });

  const report = await runSweep(client, "TheVoskamps", V, options);

  assert.deepEqual(report.defaultSetupResults[0].result, {
    outcome: "already-converged",
    staleConfigurationsDeleted: ["/language:go", "/language:ruby"],
    staleConfigurationsSkipped:
      "code scanning analysis deletion unavailable (403) at /language:swift",
  });
  assert.deepEqual(report.stamped, ["fixture-a"]);
});

test("the post-merge deletion skips a repo whose PR did not merge, or whose default setup was skipped", async () => {
  const { client, events, options } = staleRerunSweep({
    repos: ["fixture-open", "fixture-unavailable"],
    merges: ["fixture-unavailable"],
    defaultSetup: (repo) =>
      repo === "fixture-unavailable"
        ? {
            outcome: "skipped",
            reason: "code scanning unavailable (404)",
            staleConfigurationsDeleted: [],
          }
        : { outcome: "already-converged", staleConfigurationsDeleted: [] },
    deleteStale: () => {
      throw new Error("must not run");
    },
  });

  const report = await runSweep(client, "TheVoskamps", V, options);

  assert.ok(!events.some((e) => e.startsWith("delete ")));
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.rulesetDeferred, ["fixture-open"]);
  assert.deepEqual(report.stamped, ["fixture-unavailable"]);
});

test("a post-merge deletion failure marks the repo failed and leaves it unstamped", async () => {
  const { client, events, options } = staleRerunSweep({
    repos: ["fixture-a", "fixture-b"],
    merges: ["fixture-a", "fixture-b"],
    defaultSetup: () => ({ outcome: "already-converged", staleConfigurationsDeleted: [] }),
    deleteStale: (repo) => {
      if (repo === "fixture-a") throw new Error("Failed to list code-scanning analyses: 500");
      return { deleted: [] };
    },
  });

  const report = await runSweep(client, "TheVoskamps", V, options);

  assert.deepEqual(report.failed, ["fixture-a"]);
  assert.match(
    report.results.find((r) => r.repo === "fixture-a").reason,
    /stale CodeQL configuration deletion failed: .*500/,
  );
  assert.ok(!events.includes("ruleset fixture-a"));
  assert.deepEqual(report.stamped, ["fixture-b"]);
});

// Issue #67: the default read reports provenance, so an operator can
// tell a genuinely declared default from an org whose control plane was
// never provisioned. Selection behavior is identical across all three
// cases. Issue #68 makes `defined-no-value` fail the CLI too: a
// `default_value` is accepted only on a required property, so a mode
// property carrying none is provisioning drift, not a steady state.

const PROVENANCE_CASES = [
  {
    name: "set",
    read: { provenance: "set", raw: "opt-out" },
    expectedProvenance: "set",
    failsCli: false,
  },
  {
    name: "defined-no-value",
    read: { provenance: "defined-no-value" },
    expectedProvenance: "defined-no-value",
    failsCli: true,
  },
  {
    name: "not-defined",
    read: { provenance: "not-defined" },
    expectedProvenance: "not-defined",
    failsCli: true,
  },
];

test("sweep reports default provenance without changing the resolved value", async () => {
  const headers = new Map();
  for (const testCase of PROVENANCE_CASES) {
    const client = fakeClient({
      defaultModeRead: testCase.read,
      repos: [{ repo: "fixture-unset", mode: undefined, version: undefined }],
    });
    const logs = [];
    const report = await runSweep(client, "TheVoskamps", V, {
      log: (m) => logs.push(m),
    });

    assert.equal(report.defaultModeProvenance, testCase.expectedProvenance);
    // The fail-safe collapse is untouched: every case resolves to
    // opt-out, under which an unset repo is unmanaged.
    assert.equal(report.defaultMode, "opt-out");
    assert.equal(report.skippedUnmanaged, 1);
    assert.deepEqual(report.converged, []);
    headers.set(testCase.name, logs[0]);
  }

  // Each provenance renders a header line distinct from the other two —
  // the whole point of the change.
  assert.equal(new Set(headers.values()).size, PROVENANCE_CASES.length);
});

test("the raw default_value is carried into the sweep header line", async () => {
  const client = fakeClient({
    defaultModeRead: { provenance: "set", raw: "optin" },
    repos: [{ repo: "fixture-unset", mode: undefined, version: undefined }],
  });
  const logs = [];
  const report = await runSweep(client, "TheVoskamps", V, {
    log: (m) => logs.push(m),
  });

  // A typo'd default still resolves to the fail-safe opt-out, but reads
  // as a typo in the log rather than as a clean opt-out.
  assert.equal(report.defaultMode, "opt-out");
  assert.match(logs[0], /optin/);
});

test("the declared default is named in the sweep header line", async () => {
  const client = fakeClient({
    defaultModeRead: { provenance: "set", raw: "opt-in" },
    repos: [{ repo: "fixture-unset", mode: undefined, version: undefined }],
  });
  const logs = [];
  const report = await runSweep(client, "TheVoskamps", V, {
    log: (m) => logs.push(m),
  });

  // A declared opt-in default manages the unset repo — the read-through
  // the sweep applies itself rather than assuming of the values API.
  assert.equal(report.defaultMode, "opt-in");
  assert.deepEqual(report.converged, ["fixture-unset"]);
  assert.match(logs[0], /gh-repo-config-mode default_value="opt-in"/);
});

test("both no-value provenances produce the CLI's non-zero-exit line", async () => {
  for (const testCase of PROVENANCE_CASES) {
    const client = fakeClient({
      defaultModeRead: testCase.read,
      repos: [{ repo: "fixture-unset", mode: undefined, version: undefined }],
    });
    const report = await runSweep(client, "TheVoskamps", V, { log: () => {} });
    const failure = describeDefaultModeProvenanceFailure(report);

    if (testCase.failsCli) {
      assert.ok(failure, `${testCase.name} should produce a failure line`);
      assert.match(failure, /gh-repo-config-mode/);
      assert.match(failure, /TheVoskamps/);
    } else {
      assert.equal(failure, undefined, `${testCase.name} should exit zero absent other failures`);
    }
    // The full tick still ran in every case — the fix is reporting and
    // exit status, not semantics.
    assert.equal(report.results.length, 1);
  }
});

// Issue #92: the merge pass reserves the sweeper workflow's path for a
// human on the sweeper repo under `manual`, and nowhere else. What the
// exclusion then DOES with that path is MergeClient's half
// (test/merge.test.js); these cases pin which repo gets it and when.
async function reservedPathsPerRepo(sweepOptions) {
  const client = fakeClient({
    defaultMode: "opt-out",
    repos: [
      { repo: "the-sweeper", mode: "opt-in", version: V },
      { repo: "an-ordinary-repo", mode: "opt-in", version: V },
    ],
  });
  const seen = {};
  const mergeClient = {
    listOwnOpenPullRequests: async () => [
      {
        number: 1,
        headSha: "sha1",
        headRef: "converger/work",
        baseRef: "main",
        authorLogin: "test-converger[bot]",
        authorType: "Bot",
      },
    ],
    evaluateAndMerge: async (org, repo, pr, dryRun, options) => {
      seen[repo] = [...(options?.humanApprovalPaths ?? [])];
      return { pr, outcome: "merged", checks: [], reason: "green" };
    },
  };
  await runSweep(client, "TheVoskamps", V, {
    log: () => {},
    mergeClient,
    appSlug: "test-converger",
    ...sweepOptions,
  });
  return seen;
}

test("under manual, only the sweeper repo's PRs reserve the sweeper workflow path (issue #92)", async () => {
  const seen = await reservedPathsPerRepo({
    sweeperRepo: "TheVoskamps/the-sweeper",
    sweeperUpdatePolicy: "manual",
  });
  assert.deepEqual(seen, {
    "the-sweeper": [SWEEPER_WORKFLOW_PATH],
    "an-ordinary-repo": [],
  });
});

test("an absent policy reserves the path exactly as manual does, matching the payload default (issue #92)", async () => {
  const seen = await reservedPathsPerRepo({
    sweeperRepo: "TheVoskamps/the-sweeper",
  });
  assert.deepEqual(seen["the-sweeper"], [SWEEPER_WORKFLOW_PATH]);
});

test("auto and off reserve nothing, and neither does a tick with no sweeper repo (issue #92)", async () => {
  for (const policy of ["auto", "off"]) {
    const seen = await reservedPathsPerRepo({
      sweeperRepo: "TheVoskamps/the-sweeper",
      sweeperUpdatePolicy: policy,
    });
    assert.deepEqual(seen, { "the-sweeper": [], "an-ordinary-repo": [] }, policy);
  }
  const noSweeper = await reservedPathsPerRepo({ sweeperUpdatePolicy: "manual" });
  assert.deepEqual(noSweeper, { "the-sweeper": [], "an-ordinary-repo": [] });
});
