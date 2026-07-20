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
  return { calls, client: new RulesetsClient({ token: "t", apiBase: "https://api", fetch: doFetch }) };
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

test("readAppIdsBySlug maps every installed App slug to its app_id", async () => {
  const { client: c } = client((url) => {
    if (url.includes("/installations"))
      return jsonResp(200, {
        installations: [
          { app_id: 111, app_slug: "converger" },
          { app_id: 222, app_slug: "automerge" },
        ],
      });
  });
  const map = await c.readAppIdsBySlug("O");
  assert.equal(map.get("converger"), 111);
  assert.equal(map.get("automerge"), 222);
  assert.equal(map.get("not-installed"), undefined);
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
