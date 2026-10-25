import { test } from "node:test";
import assert from "node:assert/strict";
import { RulesetsClient } from "../dist/index.js";

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
    client: new RulesetsClient({ token: "t", apiBase: "https://api", fetch: doFetch }),
  };
}

function jsonResp(status, body, ok = status >= 200 && status < 300) {
  return {
    ok,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("readInstallationsBySlug maps every installed App slug to its app_id and permissions", async () => {
  const { client: c } = client((url) => {
    if (url.includes("/installations"))
      return jsonResp(200, {
        installations: [
          { app_id: 111, app_slug: "converger", permissions: { contents: "write" } },
          // No `permissions` field at all: read as an empty grant.
          { app_id: 222, app_slug: "automerge" },
        ],
      });
  });
  const map = await c.readInstallationsBySlug("O");
  assert.deepEqual(map.get("converger"), { appId: 111, permissions: { contents: "write" } });
  assert.deepEqual(map.get("automerge"), { appId: 222, permissions: {} });
  assert.equal(map.get("not-installed"), undefined);
});

test("readInstallationsBySlug follows pagination", async () => {
  const page = (n, from) =>
    Array.from({ length: n }, (_, i) => ({ app_id: from + i, app_slug: `app-${from + i}` }));
  const { client: c, calls } = client((url) => {
    if (url.endsWith("&page=1")) return jsonResp(200, { installations: page(100, 0) });
    if (url.endsWith("&page=2")) return jsonResp(200, { installations: page(1, 100) });
  });
  const map = await c.readInstallationsBySlug("O");
  assert.equal(map.size, 101);
  assert.equal(map.get("app-100").appId, 100);
  assert.equal(calls.length, 2);
});

test("createRuleset classifies a code_quality-attributable 422 as code-quality-422", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/rulesets") && method === "POST")
      return jsonResp(
        422,
        { message: "The rule type `code_quality` is not available for this repository" },
        false,
      );
  });
  const res = await c.createRuleset("O", "r", { rules: [] });
  assert.equal(res.kind, "code-quality-422");
});

test("createRuleset throws on a 422 not attributable to code_quality", async () => {
  const { client: c } = client((url, method) => {
    if (url.includes("/rulesets") && method === "POST")
      return jsonResp(422, { message: "Validation failed: name already exists" }, false);
  });
  await assert.rejects(() => c.createRuleset("O", "r", { rules: [] }), /422/);
});

test("deleteRuleset treats a 404 (already gone) as success", async () => {
  const { client: c } = client((url, method) => {
    if (method === "DELETE") return jsonResp(404, {}, false);
  });
  await assert.doesNotReject(() => c.deleteRuleset("O", "r", 7));
});

test("listRulesets requests includes_parents so an inherited org ruleset is visible", async () => {
  const { client: c, calls } = client((url) => {
    if (url.includes("/rulesets")) return jsonResp(200, []);
  });
  await c.listRulesets("O", "r");
  assert.ok(calls.some((x) => x.url.includes("includes_parents=true")));
});
