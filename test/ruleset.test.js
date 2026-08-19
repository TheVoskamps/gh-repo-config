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
  DEFAULT_PR_AUTOMATION_IDENTITY,
} from "../dist/index.js";

const ADMIN = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" };
const CONVERGER = { slug: "the-converger", appId: 4319606 };
const AUTOMERGE = { slug: AUTOMERGE_APP_SLUG, appId: 3835765 };

function requiredContexts(body) {
  const rule = body.rules.find((r) => r.type === "required_status_checks");
  return rule.parameters.required_status_checks.map((c) => c.context).sort();
}

/** `rulesetSemanticDiff` returns `{ changed }` — `diffChanged` extracts
 * it so the assertions can stay a plain array compare. */
function diffChanged(desired, existing, defaultBranch) {
  return rulesetSemanticDiff(desired, existing, defaultBranch).changed;
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

test("orgRulesetGoverns: an active Organization-sourced branch ruleset governs", () => {
  assert.equal(
    orgRulesetGoverns([
      { id: 1, name: "org-wide", source_type: "Organization", target: "branch", enforcement: "active" },
    ]),
    true,
  );
});

test("orgRulesetGoverns: a repo-sourced ruleset does not count", () => {
  assert.equal(
    orgRulesetGoverns([
      { id: 1, name: "protect-main", source_type: "Repository", target: "branch", enforcement: "active" },
    ]),
    false,
  );
});

test("orgRulesetGoverns: a disabled org ruleset does not govern", () => {
  assert.equal(
    orgRulesetGoverns([
      { id: 1, name: "org-wide", source_type: "Organization", target: "branch", enforcement: "disabled" },
    ]),
    false,
  );
});

test("orgRulesetGoverns: an org ruleset with no enforcement field does not govern (no over-match fallback)", () => {
  assert.equal(
    orgRulesetGoverns([{ id: 1, name: "org-wide", source_type: "Organization", target: "branch" }]),
    false,
  );
});

test("orgRulesetGoverns: an active org TAG ruleset does not govern the default branch", () => {
  assert.equal(
    orgRulesetGoverns([
      { id: 1, name: "org-tags", source_type: "Organization", target: "tag", enforcement: "active" },
    ]),
    false,
  );
});

test("orgRulesetGoverns: an active org PUSH ruleset does not govern the default branch", () => {
  assert.equal(
    orgRulesetGoverns([
      { id: 1, name: "org-push", source_type: "Organization", target: "push", enforcement: "active" },
    ]),
    false,
  );
});

test("orgRulesetGoverns: a ruleset with no target field does not govern (defensive — live summaries always carry target)", () => {
  assert.equal(
    orgRulesetGoverns([{ id: 1, name: "org-wide", source_type: "Organization", enforcement: "active" }]),
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
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: a server include superset with concrete ref is still converged", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired, {
    conditions: { ref_name: { include: ["refs/heads/main", "~DEFAULT_BRANCH"], exclude: [] } },
  });
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: an include with only the concrete default ref is converged", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired, {
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  });
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
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
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
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
  assert.deepEqual(diffChanged(desired, existing, "main"), ["required_status_checks"]);
});

test("rulesetSemanticDiff: bypass containment — existing superset is converged; missing actor is a diff", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  // Existing has all desired actors plus an operator team → converged.
  const superset = existingFrom(desired, {
    bypass_actors: [...desired.bypass_actors, { actor_id: 99, actor_type: "Team", bypass_mode: "pull_request" }],
  });
  assert.deepEqual(diffChanged(desired, superset, "main"), []);

  // Existing missing the AUTOMERGE App → bypass diff.
  const missing = existingFrom(desired, {
    bypass_actors: desired.bypass_actors.filter((a) => a.actor_id !== 3835765),
  });
  assert.deepEqual(diffChanged(desired, missing, "main"), ["bypass_actors"]);
});

// ---------------------------------------------------------------------
// rulesetSemanticDiff: rule-parameter drift (canonical-authoritative)
// ---------------------------------------------------------------------

function withRuleParam(body, type, field, value) {
  return {
    ...body,
    rules: body.rules.map((r) =>
      r.type === type ? { ...r, parameters: { ...r.parameters, [field]: value } } : r,
    ),
  };
}

function withoutRule(body, type) {
  return { ...body, rules: body.rules.filter((r) => r.type !== type) };
}

test("rulesetSemanticDiff: all-canonical body still reports unchanged", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired);
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: pull_request parameter drift (required_approving_review_count) is reported", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(desired, "pull_request", "required_approving_review_count", 0),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "pull_request.required_approving_review_count",
  ]);
});

test("rulesetSemanticDiff: pull_request parameter drift (dismiss_stale_reviews_on_push off) is reported", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(desired, "pull_request", "dismiss_stale_reviews_on_push", false),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "pull_request.dismiss_stale_reviews_on_push",
  ]);
});

test("rulesetSemanticDiff: pull_request parameter drift (allowed_merge_methods widened) is reported", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(desired, "pull_request", "allowed_merge_methods", ["merge", "squash"]),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "pull_request.allowed_merge_methods",
  ]);
});

test("rulesetSemanticDiff: required_status_checks parameter drift (strict_required_status_checks_policy off) is reported", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(desired, "required_status_checks", "strict_required_status_checks_policy", false),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "required_status_checks.strict_required_status_checks_policy",
  ]);
});

test("rulesetSemanticDiff: required_status_checks parameter drift (do_not_enforce_on_create) is reported", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(desired, "required_status_checks", "do_not_enforce_on_create", true),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "required_status_checks.do_not_enforce_on_create",
  ]);
});

test("rulesetSemanticDiff: required_status_checks context-set compare is unaffected by the parameter compare", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  // Existing carries the same contexts but with a stored integration_id
  // — still converged (this is the pre-existing behavior; assert it
  // still holds alongside the new parameter compares).
  const existing = existingFrom(
    withRuleParam(desired, "required_status_checks", "required_status_checks", [
      { context: "codeql-required", integration_id: 15368 },
      { context: "install-gate-required" },
      { context: "pinned-gate-required" },
      { context: "no-back-merging-guard" },
    ]),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: code_scanning parameter drift (code_scanning_tools threshold loosened) is reported", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(desired, "code_scanning", "code_scanning_tools", [
      { tool: "CodeQL", security_alerts_threshold: "critical", alerts_threshold: "errors" },
    ]),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "code_scanning.code_scanning_tools",
  ]);
});

test("rulesetSemanticDiff: code_quality parameter drift (severity changed) is reported", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(withRuleParam(desired, "code_quality", "severity", "warnings"));
  assert.deepEqual(diffChanged(desired, existing, "main"), ["code_quality.severity"]);
});

test("rulesetSemanticDiff: code_quality absent on the server is not itself drift (422-retry-skipped state tolerated)", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(withoutRule(desired, "code_quality"));
  // The rule-types set compare reports "rules" (an actual rule-type
  // difference), but no spurious "code_quality.severity" parameter
  // diff is reported for a rule that isn't there to compare.
  const diff = diffChanged(desired, existing, "main");
  assert.ok(diff.includes("rules"));
  assert.ok(!diff.some((f) => f.startsWith("code_quality.")));
});

test("rulesetSemanticDiff: a non-empty ref_name.exclude is drift", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(desired, {
    conditions: {
      ref_name: { include: desired.conditions.ref_name.include, exclude: ["refs/heads/release/*"] },
    },
  });
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "conditions.ref_name.exclude",
  ]);
});

// ---------------------------------------------------------------------
// rulesetSemanticDiff: rule parameters the canonical asset does not
// carry are ungoverned — never compared, never surfaced (issue #82)
// ---------------------------------------------------------------------

/**
 * The rule types the canonical asset carries parameters on today. The
 * diff itself hardcodes no rule list — it loops over whatever rules the
 * canonical body carries — so this is a fixture for the per-rule cases
 * below, not a mirror of an enumeration in `ruleset.ts`.
 */
const COMPARED_RULE_TYPES = [
  "pull_request",
  "required_status_checks",
  "code_scanning",
  "code_quality",
];

/**
 * The one canonical parameter deliberately NOT compared by the
 * parameter loop: `required_status_checks`'s own list, compared instead
 * as a context-name set so the server-supplied `integration_id` inside
 * each entry is ignored.
 */
const SKIPPED_PARAM = "required_status_checks.required_status_checks";

test("rulesetSemanticDiff: a server-side param the asset does not model is not drift (the live dismissal_restriction case)", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(desired, "pull_request", "dismissal_restriction", {
      allowed_actors: [],
      enabled: false,
    }),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: an unmodelled server-side param on any compared rule is not drift", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  for (const type of COMPARED_RULE_TYPES) {
    const existing = existingFrom(withRuleParam(desired, type, "some_new_param", "x"));
    assert.deepEqual(diffChanged(desired, existing, "main"), [], type);
  }
});

test("rulesetSemanticDiff: an unmodelled server-side param alongside real drift reports only the modelled field", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const withUnknown = withRuleParam(desired, "pull_request", "some_new_param", true);
  const existing = existingFrom(
    withRuleParam(withUnknown, "pull_request", "required_approving_review_count", 0),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "pull_request.required_approving_review_count",
  ]);
});

// ---------------------------------------------------------------------
// rulesetSemanticDiff: the parameter compare is a MECHANISM driven by
// the canonical asset's own keys, not a hardcoded enumeration (issue
// #82). A regression to hardcoded lists fails the second test below.
// ---------------------------------------------------------------------

/**
 * Every `<type>.<key>` the canonical asset carries on a compared rule,
 * minus the one deliberate skip — derived from the asset (via
 * `buildDesiredRuleset`) rather than restated here, so a parameter
 * added to the asset joins this set automatically.
 */
function canonicalComparedParams(desired) {
  const params = [];
  for (const type of COMPARED_RULE_TYPES) {
    const rule = desired.rules.find((r) => r.type === type);
    assert.ok(rule, `canonical asset carries the ${type} rule`);
    for (const key of Object.keys(rule.parameters ?? {})) {
      if (`${type}.${key}` !== SKIPPED_PARAM) {
        params.push({ type, key });
      }
    }
  }
  return params;
}

test("rulesetSemanticDiff: every parameter the canonical asset carries is compared", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const params = canonicalComparedParams(desired);
  assert.ok(params.length > 0, "the asset carries compared parameters");
  // The skip is only meaningful while the asset actually carries it.
  const rsc = desired.rules.find((r) => r.type === "required_status_checks");
  assert.ok(
    Object.keys(rsc.parameters).includes("required_status_checks"),
    "the skipped parameter is one the asset really carries",
  );
  for (const { type, key } of params) {
    // A value the canonical side can never hold: every canonical
    // parameter is a boolean, a number, an array, or a short enum word.
    const existing = existingFrom(withRuleParam(desired, type, key, "__not-the-canonical-value__"));
    assert.deepEqual(diffChanged(desired, existing, "main"), [`${type}.${key}`], `${type}.${key}`);
  }
});

test("rulesetSemanticDiff: a parameter newly added to any compared rule in the asset is compared with no code edit", () => {
  const base = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  for (const type of COMPARED_RULE_TYPES) {
    // Stands in for a key a future edit adds to
    // assets/protect-main-ruleset.json — a name no hardcoded
    // enumeration in the diff could possibly carry.
    const desired = withRuleParam(base, type, "future_canonical_param", "canonical");
    const existing = existingFrom(
      withRuleParam(desired, type, "future_canonical_param", "server-side-drift"),
    );
    assert.deepEqual(
      diffChanged(desired, existing, "main"),
      [`${type}.future_canonical_param`],
      type,
    );
  }
});

/** Append a whole rule to a body's `rules` array. */
function withExtraRule(body, rule) {
  return { ...body, rules: [...body.rules, rule] };
}

test("rulesetSemanticDiff: a RULE newly added to the asset has its parameters compared with no code edit", () => {
  const base = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  // Stands in for a rule a future edit adds to
  // assets/protect-main-ruleset.json — a type no hardcoded
  // rule-name enumeration in the diff could possibly carry.
  const desired = withExtraRule(base, {
    type: "future_canonical_rule",
    parameters: { some_setting: "canonical" },
  });
  const existing = existingFrom(
    withRuleParam(desired, "future_canonical_rule", "some_setting", "server-side-drift"),
  );
  // Both sides carry the rule type, so the rule-types set compare is
  // silent — only the parameter compare can catch this.
  assert.deepEqual(diffChanged(desired, existing, "main"), [
    "future_canonical_rule.some_setting",
  ]);
});

test("rulesetSemanticDiff: a parameterless canonical rule (deletion, non_fast_forward) is harmless under the compare", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  for (const type of ["deletion", "non_fast_forward"]) {
    assert.ok(
      desired.rules.some((r) => r.type === type && r.parameters === undefined),
      `the canonical asset carries ${type} with no parameters`,
    );
  }
  // A server copy that carries the same parameterless rules — plus a
  // server-side parameter the asset does not model on one of them — is
  // still converged.
  const existing = existingFrom(withRuleParam(desired, "deletion", "some_new_param", true));
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
});

test("rulesetSemanticDiff: the skipped required_status_checks list is not compared directly (integration_id ignored)", () => {
  const desired = buildDesiredRuleset([CONVERGER, AUTOMERGE]);
  const existing = existingFrom(
    withRuleParam(
      desired,
      "required_status_checks",
      "required_status_checks",
      requiredContexts(desired).map((context) => ({ context, integration_id: 15368 })),
    ),
  );
  assert.deepEqual(diffChanged(desired, existing, "main"), []);
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

test("converge: an org branch ruleset governs -> repo copy deleted and deferred (org-governed)", async () => {
  const { client, calls } = fakeClient({
    listRulesets: async () => [
      { id: 9, name: "org-wide", source_type: "Organization", target: "branch", enforcement: "active" },
      { id: 7, name: RULESET_NAME, source_type: "Repository", target: "branch" },
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
      { id: 9, name: "org-wide", source_type: "Organization", target: "branch", enforcement: "active" },
    ],
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "org-governed");
  assert.equal(calls.length, 0);
});

test("converge: an org TAG ruleset present does NOT defer — repo-level branch ruleset still converges", async () => {
  const { client, calls } = fakeClient({
    listRulesets: async () => [
      { id: 9, name: "org-tags", source_type: "Organization", target: "tag", enforcement: "active" },
    ],
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "created");
  assert.deepEqual(
    calls.map((c) => c.op),
    ["create"],
  );
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

test("converge: a rule-parameter-only drift (required_approving_review_count) -> updated with the canonical PUT body", async () => {
  const desired = buildDesiredRuleset(APPS);
  const existing = {
    id: 7,
    source_type: "Repository",
    ...desired,
    rules: desired.rules.map((r) =>
      r.type === "pull_request"
        ? { ...r, parameters: { ...r.parameters, required_approving_review_count: 0 } }
        : r,
    ),
  };
  const { client, calls } = fakeClient({
    listRulesets: async () => [{ id: 7, name: RULESET_NAME, source_type: "Repository" }],
    getRuleset: async () => existing,
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "updated");
  assert.deepEqual(result.changedFields, ["pull_request.required_approving_review_count"]);
  const update = calls.find((c) => c.op === "update");
  const prRule = update.body.rules.find((r) => r.type === "pull_request");
  assert.equal(prRule.parameters.required_approving_review_count, 1);
});

// ---------------------------------------------------------------------
// convergeProtectMainRuleset: server-side rule parameters the canonical
// asset does not model are ungoverned — no drift, no write, no warning
// ---------------------------------------------------------------------

test("converge: an unmodelled rule param on the server leaves the outcome unchanged, with no write and no warning", async () => {
  const desired = buildDesiredRuleset(APPS);
  const existing = {
    id: 7,
    source_type: "Repository",
    ...desired,
    rules: desired.rules.map((r) =>
      r.type === "pull_request"
        ? { ...r, parameters: { ...r.parameters, some_new_param: true } }
        : r,
    ),
  };
  const { client, calls } = fakeClient({
    listRulesets: async () => [{ id: 7, name: RULESET_NAME, source_type: "Repository" }],
    getRuleset: async () => existing,
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "unchanged");
  // No write for a repo whose only "difference" is a key the asset does
  // not model — the canonical PUT could never set it, so a write would
  // just churn every tick with no way to converge.
  assert.equal(calls.length, 0);
});

test("converge: an unmodelled rule param combined with real drift -> updated with only the modelled field in changedFields", async () => {
  const desired = buildDesiredRuleset(APPS);
  const existing = {
    id: 7,
    source_type: "Repository",
    ...desired,
    rules: desired.rules.map((r) =>
      r.type === "pull_request"
        ? {
            ...r,
            parameters: {
              ...r.parameters,
              some_new_param: true,
              required_approving_review_count: 0,
            },
          }
        : r,
    ),
  };
  const { client, calls } = fakeClient({
    listRulesets: async () => [{ id: 7, name: RULESET_NAME, source_type: "Repository" }],
    getRuleset: async () => existing,
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "updated");
  assert.deepEqual(result.changedFields, ["pull_request.required_approving_review_count"]);
  const update = calls.find((c) => c.op === "update");
  const prRule = update.body.rules.find((r) => r.type === "pull_request");
  // The corrective PUT carries the canonical value for the modelled
  // field; it cannot (and does not attempt to) set the unmodelled key.
  assert.equal(prRule.parameters.required_approving_review_count, 1);
  assert.equal(prRule.parameters.some_new_param, undefined);
});

test("converge: integration_id inside required_status_checks entries is never drift (unchanged, no write)", async () => {
  const desired = buildDesiredRuleset(APPS);
  const existing = {
    id: 7,
    source_type: "Repository",
    ...desired,
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
  };
  const { client, calls } = fakeClient({
    listRulesets: async () => [{ id: 7, name: RULESET_NAME, source_type: "Repository" }],
    getRuleset: async () => existing,
  });
  const result = await convergeProtectMainRuleset(client, "O", "r", "main", APPS, false);
  assert.equal(result.outcome, "unchanged");
  assert.equal(calls.length, 0);
});

test("AUTOMERGE_APP_SLUG is derived from the default PrAutomationIdentity's appName, not a second literal (issue #89)", () => {
  assert.equal(AUTOMERGE_APP_SLUG, DEFAULT_PR_AUTOMATION_IDENTITY.appName);
});
