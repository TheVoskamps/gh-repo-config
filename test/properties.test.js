import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OrgPropertiesClient,
  PartialStampError,
  PROPERTY_NAMES,
  MAX_REPOS_PER_BATCH,
  normalizeDefaultMode,
} from "../dist/index.js";

// Build a fake fetch that records calls and returns canned responses
// keyed by URL substring + method.
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

test("readDefaultMode reports provenance 'set' with the raw schema default_value", async () => {
  const fetch = fakeFetch([
    {
      match: `/properties/schema/${PROPERTY_NAMES.mode}`,
      body: { default_value: "opt-in" },
    },
  ]);
  const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
  assert.deepEqual(await client.readDefaultMode(), {
    provenance: "set",
    raw: "opt-in",
  });
});

test("readDefaultMode reports an unrecognized value as 'set' with its raw text", async () => {
  const fetch = fakeFetch([
    {
      match: `/properties/schema/${PROPERTY_NAMES.mode}`,
      body: { default_value: "optin" },
    },
  ]);
  const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
  assert.deepEqual(await client.readDefaultMode(), {
    provenance: "set",
    raw: "optin",
  });
  // The typo still normalizes to the fail-safe opt-out — the raw value is
  // reported so the typo is visible, not so it changes selection.
  assert.equal(normalizeDefaultMode("optin"), "opt-out");
});

test("readDefaultMode reports provenance 'defined-no-value' on a 200 with no default", async () => {
  for (const body of [{}, { default_value: null }]) {
    const fetch = fakeFetch([
      { match: `/properties/schema/${PROPERTY_NAMES.mode}`, body },
    ]);
    const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
    assert.deepEqual(await client.readDefaultMode(), {
      provenance: "defined-no-value",
    });
  }
});

test("readDefaultMode reports provenance 'not-defined' on 404", async () => {
  const fetch = fakeFetch([
    {
      match: `/properties/schema/${PROPERTY_NAMES.mode}`,
      status: 404,
      statusText: "Not Found",
      body: {},
    },
  ]);
  const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
  assert.deepEqual(await client.readDefaultMode(), {
    provenance: "not-defined",
  });
});

test("PROPERTY_NAMES no longer carries a separate org-default property", () => {
  // Issue #68 retired the org-level default property: selection reads one
  // property at both levels, so a second name here would be a second
  // source of truth to drift.
  assert.deepEqual(Object.keys(PROPERTY_NAMES).sort(), ["mode", "version"]);
});

test("readAllRepoValues projects mode and version, unset -> undefined", async () => {
  const fetch = fakeFetch([
    {
      match: "/properties/values?",
      body: [
        {
          repository_name: "r1",
          properties: [
            { property_name: PROPERTY_NAMES.mode, value: "opt-in" },
            { property_name: PROPERTY_NAMES.version, value: "0.1.0" },
          ],
        },
        {
          repository_name: "r2",
          properties: [
            { property_name: PROPERTY_NAMES.mode, value: null },
          ],
        },
      ],
    },
  ]);
  const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
  const values = await client.readAllRepoValues();
  assert.deepEqual(values, [
    { repo: "r1", mode: "opt-in", version: "0.1.0" },
    { repo: "r2", mode: undefined, version: undefined },
  ]);
});

test("stampVersion batches at the 30-repo cap", async () => {
  const fetch = fakeFetch([
    { match: "/properties/values", method: "PATCH", body: {} },
  ]);
  const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
  const repos = Array.from({ length: 65 }, (_, i) => `r${i}`);
  await client.stampVersion(repos, "0.2.0");

  const patches = fetch.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 3); // 30 + 30 + 5
  const first = JSON.parse(patches[0].body);
  assert.equal(first.repository_names.length, MAX_REPOS_PER_BATCH);
  assert.equal(first.properties[0].property_name, PROPERTY_NAMES.version);
  assert.equal(first.properties[0].value, "0.2.0");
  assert.equal(JSON.parse(patches[2].body).repository_names.length, 5);
});

test("stampVersion reports partial progress on a mid-batch failure", async () => {
  // First batch (30 repos) succeeds; second batch (30 repos) fails;
  // third batch (5 repos) is never attempted. The client must not lose
  // track of the first batch's success when it throws.
  let patchCount = 0;
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url.includes("/properties/values") && method === "PATCH") {
      patchCount++;
      if (patchCount === 2) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
  const repos = Array.from({ length: 65 }, (_, i) => `r${i}`);

  await assert.rejects(
    () => client.stampVersion(repos, "0.2.0"),
    (err) => {
      assert.ok(err instanceof PartialStampError);
      assert.deepEqual(err.stamped, repos.slice(0, 30));
      assert.deepEqual(err.failedBatch, repos.slice(30, 60));
      assert.deepEqual(err.notAttempted, repos.slice(60));
      return true;
    },
  );
  assert.equal(patchCount, 2); // third batch never attempted
});

test("readAllRepoValues throws on a non-ok values response", async () => {
  const fetch = fakeFetch([
    {
      match: "/properties/values?",
      status: 403,
      statusText: "Forbidden",
      body: {},
    },
  ]);
  const client = new OrgPropertiesClient({ org: "Org", token: "t", fetch });
  await assert.rejects(() => client.readAllRepoValues(), /403/);
});
