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

test("default-setup: configured -> PATCHed to not-configured (changed)", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: ["actions", "python"] });
    if (url.includes("/default-setup") && method === "PATCH") return resp(200, {});
  });
  const result = await convergeDefaultSetup(c, "O", "r", false);
  assert.equal(result.outcome, "changed");
  assert.match(result.reason, /was configured/);
  assert.match(result.reason, /python/);
  // Read-then-write: exactly one GET then one PATCH.
  assert.equal(calls.filter((x) => x.method === "GET").length, 1);
  assert.equal(calls.filter((x) => x.method === "PATCH").length, 1);
});

test("default-setup: already not-configured -> no write (already-converged)", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "not-configured", languages: [] });
    if (method === "PATCH") throw new Error("must not write when already converged");
  });
  const result = await convergeDefaultSetup(c, "O", "r", false);
  assert.equal(result.outcome, "already-converged");
  assert.equal(calls.filter((x) => x.method === "PATCH").length, 0);
});

test("default-setup: dryRun computes the diff without writing", async () => {
  const { client: c, calls } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: [] });
    if (method === "PATCH") throw new Error("dryRun must not write");
  });
  const result = await convergeDefaultSetup(c, "O", "r", true);
  assert.equal(result.outcome, "changed");
  assert.equal(calls.filter((x) => x.method === "PATCH").length, 0);
});

test("default-setup: a 404 read (feature unavailable) is report-and-skip, not a failure", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(404, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false);
  assert.equal(result.outcome, "skipped");
  assert.match(result.reason, /unavailable/);
});

test("default-setup: a 403 read (no plan) is report-and-skip, not a failure", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(403, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false);
  assert.equal(result.outcome, "skipped");
});

test("default-setup: a 401 read (auth/scope) is a real failure and throws", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET") return resp(401, {}, false);
  });
  await assert.rejects(() => convergeDefaultSetup(c, "O", "r", false), /401/);
});

test("default-setup: a 404 on the PATCH itself is report-and-skip, not a failure", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: [] });
    if (url.includes("/default-setup") && method === "PATCH") return resp(404, {}, false);
  });
  const result = await convergeDefaultSetup(c, "O", "r", false);
  assert.equal(result.outcome, "skipped");
});

test("default-setup: a 500 on the PATCH is a real failure and throws", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/default-setup") && method === "GET")
      return resp(200, { state: "configured", languages: [] });
    if (url.includes("/default-setup") && method === "PATCH") return resp(500, {}, false);
  });
  await assert.rejects(() => convergeDefaultSetup(c, "O", "r", false), /500/);
});
