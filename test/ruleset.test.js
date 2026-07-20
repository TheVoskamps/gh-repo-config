import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RulesetsClient,
  convergeProtectMainRuleset,
  buildDesiredRuleset,
  unionBypassActors,
  orgRulesetGoverns,
  rulesetSemanticDiff,
  RULESET_NAME,
  AUTOMERGE_APP_SLUG,
} from "../dist/index.js";

const ADMIN = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" };
const CONVERGER = { slug: "the-converger", appId: 4319606 };
const AUTOMERGE = { slug: AUTOMERGE_APP_SLUG, appId: 3835765 };

function requiredContexts(body) {
  const rule = body.rules.find((r) => r.type === "required_status_checks");
  return rule.parameters.required_status_checks.map((c) => c.context).sort();
}

// ---------------------------------------------------------------------
// buildDesiredRuleset (pure)
// ---------------------------------------------------------------------

test("buildDesiredRuleset carries all four required aggregator checks from the first assertion", () => {
  const body = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  assert.deepEqual(requiredContexts(body), [
    "codeql-required",
    "install-gate-required",
    "no-back-merging-guard",
    "pinned-gate-required",
  ]);
});

test("buildDesiredRuleset unions the two App bypass actors onto the admin entry", () => {
  const body = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const keys = body.bypass_actors.map((a) => `${a.actor_type}:${a.actor_id}:${a.bypass_mode}`);
  assert.ok(keys.includes("RepositoryRole:5:pull_request"), "admin");
  assert.ok(keys.includes("Integration:4319606:pull_request"), "converger App");
  assert.ok(keys.includes("Integration:3835765:pull_request"), "AUTOMERGE App");
  assert.equal(body.bypass_actors.length, 3);
});

test("buildDesiredRuleset omits an uninstalled App (undefined appId) from the bypass list", () => {
  const body = buildDesiredRuleset([CONVERGER, { slug: AUTOMERGE_APP_SLUG, appId: undefined }]);
  const keys = body.bypass_actors.map((a) => `${a.actor_type}:${a.actor_id}`);
  assert.ok(keys.includes("Integration:4319606"));
  assert.ok(!keys.some((k) => k.includes("3835765")));
  assert.equal(body.bypass_actors.length, 2); // admin + converger only
});

test("buildDesiredRuleset carries code_scanning and code_quality rules", () => {
  const body = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const types = new Set(body.rules.map((r) => r.type));
  assert.ok(types.has("code_scanning"));
  assert.ok(types.has("code_quality"));
  assert.ok(types.has("pull_request"));
});

// ---------------------------------------------------------------------
// unionBypassActors (pure)
// ---------------------------------------------------------------------

test("unionBypassActors preserves an existing operator team bypass and adds the desired actors", () => {
  const team = { actor_id: 99, actor_type: "Team", bypass_mode: "pull_request" };
  const union = unionBypassActors([team], [ADMIN]);
  assert.equal(union.length, 2);
  assert.ok(union.some((a) => a.actor_id === 99));
  assert.ok(union.some((a) => a.actor_id === 5));
});

test("unionBypassActors is idempotent when the desired actor already exists", () => {
  const union = unionBypassActors([ADMIN], [ADMIN]);
  assert.equal(union.length, 1);
});

// ---------------------------------------------------------------------
// orgRulesetGoverns (pure)
// ---------------------------------------------------------------------

test("orgRulesetGoverns: an active Organization-sourced ruleset governs", () => {
  assert.equal(
    orgRulesetGoverns([{ id: 1, name: "org-wide", source_type: "Organization", enforcement: "active" }]),
    true,
  );
});

test("orgRulesetGoverns: a repo-sourced ruleset does not count", () => {
  assert.equal(
    orgRulesetGoverns([{ id: 1, name: "protect-main", source_type: "Repository", enforcement: "active" }]),
    false,
  );
});

test("orgRulesetGoverns: a disabled org ruleset does not govern", () => {
  assert.equal(
    orgRulesetGoverns([{ id: 1, name: "org-wide", source_type: "Organization", enforcement: "disabled" }]),
    false,
  );
});

// ---------------------------------------------------------------------
// rulesetSemanticDiff (pure)
// ---------------------------------------------------------------------

function existingFrom(desired, overrides = {}) {
  return { id: 7, source_type: "Repository", ...desired, ...overrides };
}

test("rulesetSemanticDiff: identical body -> no diff (converged)", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired);
  assert.deepEqual(rulesetSemanticDiff(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: a server include superset with concrete ref is still converged", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired, {
    conditions: { ref_name: { include: ["refs/heads/main", "~DEFAULT_BRANCH"], exclude: [] } },
  });
  assert.deepEqual(rulesetSemanticDiff(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: an include with only the concrete default ref is converged", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired, {
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  });
  assert.deepEqual(rulesetSemanticDiff(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: required checks compared on context only, ignoring integration_id", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  // Existing carries the same contexts but with a stored integration_id.
  const existing = existingFrom(desired, {
    rules: desired.rules.map((r) =>
      r.type === "required_status_checks"
        ? {
            ...r,
            parameters: {
              ...r.parameters,
              required_status_checks: r.parameters.required_status_checks.map((c) => ({
                ...c,
                integration_id: 15368,
              })),
            },
          }
        : r,
    ),
  });
  assert.deepEqual(rulesetSemanticDiff(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: a missing required context is a difference", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired, {
    rules: desired.rules.map((r) =>
      r.type === "required_status_checks"
        ? {
            ...r,
            parameters: {
              ...r.parameters,
              required_status_checks: [{ context: "codeql-required" }],
            },
          }
        : r,
    ),
  });
  assert.deepEqual(rulesetSemanticDiff(desired, existing, "main"), ["required_status_checks"]);
});

test("rulesetSemanticDiff: bypass containment — existing superset is converged; missing actor is a diff", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  // Existing has all desired actors plus an operator team → converged.
  const superset = existingFrom(desired, {
    bypass_actors: [...desired.bypass_actors, { actor_id: 99, actor_type: "Team", bypass_mode: "pull_request" }],
  });
  assert.deepEqual(rulesetSemanticDiff(desired, superset, "main"), []);

  // Existing missing the AUTOMERGE App → bypass diff.
  const missing = existingFrom(desired, {
    bypass_actors: desired.bypass_actors.filter((a) => a.actor_id !== 3835765),
  });
  assert.deepEqual(rulesetSemanticDiff(desired, missing, "main"), ["bypass_actors"]);
});

// ---------------------------------------------------------------------
// convergeProtectMainRuleset (I/O orchestration with injected client)
// ---------------------------------------------------------------------

function fakeClient(overrides = {}) {
  const calls = [];
  const base = {
    listRulesets: async () => [],
    getRuleset: async () => {
      throw new Error("getRuleset not stubbed");
    },
    createRuleset: async (o, r, body) => {
      calls.push({ op: "create", body });
      return { kind: "ok", ruleset: { id: 1, ...body } };
    },
    updateRuleset: async (o, r, id, body) => {
      calls.push({ op: "update", id, body });
      return { kind: "ok", ruleset: { id, ...body } };
    },
    deleteRuleset: async (o, r, id) => {
      calls.push({ op: "delete", id });
    },
  };
  return { calls, client: { ...base, ...overrides } };
}

const APPS = [CONVERGER, AUTOMERGE];

test("converge: no existing ruleset -> created", async () => {
  const { client, calls } = fakeClient();
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "created");
  assert.equal(calls.filter((c) => c.op === "create").length, 1);
});

test("converge: existing converged repo copy -> unchanged, no write", async () => {
  const desired = buildDesiredRuleset(APPS);
  const existing = { id: 7, source_type: "Repository", ...desired };
  const { client, calls } = fakeClient({
    listRulesets: async () => [{ id: 7, name: RULESET_NAME, source_type: "Repository" }],
    getRuleset: async () => existing,
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "unchanged");
  assert.equal(calls.length, 0);
});

test("converge: existing repo copy that differs -> updated with the changed fields", async () => {
  const desired = buildDesiredRuleset(APPS);
  const existing = {
    id: 7,
    source_type: "Repository",
    ...desired,
    bypass_actors: [ADMIN], // missing both App entries
  };
  const { client, calls } = fakeClient({
    listRulesets: async () => [{ id: 7, name: RULESET_NAME, source_type: "Repository" }],
    getRuleset: async () => existing,
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "updated");
  assert.ok(result.changedFields.includes("bypass_actors"));
  const update = calls.find((c) => c.op === "update");
  // The PUT preserves the admin actor and adds the two Apps (union), not
  // a replacement that drops the admin.
  const keys = update.body.bypass_actors.map((a) => `${a.actor_type}:${a.actor_id}`);
  assert.ok(keys.includes("RepositoryRole:5"));
  assert.ok(keys.includes("Integration:4319606"));
  assert.ok(keys.includes("Integration:3835765"));
});

test("converge: an org ruleset governs -> repo copy deleted and deferred (org-governed)", async () => {
  const { client, calls } = fakeClient({
    listRulesets: async () => [
      { id: 9, name: "org-wide", source_type: "Organization", enforcement: "active" },
      { id: 7, name: RULESET_NAME, source_type: "Repository" },
    ],
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "org-governed");
  assert.deepEqual(
    calls.map((c) => c.op),
    ["delete"],
  );
  assert.equal(calls[0].id, 7);
});

test("converge: org governs and there is no repo copy -> deferred, nothing deleted", async () => {
  const { client, calls } = fakeClient({
    listRulesets: async () => [
      { id: 9, name: "org-wide", source_type: "Organization", enforcement: "active" },
    ],
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "org-governed");
  assert.equal(calls.length, 0);
});

test("converge: an uninstalled App is omitted from bypass and reported, never a failure", async () => {
  const { client } = fakeClient();
  const apps = [CONVERGER, { slug: AUTOMERGE_APP_SLUG, appId: undefined }];
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", apps, false);
  assert.equal(result.outcome, "created");
  assert.deepEqual(result.uninstalledApps, [AUTOMERGE_APP_SLUG]);
});

test("converge: a code_quality 422 -> retried without the rule, reported as skipped", async () => {
  let attempt = 0;
  const { client } = fakeClient({
    createRuleset: async (o, r, body) => {
      attempt++;
      if (attempt === 1) {
        assert.ok(body.rules.some((x) => x.type === "code_quality"), "first attempt has code_quality");
        return { kind: "code-quality-422" };
      }
      assert.ok(!body.rules.some((x) => x.type === "code_quality"), "retry drops code_quality");
      return { kind: "ok", ruleset: { id: 1, ...body } };
    },
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "created");
  assert.equal(result.codeQualitySkipped, true);
  assert.equal(attempt, 2);
});

test("converge: dryRun decides create without writing", async () => {
  const { client, calls } = fakeClient();
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, true);
  assert.equal(result.outcome, "created");
  assert.equal(calls.length, 0);
});
