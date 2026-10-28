import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeScanningClient, convergeDefaultSetup } from "../dist/index.js";

// A CodeScanningClient wired to an injected fetch, recording calls.
function client(routes) {
  const calls = [];
  const doFetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method });
    const route = routes(url, method);
    if (!route) throw new Error(`unexpected fetch: ${method} ${url}`);
    return route;
  };
  return {
    calls,
    client: new CodeScanningClient({ token: "t", apiBase: "https://api", fetch: doFetch }),
  };
}

function resp(status, body = {}, ok = status >= 200 && status < 300) {
  return { ok, status, statusText: String(status), json: async () => body };
}

const SHIPPED_WORKFLOW = "jobs:\n  codeql-required:\n    name: codeql-required\n";

// The default-branch reads the stale-configuration guard makes; the
// workflow is absent when `workflow` is null.
function defaultBranch(workflow = SHIPPED_WORKFLOW) {
  return {
    getDefaultBranch: async () => "main",
    readFileIfPresent: async (_owner, _repo, path) => {
      assert.equal(path, ".github/workflows/codeql.yml");
      return workflow ?? undefined;
    },
  };
}

// No analyses on the default branch: the deletion finds nothing.
function noAnalyses(url, method) {
  if (url.includes("/code-scanning/analyses?") && method === "GET") return resp(200, []);
}

test("default-setup: configured -> PATCHed to not-configured (changed)", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: ["actions", "python"] });
    if (url.includes("/default-setup") && method === "PATCH") return resp(200, {});
    return noAnalyses(url, method);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "changed");
  assert.match(result.reason, /was configured/);
  assert.match(result.reason, /python/);
  assert.deepEqual(result.staleConfigurationsDeleted, []);
  // Read-then-write: exactly one default-setup GET then one PATCH.
  assert.equal(
    calls.filter((x) => x.url.includes("/default-setup") && x.method === "GET").length,
    1,
  );
  assert.equal(calls.filter((x) => x.method === "PATCH").length, 1);
});

test("default-setup: already not-configured -> no write (already-converged)", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "not-configured", languages: [] });
    if (method === "PATCH") throw new Error("must not write when already converged");
    return noAnalyses(url, method);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "already-converged");
  assert.equal(calls.filter((x) => x.method === "PATCH").length, 0);
});

test("default-setup: dryRun computes the diff without writing", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: [] });
    if (method === "PATCH") throw new Error("dryRun must not write");
    return noAnalyses(url, method);
  });
  const result = await convergeDefaultSetup(c, "O", "r", true, defaultBranch());
  assert.equal(result.outcome, "changed");
  assert.equal(calls.filter((x) => x.method === "PATCH").length, 0);
});

test("default-setup: a 404 read (feature unavailable) is report-and-skip, not a failure", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(404, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "skipped");
  assert.match(result.reason, /unavailable/);
});

test("default-setup: a 403 read (no plan) is report-and-skip, not a failure", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(403, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "skipped");
});

test("default-setup: a 401 read (auth/scope) is a real failure and throws", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(401, {}, false);
  });
  await assert.rejects(() => convergeDefaultSetup(c, "O", "r", false, defaultBranch()), /401/);
});

test("default-setup: a 404 on the PATCH itself is report-and-skip, not a failure", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: [] });
    if (url.includes("/default-setup") && method === "PATCH") return resp(404, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "skipped");
});

test("default-setup: a 500 on the PATCH is a real failure and throws", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: [] });
    if (url.includes("/default-setup") && method === "PATCH") return resp(500, {}, false);
  });
  await assert.rejects(() => convergeDefaultSetup(c, "O", "r", false, defaultBranch()), /500/);
});

// ---------------------------------------------------------------------
// Stale `/language:*` configuration deletion (issue #158)
// ---------------------------------------------------------------------

// The default branch carries, newest first: two `/language:python`
// analyses, one `/language:actions` analysis, and a third-party tool's.
const ANALYSES = [
  { id: 31, category: "/language:python" },
  { id: 30, category: "other-tool/scan" },
  { id: 21, category: "/language:actions" },
  { id: 20, category: "/language:python" },
];

// Default setup in `state`, the analyses above, and a deletion endpoint
// that walks each configuration down to nothing: python 31 -> confirm 20,
// actions 21 (its last, so confirmed up front).
function staleRepo(state) {
  return (url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(200, { state });
    if (url.includes("/default-setup") && method === "PATCH") return resp(200, {});
    if (url.includes("/code-scanning/analyses?") && method === "GET") return resp(200, ANALYSES);
    if (method !== "DELETE") return undefined;
    if (url === "https://api/repos/O/r/code-scanning/analyses/31")
      return resp(200, {
        next_analysis_url: null,
        confirm_delete_url: "https://api/repos/O/r/code-scanning/analyses/20?confirm_delete",
      });
    if (
      url === "https://api/repos/O/r/code-scanning/analyses/20?confirm_delete" ||
      url === "https://api/repos/O/r/code-scanning/analyses/21?confirm_delete"
    )
      return resp(200, { next_analysis_url: null, confirm_delete_url: null });
  };
}

const deletes = (calls) => calls.filter((x) => x.method === "DELETE").map((x) => x.url);

test("stale configurations: already not-configured deletes every /language:* configuration", async () => {
  const { client: c, calls } = client(staleRepo("not-configured"));
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "already-converged");
  assert.deepEqual(result.staleConfigurationsDeleted, ["/language:python", "/language:actions"]);
  assert.equal(result.staleConfigurationsSkipped, undefined);
  assert.deepEqual(deletes(calls), [
    "https://api/repos/O/r/code-scanning/analyses/31",
    "https://api/repos/O/r/code-scanning/analyses/20?confirm_delete",
    "https://api/repos/O/r/code-scanning/analyses/21?confirm_delete",
  ]);
  const list = calls.find((x) => x.url.includes("/code-scanning/analyses?"));
  assert.match(list.url, /tool_name=CodeQL/);
  assert.match(list.url, /ref=refs%2Fheads%2Fmain/);
});

test("stale configurations: a PATCH to not-configured deletes them in the same sweep", async () => {
  const { client: c, calls } = client(staleRepo("configured"));
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "changed");
  assert.deepEqual(result.staleConfigurationsDeleted, ["/language:python", "/language:actions"]);
  const patchAt = calls.findIndex((x) => x.method === "PATCH");
  const firstDelete = calls.findIndex((x) => x.method === "DELETE");
  assert.ok(patchAt >= 0 && patchAt < firstDelete);
});

test("stale configurations: a category outside /language: survives", async () => {
  const { client: c, calls } = client(staleRepo("not-configured"));
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.ok(!result.staleConfigurationsDeleted.includes("other-tool/scan"));
  assert.ok(!deletes(calls).some((url) => /\/analyses\/30\b/.test(url)));
});

test("stale configurations: the loop follows next_analysis_url, then confirm_delete_url, and stops on neither", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "not-configured" });
    if (url.includes("/code-scanning/analyses?") && method === "GET")
      return resp(200, [
        { id: 3, category: "/language:go" },
        { id: 2, category: "/language:go" },
        { id: 1, category: "/language:go" },
      ]);
    if (method !== "DELETE") return undefined;
    if (url === "https://api/repos/O/r/code-scanning/analyses/3")
      return resp(200, {
        next_analysis_url: "https://api/next/2",
        confirm_delete_url: "https://api/next/2?confirm_delete",
      });
    if (url === "https://api/next/2")
      return resp(200, {
        next_analysis_url: null,
        confirm_delete_url: "https://api/next/1?confirm_delete",
      });
    if (url === "https://api/next/1?confirm_delete")
      return resp(200, { next_analysis_url: null, confirm_delete_url: null });
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.deepEqual(result.staleConfigurationsDeleted, ["/language:go"]);
  assert.deepEqual(deletes(calls), [
    "https://api/repos/O/r/code-scanning/analyses/3",
    "https://api/next/2",
    "https://api/next/1?confirm_delete",
  ]);
});

test("stale configurations: the analyses list is read page by page until a short page", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: 1000 - i, category: "other" }));
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "not-configured" });
    if (url.includes("/code-scanning/analyses?") && url.endsWith("&page=1"))
      return resp(200, fullPage);
    if (url.includes("/code-scanning/analyses?") && url.endsWith("&page=2"))
      return resp(200, [{ id: 5, category: "/language:ruby" }]);
    if (url === "https://api/repos/O/r/code-scanning/analyses/5?confirm_delete")
      return resp(200, { next_analysis_url: null, confirm_delete_url: null });
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.deepEqual(result.staleConfigurationsDeleted, ["/language:ruby"]);
  assert.equal(calls.filter((x) => x.url.includes("/code-scanning/analyses?")).length, 2);
});

test("stale configurations: a skipped default-setup read keeps them", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(404, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "skipped");
  assert.deepEqual(result.staleConfigurationsDeleted, []);
  assert.ok(!calls.some((x) => x.url.includes("/code-scanning/analyses")));
});

test("stale configurations: a skipped default-setup write keeps them", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured" });
    if (url.includes("/default-setup") && method === "PATCH") return resp(403, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
  assert.equal(result.outcome, "skipped");
  assert.deepEqual(result.staleConfigurationsDeleted, []);
  assert.ok(!calls.some((x) => x.url.includes("/code-scanning/analyses")));
});

test("stale configurations: a default branch without codeql.yml keeps them", async () => {
  const { client: c, calls } = client(staleRepo("not-configured"));
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch(null));
  assert.deepEqual(result.staleConfigurationsDeleted, []);
  assert.match(result.staleConfigurationsSkipped, /codeql-required/);
  assert.ok(!calls.some((x) => x.url.includes("/code-scanning/analyses")));
});

test("stale configurations: a codeql.yml without the codeql-required job keeps them", async () => {
  const { client: c, calls } = client(staleRepo("not-configured"));
  const matrixShape = "jobs:\n  analyze:\n    needs: codeql-required\n    name: codeql-required\n";
  const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch(matrixShape));
  assert.deepEqual(result.staleConfigurationsDeleted, []);
  assert.match(result.staleConfigurationsSkipped, /codeql-required/);
  assert.ok(!calls.some((x) => x.url.includes("/code-scanning/analyses")));
});

test("stale configurations: a dry run deletes nothing and names each configuration it would delete", async () => {
  for (const state of ["configured", "not-configured"]) {
    const { client: c, calls } = client(staleRepo(state));
    const result = await convergeDefaultSetup(c, "O", "r", true, defaultBranch());
    assert.deepEqual(result.staleConfigurationsDeleted, ["/language:python", "/language:actions"]);
    assert.deepEqual(deletes(calls), []);
    assert.equal(calls.filter((x) => x.method === "PATCH").length, 0);
  }
});

test("stale configurations: a dry run applies the codeql.yml guard", async () => {
  const { client: c } = client(staleRepo("not-configured"));
  const result = await convergeDefaultSetup(c, "O", "r", true, defaultBranch(null));
  assert.deepEqual(result.staleConfigurationsDeleted, []);
  assert.match(result.staleConfigurationsSkipped, /codeql-required/);
});

for (const status of [403, 404]) {
  test(`stale configurations: a ${status} on the analyses list skips the step with a reason`, async () => {
    const { client: c, calls } = client((url, method) => {
      if (url.includes("/default-setup") && method === "GET")
        return resp(200, { state: "not-configured" });
      if (url.includes("/code-scanning/analyses?")) return resp(status, {}, false);
    });
    const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
    assert.equal(result.outcome, "already-converged");
    assert.deepEqual(result.staleConfigurationsDeleted, []);
    assert.match(result.staleConfigurationsSkipped, new RegExp(`unavailable \\(${status}\\)`));
    assert.deepEqual(deletes(calls), []);
  });

  test(`stale configurations: a ${status} on a deletion skips the rest with a reason`, async () => {
    const { client: c } = client((url, method) => {
      const route = staleRepo("not-configured")(url, method);
      if (url.endsWith("/analyses/21?confirm_delete")) return resp(status, {}, false);
      return route;
    });
    const result = await convergeDefaultSetup(c, "O", "r", false, defaultBranch());
    assert.equal(result.outcome, "already-converged");
    assert.deepEqual(result.staleConfigurationsDeleted, ["/language:python"]);
    assert.match(result.staleConfigurationsSkipped, new RegExp(`unavailable \\(${status}\\)`));
  });
}

test("stale configurations: a 500 on the analyses list is a real failure and throws", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "not-configured" });
    if (url.includes("/code-scanning/analyses?")) return resp(500, {}, false);
  });
  await assert.rejects(() => convergeDefaultSetup(c, "O", "r", false, defaultBranch()), /500/);
});

test("stale configurations: a 400 on a deletion is a real failure and throws", async () => {
  const { client: c } = client((url, method) => {
    const route = staleRepo("not-configured")(url, method);
    if (url.endsWith("/analyses/31")) return resp(400, {}, false);
    return route;
  });
  await assert.rejects(() => convergeDefaultSetup(c, "O", "r", false, defaultBranch()), /400/);
});
