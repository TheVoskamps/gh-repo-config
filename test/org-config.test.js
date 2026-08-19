import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseOrgConfig,
  readOrgConfig,
  assertVersionPinSatisfied,
  parseSweeperRepo,
  DEFAULT_ORG_CONFIG,
  DEFAULT_SWEEPER_UPDATE_POLICY,
  SWEEPER_UPDATE_POLICIES,
  DEFAULT_PR_AUTOMATION_IDENTITY,
  CURRENT_VERSION,
  runSweepFromEnv,
} from "../dist/index.js";

const ORG = "TheVoskamps";
const REPO = "fixture-behind";

const IDENTITY_JSON = {
  "app-name": "acme-pr-automations",
  "app-id-secret": "ACME_APP_ID",
  "app-private-key-secret": "ACME_APP_PRIVATE_KEY",
  "bot-slug": "acme-bot[bot]",
};

/** Write `text` to a fresh temp file and hand its path to `body`. */
async function withConfigFile(text, body) {
  const dir = mkdtempSync(join(tmpdir(), "gh-repo-config-test-"));
  try {
    const path = join(dir, "gh-repo-config.json");
    writeFileSync(path, text, "utf8");
    return await body(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// parseOrgConfig — defaults and the populated shapes
// ---------------------------------------------------------------------

test("an empty object takes every default and warns about nothing", () => {
  const { config, warnings } = parseOrgConfig("{}");
  assert.deepEqual(config, DEFAULT_ORG_CONFIG);
  assert.equal(config.sweeperUpdatePolicy, DEFAULT_SWEEPER_UPDATE_POLICY);
  assert.deepEqual(warnings, []);
});

test("a fully populated file resolves every key", () => {
  const { config, warnings } = parseOrgConfig(
    JSON.stringify({
      "named-dependabot-groups": { "acme-sdk": ["@acme/*", "acme-core"] },
      "pr-automation-identity": IDENTITY_JSON,
      "version-pin": "v1.2.3",
      "sweeper-update-policy": "auto",
    }),
  );
  assert.deepEqual(config.namedDependabotGroups, {
    "acme-sdk": ["@acme/*", "acme-core"],
  });
  assert.deepEqual(config.prAutomationIdentity, {
    appName: "acme-pr-automations",
    appIdSecret: "ACME_APP_ID",
    appPrivateKeySecret: "ACME_APP_PRIVATE_KEY",
    botSlug: "acme-bot[bot]",
  });
  assert.equal(config.versionPin, "v1.2.3");
  assert.equal(config.sweeperUpdatePolicy, "auto");
  assert.deepEqual(warnings, []);
});

test("each key alone leaves the others at their defaults", () => {
  const groupsOnly = parseOrgConfig(
    JSON.stringify({ "named-dependabot-groups": { g: ["p"] } }),
  ).config;
  assert.deepEqual(groupsOnly.namedDependabotGroups, { g: ["p"] });
  assert.equal(groupsOnly.prAutomationIdentity, undefined);
  assert.equal(groupsOnly.versionPin, undefined);
  assert.equal(groupsOnly.sweeperUpdatePolicy, DEFAULT_SWEEPER_UPDATE_POLICY);

  const identityOnly = parseOrgConfig(
    JSON.stringify({ "pr-automation-identity": IDENTITY_JSON }),
  ).config;
  assert.equal(identityOnly.prAutomationIdentity.appName, "acme-pr-automations");
  assert.equal(identityOnly.namedDependabotGroups, undefined);

  const pinOnly = parseOrgConfig(JSON.stringify({ "version-pin": "v0.1.0" })).config;
  assert.equal(pinOnly.versionPin, "v0.1.0");
  assert.equal(pinOnly.namedDependabotGroups, undefined);

  for (const policy of SWEEPER_UPDATE_POLICIES) {
    const policyOnly = parseOrgConfig(
      JSON.stringify({ "sweeper-update-policy": policy }),
    ).config;
    assert.equal(policyOnly.sweeperUpdatePolicy, policy);
    assert.equal(policyOnly.versionPin, undefined);
  }
});

test("an empty named-groups map is a real value, not an absent key", () => {
  const { config } = parseOrgConfig(
    JSON.stringify({ "named-dependabot-groups": {} }),
  );
  // Full replacement, not a merge: `{}` means "no named groups at all",
  // which must NOT fall back to DEFAULT_NAMED_DEPENDABOT_GROUPS.
  assert.deepEqual(config.namedDependabotGroups, {});
});

// ---------------------------------------------------------------------
// parseOrgConfig — hard errors
// ---------------------------------------------------------------------

test("invalid JSON is a hard error", () => {
  assert.throws(() => parseOrgConfig("{ nope"), /invalid JSON/);
});

test("a non-object top level is a hard error", () => {
  assert.throws(() => parseOrgConfig("[]"), /top level must be a JSON object/);
  assert.throws(() => parseOrgConfig('"x"'), /top level must be a JSON object/);
  assert.throws(() => parseOrgConfig("null"), /top level must be a JSON object/);
});

test("a malformed named-dependabot-groups is a hard error naming the group", () => {
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "named-dependabot-groups": [] })),
    /"named-dependabot-groups": must be an object/,
  );
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "named-dependabot-groups": { g: "p" } })),
    /"named-dependabot-groups\.g": must be a non-empty array/,
  );
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "named-dependabot-groups": { g: [] } })),
    /"named-dependabot-groups\.g": must be a non-empty array/,
  );
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "named-dependabot-groups": { g: [""] } })),
    /"named-dependabot-groups\.g": every pattern must be a non-empty string/,
  );
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "named-dependabot-groups": { g: [7] } })),
    /"named-dependabot-groups\.g": every pattern must be a non-empty string/,
  );
});

test("a partial pr-automation-identity is a hard error naming the missing sub-key", () => {
  const partial = { ...IDENTITY_JSON };
  delete partial["bot-slug"];
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "pr-automation-identity": partial })),
    /"pr-automation-identity\.bot-slug": required, must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseOrgConfig(
        JSON.stringify({
          "pr-automation-identity": { ...IDENTITY_JSON, "app-id-secret": "" },
        }),
      ),
    /"pr-automation-identity\.app-id-secret": required/,
  );
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "pr-automation-identity": "acme" })),
    /"pr-automation-identity": must be an object/,
  );
});

test("a malformed version-pin is a hard error", () => {
  for (const bad of ["1.2.3", "v1.2", "v1.2.3-rc.1", "latest", 3]) {
    assert.throws(
      () => parseOrgConfig(JSON.stringify({ "version-pin": bad })),
      /"version-pin": must be a release tag of the form vX\.Y\.Z/,
    );
  }
});

test("an unrecognized sweeper-update-policy is a hard error", () => {
  assert.throws(
    () => parseOrgConfig(JSON.stringify({ "sweeper-update-policy": "sometimes" })),
    /"sweeper-update-policy": must be one of manual, auto, off/,
  );
});

// ---------------------------------------------------------------------
// parseOrgConfig — unknown keys warn, never abort
// ---------------------------------------------------------------------

test("unknown keys warn by name and parsing continues", () => {
  const { config, warnings } = parseOrgConfig(
    JSON.stringify({
      "version-pin": "v9.9.9",
      "future-key": true,
      "pr-automation-identity": { ...IDENTITY_JSON, "app-owner": "acme" },
    }),
  );
  assert.equal(config.versionPin, "v9.9.9");
  assert.equal(config.prAutomationIdentity.appName, "acme-pr-automations");
  assert.deepEqual(warnings, [
    'org config: unknown key "future-key" (ignored)',
    'org config: unknown key "pr-automation-identity.app-owner" (ignored)',
  ]);
});

// ---------------------------------------------------------------------
// readOrgConfig
// ---------------------------------------------------------------------

test("readOrgConfig reads and parses a file", async () => {
  const { config } = await withConfigFile(
    JSON.stringify({ "sweeper-update-schedule": "daily", "version-pin": "v4.5.6" }),
    (path) => readOrgConfig(path),
  );
  assert.equal(config.versionPin, "v4.5.6");
});

test("readOrgConfig on a missing file is a hard error naming the path", async () => {
  const path = join(tmpdir(), "gh-repo-config-does-not-exist.json");
  await assert.rejects(
    () => readOrgConfig(path),
    new RegExp(`org config file ${path.replace(/[.]/g, "\\.")} could not be read`),
  );
});

// ---------------------------------------------------------------------
// assertVersionPinSatisfied / parseSweeperRepo
// ---------------------------------------------------------------------

test("no pin is always satisfied; a matching pin passes; a mismatch names both", () => {
  assert.doesNotThrow(() => assertVersionPinSatisfied(undefined, "1.2.3"));
  assert.doesNotThrow(() => assertVersionPinSatisfied("v1.2.3", "1.2.3"));
  assert.throws(
    () => assertVersionPinSatisfied("v1.2.4", "1.2.3"),
    /"version-pin" is v1\.2\.4 but this converger is 1\.2\.3/,
  );
});

test("parseSweeperRepo accepts owner/repo, treats absent as none, rejects the rest", () => {
  assert.equal(parseSweeperRepo(undefined), undefined);
  assert.equal(parseSweeperRepo(""), undefined);
  assert.equal(parseSweeperRepo("TheVoskamps/sweeper"), "TheVoskamps/sweeper");
  for (const bad of ["sweeper", "a/b/c", "/b", "a/", "a b/c"]) {
    assert.throws(
      () => parseSweeperRepo(bad),
      /GH_REPO_CONFIG_SWEEPER_REPO must be owner\/repo/,
    );
  }
});

// ---------------------------------------------------------------------
// runSweepFromEnv wiring
// ---------------------------------------------------------------------

/**
 * A `global.fetch` stand-in serving one behind repo through the whole
 * sweep (properties -> converge -> GHAS -> merge -> ruleset -> stamp).
 * Records what the sweep wrote: the created blobs (by the path the tree
 * POST assigns them) and the `protect-main` ruleset create body.
 */
function fakeApi() {
  const blobContents = [];
  const treePaths = new Map();
  const rulesetBodies = [];
  const calls = [];

  const ok = (json, status = 200) => ({
    ok: true,
    status,
    statusText: "OK",
    json: async () => json,
  });

  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method });
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (url.includes("/properties/schema/")) return ok({ default_value: "opt-in" });
    if (url.includes("/properties/values") && method === "GET") {
      return ok([
        {
          repository_name: REPO,
          properties: [
            { property_name: "gh-repo-config-mode", value: "process" },
            { property_name: "gh-repo-config-version", value: "0.0.1" },
          ],
        },
      ]);
    }
    if (url.includes("/properties/values") && method === "PATCH") return ok({});
    // The merge pass's unfiltered list returns the converger PR this
    // tick's converge opened, so the repo clears the ruleset ordering
    // gate and gets stamped. The writer's own head-filtered list returns
    // [] so a fresh PR is created rather than treated as pre-existing.
    if (url.includes("/pulls?state=open") && !url.includes("head=")) {
      return ok([
        {
          number: 1,
          user: { login: "test-converger[bot]", type: "Bot" },
          head: { sha: "prheadsha", ref: "gh-repo-config/converge" },
          base: { ref: "main" },
        },
      ]);
    }
    if (url.includes("/pulls?state=open")) return ok([]);
    if (url.includes("/rules/branches/main")) return ok([]);
    if (url.match(/\/pulls\/1\/merge$/) && method === "PUT") return ok({ merged: true });
    if (url.includes("/code-scanning/default-setup") && method === "GET") {
      return ok({ state: "not-configured" });
    }
    if (url.includes("/installations")) {
      return ok({
        installations: [
          { app_id: 4319606, app_slug: "test-converger" },
          { app_id: 3835765, app_slug: DEFAULT_PR_AUTOMATION_IDENTITY.appName },
          { app_id: 5550001, app_slug: "acme-pr-automations" },
        ],
      });
    }
    if (url.includes("/rulesets") && method === "GET" && !url.match(/\/rulesets\/\d+/)) {
      return ok([]);
    }
    if (url.includes("/rulesets") && method === "POST") {
      rulesetBodies.push(body);
      return ok({ id: 42, name: "protect-main" }, 201);
    }
    if (url.includes("/vulnerability-alerts")) {
      return method === "GET"
        ? { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) }
        : ok({}, 204);
    }
    if (url.includes("/automated-security-fixes")) {
      return method === "GET" ? ok({ enabled: false, paused: false }) : ok({});
    }
    if (url.includes(`/repos/${ORG}/.github/contents/`)) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    if (url.endsWith(`/repos/${ORG}/${REPO}`)) return ok({ default_branch: "main" });
    if (url.includes("/git/ref/heads/main")) return ok({ object: { sha: "basecommit" } });
    if (url.includes("/git/trees/basecommit")) return ok({ tree: [], truncated: false });
    if (url.includes("/git/blobs") && method === "POST") {
      const sha = `blob-${blobContents.length}`;
      blobContents.push(Buffer.from(body.content, "base64").toString("utf8"));
      return ok({ sha }, 201);
    }
    if (url.includes("/git/trees") && method === "POST") {
      for (const entry of body.tree) treePaths.set(entry.path, entry.sha);
      return ok({ sha: "newtree" }, 201);
    }
    if (url.includes("/git/commits") && method === "POST") return ok({ sha: "newcommit" }, 201);
    if (url.includes("/git/refs")) return ok({});
    if (url.includes("/pulls") && method === "POST") {
      return ok(
        { number: 1, html_url: "https://example/pr/1", head: { ref: "gh-repo-config/converge" } },
        201,
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  return {
    fetchImpl,
    calls,
    rulesetBodies,
    /** The content the sweep wrote at `path`, as the tree POST mapped it. */
    written(path) {
      const sha = treePaths.get(path);
      assert.ok(sha, `no tree entry for ${path}`);
      return blobContents[Number(sha.slice("blob-".length))];
    },
  };
}

/** Run `body` with `global.fetch` replaced, restoring it afterwards. */
async function withFetch(fetchImpl, body) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  try {
    return await body();
  } finally {
    global.fetch = original;
  }
}

const BASE_ENV = {
  GH_REPO_CONFIG_ORG: ORG,
  GH_REPO_CONFIG_TOKEN: "test-token",
  GH_REPO_CONFIG_APP_SLUG: "test-converger",
};

function bypassAppIds(rulesetBody) {
  return rulesetBody.bypass_actors
    .filter((a) => a.actor_type === "Integration")
    .map((a) => a.actor_id)
    .sort();
}

test("no config file and no sweeper repo: the sweep behaves exactly as before", async () => {
  const api = fakeApi();
  const report = await withFetch(api.fetchImpl, () => runSweepFromEnv({ ...BASE_ENV }));

  assert.deepEqual(report.stamped, [REPO]);
  assert.equal(report.sweeperRepo, undefined);
  assert.equal(report.sweeperUpdatePolicy, DEFAULT_SWEEPER_UPDATE_POLICY);
  // The default identity's App is the bypass actor, and the rendered
  // payload carries the baked defaults.
  assert.deepEqual(bypassAppIds(api.rulesetBodies[0]), [3835765, 4319606]);
  assert.match(api.written(".github/dependabot.yml"), /codeql-action/);
  assert.match(
    api.written(".github/workflows/auto-rebase-prs.yml"),
    /AUTOMERGE_APP_ID/,
  );
});

test("a populated config file reaches every consumer", async () => {
  const api = fakeApi();
  const report = await withConfigFile(
    JSON.stringify({
      "named-dependabot-groups": { "acme-sdk": ["@acme/*"] },
      "pr-automation-identity": IDENTITY_JSON,
      "version-pin": `v${CURRENT_VERSION}`,
      "sweeper-update-policy": "off",
    }),
    (path) =>
      withFetch(api.fetchImpl, () =>
        runSweepFromEnv({
          ...BASE_ENV,
          GH_REPO_CONFIG_FILE: path,
          GH_REPO_CONFIG_SWEEPER_REPO: `${ORG}/sweeper`,
        }),
      ),
  );

  assert.deepEqual(report.stamped, [REPO]);
  assert.equal(report.sweeperRepo, `${ORG}/sweeper`);
  assert.equal(report.sweeperUpdatePolicy, "off");

  // named-dependabot-groups reaches the rendered dependabot.yml, as a
  // full replacement of the baked registry.
  const dependabot = api.written(".github/dependabot.yml");
  assert.match(dependabot, /acme-sdk:/);
  assert.match(dependabot, /"@acme\/\*"/);
  assert.ok(!dependabot.includes("codeql-action:"), "baked groups replaced");

  // pr-automation-identity reaches the rendered workflows...
  const workflow = api.written(".github/workflows/auto-rebase-prs.yml");
  assert.match(workflow, /secrets\.ACME_APP_ID/);
  assert.match(workflow, /secrets\.ACME_APP_PRIVATE_KEY/);
  assert.match(workflow, /acme-bot\[bot\]/);
  // The default secret names survive only in the header comment's
  // worked example, never as a `secrets.` reference.
  assert.ok(
    !workflow.includes("secrets.AUTOMERGE_APP_ID"),
    "default secret reference replaced",
  );

  // ...and the same identity's App is the protect-main bypass actor,
  // instead of the default identity's App the org has not installed.
  assert.deepEqual(bypassAppIds(api.rulesetBodies[0]), [4319606, 5550001]);
});

test("a version-pin matching CURRENT_VERSION lets the sweep run", async () => {
  const api = fakeApi();
  const report = await withConfigFile(
    JSON.stringify({ "version-pin": `v${CURRENT_VERSION}` }),
    (path) =>
      withFetch(api.fetchImpl, () =>
        runSweepFromEnv({ ...BASE_ENV, GH_REPO_CONFIG_FILE: path }),
      ),
  );
  assert.deepEqual(report.stamped, [REPO]);
});

test("an unknown key warns on stderr and the sweep still runs", async () => {
  const api = fakeApi();
  const originalError = console.error;
  const errors = [];
  console.error = (m) => errors.push(m);
  try {
    await withConfigFile(JSON.stringify({ "future-key": 1 }), (path) =>
      withFetch(api.fetchImpl, () =>
        runSweepFromEnv({ ...BASE_ENV, GH_REPO_CONFIG_FILE: path }),
      ),
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, ['org config: unknown key "future-key" (ignored)']);
});

// Every hard error must land before the first API call, so a bad pin or
// policy can never half-converge an org.
const HARD_ERRORS = [
  {
    name: "a config file that does not exist",
    env: { GH_REPO_CONFIG_FILE: join(tmpdir(), "gh-repo-config-absent.json") },
    match: /could not be read/,
  },
  {
    name: "a malformed sweeper repo",
    env: { GH_REPO_CONFIG_SWEEPER_REPO: "not-a-repo" },
    match: /GH_REPO_CONFIG_SWEEPER_REPO must be owner\/repo/,
  },
];

for (const { name, env, match } of HARD_ERRORS) {
  test(`${name} fails the sweep before any API call`, async () => {
    let fetched = false;
    await withFetch(
      async () => {
        fetched = true;
        throw new Error("no API call should have been made");
      },
      async () => {
        await assert.rejects(() => runSweepFromEnv({ ...BASE_ENV, ...env }), match);
      },
    );
    assert.equal(fetched, false);
  });
}

test(
  "a config file the process cannot read fails the sweep before any API call",
  { skip: process.getuid?.() === 0 ? "mode 000 does not deny root" : false },
  async () => {
    let fetched = false;
    await withConfigFile("{}", async (path) => {
      chmodSync(path, 0o000);
      await withFetch(
        async () => {
          fetched = true;
          throw new Error("no API call should have been made");
        },
        async () => {
          const named = new RegExp(
            `org config file ${path.replace(/[.]/g, "\\.")} could not be read`,
          );
          await assert.rejects(() => readOrgConfig(path), named);
          await assert.rejects(
            () => runSweepFromEnv({ ...BASE_ENV, GH_REPO_CONFIG_FILE: path }),
            named,
          );
        },
      );
    });
    assert.equal(fetched, false);
  },
);

for (const [name, text, match] of [
  ["invalid JSON", "{ nope", /invalid JSON/],
  ["a non-object top level", "[]", /top level must be a JSON object/],
  [
    "a bad named-groups shape",
    JSON.stringify({ "named-dependabot-groups": { g: [] } }),
    /"named-dependabot-groups\.g"/,
  ],
  [
    "a partial identity",
    JSON.stringify({ "pr-automation-identity": { "app-name": "acme" } }),
    /"pr-automation-identity\.app-id-secret"/,
  ],
  [
    "a bad policy",
    JSON.stringify({ "sweeper-update-policy": "sometimes" }),
    /"sweeper-update-policy"/,
  ],
  ["a bad pin shape", JSON.stringify({ "version-pin": "1.2.3" }), /"version-pin"/],
  [
    "a pin naming another release",
    JSON.stringify({ "version-pin": "v0.0.1" }),
    /"version-pin" is v0\.0\.1 but this converger is/,
  ],
]) {
  test(`${name} in the config file fails the sweep before any API call`, async () => {
    let fetched = false;
    await withConfigFile(text, (path) =>
      withFetch(
        async () => {
          fetched = true;
          throw new Error("no API call should have been made");
        },
        async () => {
          await assert.rejects(
            () => runSweepFromEnv({ ...BASE_ENV, GH_REPO_CONFIG_FILE: path }),
            match,
          );
        },
      ),
    );
    assert.equal(fetched, false);
  });
}
