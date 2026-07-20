/**
 * The `protect-main` ruleset convergence step (issue #16). Pure API
 * mutation — no files, no PR. Creates or converges (in place) the
 * repo-level `protect-main` ruleset to the canonical shape carried in
 * `assets/protect-main-ruleset.json`, or defers (and deletes the repo
 * copy) when an org-level ruleset already governs the default branch.
 *
 * The decision logic (build the desired body, detect an org ruleset,
 * semantic-compare desired vs existing) is factored into pure functions
 * so the sweep's unit tests can exercise create / update / unchanged /
 * org-governed / bypass-union / code_quality-retry without a live API.
 * {@link convergeProtectMainRuleset} is the thin I/O orchestration on
 * top.
 */
import { readAssetText } from "./assets.js";
import type {
  BypassActor,
  ExistingRuleset,
  RulesetBody,
  RulesetRule,
  RulesetSummary,
  RulesetsClient,
} from "../github/rulesets.js";

/** The ruleset name this converger owns. */
export const RULESET_NAME = "protect-main";

/**
 * The AUTOMERGE (pr-automation) App's slug, ensured as a `pull_request`
 * bypass actor alongside the converger App. A constant, not env-plumbed:
 * unlike the converger's own slug (which the sweep already knows from
 * `GH_REPO_CONFIG_APP_SLUG`), this is the fixed identity of the org's
 * pr-automation App.
 */
export const AUTOMERGE_APP_SLUG = "thevoskamps-pr-automations";

/** The built-in Repository-admin role id (documented GitHub value). */
const ADMIN_ACTOR_ID = 5;

/** GitHub's symbolic ref for a repo's default branch. */
const DEFAULT_BRANCH_SYMBOLIC = "~DEFAULT_BRANCH";

/** How one repo's ruleset convergence settled. */
export type RulesetOutcome =
  | "created"
  | "updated"
  | "unchanged"
  /** An org-level ruleset governs the default branch; repo copy deleted/deferred. */
  | "org-governed";

/** Full result of converging one repo's `protect-main` ruleset. */
export interface RulesetConvergeResult {
  readonly outcome: RulesetOutcome;
  /** For `updated`: the field names that differed. */
  readonly changedFields?: readonly string[];
  /** Apps that could not be resolved to an installed app_id (omitted from bypass). */
  readonly uninstalledApps?: readonly string[];
  /** Set when the `code_quality` rule was dropped after a 422. */
  readonly codeQualitySkipped?: boolean;
  /** Human-readable notes (e.g. org-governed rationale, deleted repo copy). */
  readonly reason?: string;
}

/** An App to ensure as a `pull_request` bypass actor, by slug. */
export interface AppBypass {
  readonly slug: string;
  /** The resolved app_id, or `undefined` when the App is not installed. */
  readonly appId: number | undefined;
}

/**
 * Read the canonical ruleset shape from `assets/protect-main-ruleset.json`
 * and specialize it for one repo: resolve `~DEFAULT_BRANCH` (kept
 * symbolic so the ruleset follows a default-branch rename) and union the
 * App bypass actors onto the template's admin entry.
 *
 * The template already carries the admin PR-only entry and the four
 * required aggregator checks; this only augments the bypass list with the
 * resolved Apps (each `{ app_id, "Integration", "pull_request" }`). An
 * App whose `appId` is `undefined` (not installed) is omitted.
 */
export function buildDesiredRuleset(appBypass: readonly AppBypass[]): RulesetBody {
  const template = JSON.parse(readAssetText("protect-main-ruleset.json")) as RulesetBody;
  const appActors: BypassActor[] = appBypass
    .filter((a): a is AppBypass & { appId: number } => a.appId !== undefined)
    .map((a) => ({
      actor_id: a.appId,
      actor_type: "Integration",
      bypass_mode: "pull_request",
    }));
  return {
    ...template,
    bypass_actors: [...template.bypass_actors, ...appActors],
  };
}

/**
 * A canonical, order-independent key for a bypass actor: an App is keyed
 * by its `app_id` under `actor_type: Integration`; every other actor by
 * `actor_id`. Includes `bypass_mode` so a mode change is a difference.
 */
function bypassKey(actor: BypassActor): string {
  return `${actor.actor_type}:${actor.actor_id}:${actor.bypass_mode}`;
}

/**
 * Union the desired bypass actors onto the existing ones: preserve every
 * actor the repo already has, and ensure each desired actor is present.
 * Never drops an existing actor (clearing a bypass is an operator
 * posture change). Returns `existing ∪ desired` de-duplicated by
 * {@link bypassKey}.
 */
export function unionBypassActors(
  existing: readonly BypassActor[],
  desired: readonly BypassActor[],
): BypassActor[] {
  const seen = new Set<string>();
  const out: BypassActor[] = [];
  for (const actor of [...existing, ...desired]) {
    const key = bypassKey(actor);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(actor);
    }
  }
  return out;
}

/**
 * Whether an active org-sourced branch ruleset governs the repo's
 * default branch. "Governs" = an `active`, `source_type: "Organization"`,
 * `target: "branch"` ruleset is present in the repo's inherited ruleset
 * list. The list endpoint already resolves ref-name conditions to the
 * repo (an org ruleset only appears here when its include-minus-exclude
 * conditions cover this repo), so an inherited org **branch** ruleset's
 * presence is itself the "covers the default branch" signal — but the
 * list is NOT filtered by target type, so an org-level `tag` or `push`
 * ruleset also appears here and must be excluded explicitly, or it would
 * be misclassified as governing and cause the converger to delete the
 * repo-level `protect-main` branch ruleset. `enforcement` is required to
 * be exactly `"active"` (not merely absent) since the live list summary
 * always carries the field — an `undefined` fallback would over-match a
 * response shape that doesn't occur in practice.
 */
export function orgRulesetGoverns(rulesets: readonly RulesetSummary[]): boolean {
  return rulesets.some(
    (r) => r.source_type === "Organization" && r.target === "branch" && r.enforcement === "active",
  );
}

/** The `required_status_checks` context set of a ruleset body, or empty. */
function requiredContexts(body: RulesetBody): Set<string> {
  const rule = body.rules.find((r) => r.type === "required_status_checks");
  const checks =
    (rule?.parameters?.required_status_checks as
      | readonly { context: string }[]
      | undefined) ?? [];
  return new Set(checks.map((c) => c.context));
}

/** The set of rule types present in a ruleset body. */
function ruleTypes(body: RulesetBody): Set<string> {
  return new Set(body.rules.map((r) => r.type));
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false;
    }
  }
  return true;
}

/** Find a rule of a given type in a body's `rules` array, or `undefined`. */
function findRule(body: RulesetBody, type: string): RulesetRule | undefined {
  return body.rules.find((r) => r.type === type);
}

/**
 * Deep-equal on plain JSON-shaped values (objects/arrays/primitives) —
 * sufficient for comparing rule `parameters` sub-fields, which are all
 * plain JSON from the REST API. Not a general-purpose deep-equal (no
 * `Map`/`Set`/cyclic handling), which the ruleset parameter shapes never
 * need.
 */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((k) =>
      jsonEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * Compare one named field of two rules' `parameters`, appending
 * `<type>.<field>` to `changed` when it differs. Both `desired` and
 * `existing` are the full rule (or `undefined` if the side lacks the
 * rule entirely) — the caller only invokes this when both sides carry
 * the rule, so a missing rule never reports a spurious parameter diff
 * (see the `code_quality`-absent-on-server case).
 */
function compareRuleParam(
  changed: string[],
  desired: RulesetRule,
  existing: RulesetRule,
  field: string,
): void {
  const desiredValue = desired.parameters?.[field];
  const existingValue = existing.parameters?.[field];
  if (!jsonEquals(desiredValue, existingValue)) {
    changed.push(`${desired.type}.${field}`);
  }
}

/**
 * Whether the existing `ref_name.include` is already converged for the
 * given default branch. Converged when it contains the symbolic
 * `~DEFAULT_BRANCH` or the concrete `refs/heads/<default>` (a superset is
 * fine — the reference repo stores both). Do not re-PUT merely to strip a
 * redundant concrete entry; that churn is a spurious write.
 */
function refNameConverged(existing: readonly string[], defaultBranch: string): boolean {
  const concrete = `refs/heads/${defaultBranch}`;
  return existing.includes(DEFAULT_BRANCH_SYMBOLIC) || existing.includes(concrete);
}

/**
 * Semantic diff of the desired ruleset against an existing one — the
 * field names that differ after normalization, empty when converged.
 *
 * **Posture: canonical-authoritative.** The converger's purpose is to
 * guarantee the *identical* canonical ruleset (as carried in
 * `assets/protect-main-ruleset.json`) on every managed repo. A repo's
 * existing ruleset state is not operator intent to preserve — it is
 * exactly the variance this converger exists to eliminate. The single
 * deliberate exception is bypass actors (see below); every other field,
 * including rule parameters, is compared against the canonical shape
 * and any difference is reported as drift, to be corrected by the
 * existing PUT of the canonical body. There are no preservation
 * heuristics beyond what issue #16 §3 specifies.
 *
 * Normalizes per the issue's compare rules:
 *
 * - `ref_name.include`: converged when it contains `~DEFAULT_BRANCH` (or
 *   the concrete `refs/heads/<default>`), superset ok.
 * - `ref_name.exclude`: compared directly against the canonical value
 *   (`[]`) — any non-empty exclude is drift.
 * - required checks: the `context` set compared by name only (ignore
 *   `integration_id`); the non-list `required_status_checks` parameters
 *   (`strict_required_status_checks_policy`, `do_not_enforce_on_create`)
 *   are compared directly against the canonical value.
 * - `pull_request` rule parameters: every field compared directly
 *   against the canonical value.
 * - `code_scanning` rule parameters: the `code_scanning_tools` list
 *   compared directly against the canonical value (exact compare, no
 *   union/preservation of extra tools).
 * - `code_quality` rule parameters (`severity`): compared only when
 *   both the desired and existing bodies carry the rule at all — a
 *   `code_quality` rule absent on the server (e.g. after a prior
 *   422-retry drop) is not itself drift, so the existing
 *   `codeQualitySkipped` retry path is unaffected.
 * - bypass actors: converged when the existing set **contains** every
 *   desired actor (set-containment on the `(actor_id/app_id, actor_type,
 *   bypass_mode)` tuple) — the one deliberate preservation surface
 *   (issue #16 §3.4): an operator's own extra bypass actors are never
 *   reported as drift.
 * - rule types compared as an exact set — an extra rule type on the
 *   server is drift, and the canonical PUT strips it.
 * - enforcement compared directly.
 *
 * @param desired the desired body (bypass actors already unioned in).
 * @param existing the ruleset read from the server.
 * @param defaultBranch the repo's default branch, for the ref-name compare.
 */
export function rulesetSemanticDiff(
  desired: RulesetBody,
  existing: ExistingRuleset,
  defaultBranch: string,
): string[] {
  const changed: string[] = [];

  if (existing.enforcement !== desired.enforcement) {
    changed.push("enforcement");
  }

  if (!refNameConverged(existing.conditions.ref_name.include, defaultBranch)) {
    changed.push("conditions.ref_name.include");
  }

  if (!jsonEquals(existing.conditions.ref_name.exclude, desired.conditions.ref_name.exclude)) {
    changed.push("conditions.ref_name.exclude");
  }

  // Bypass actors: converged when existing contains every desired actor.
  // Deliberate preservation surface — an operator's extra actors are
  // never reported as drift (issue #16 §3.4).
  const existingKeys = new Set(existing.bypass_actors.map(bypassKey));
  const missingActor = desired.bypass_actors.some((a) => !existingKeys.has(bypassKey(a)));
  if (missingActor) {
    changed.push("bypass_actors");
  }

  if (!setEquals(ruleTypes(desired), ruleTypes(existing))) {
    changed.push("rules");
  }

  if (!setEquals(requiredContexts(desired), requiredContexts(existing))) {
    changed.push("required_status_checks");
  }

  // Rule parameters, checked against the canonical shape. Each compare
  // is skipped when either side lacks the rule (the rule-types set
  // compare above already reports that as `rules` drift), except
  // code_quality, whose absence on the server is a known, tolerated
  // state (the 422-retry-without path) rather than drift.
  const desiredPr = findRule(desired, "pull_request");
  const existingPr = findRule(existing, "pull_request");
  if (desiredPr && existingPr) {
    for (const field of Object.keys(desiredPr.parameters ?? {})) {
      compareRuleParam(changed, desiredPr, existingPr, field);
    }
  }

  const desiredRsc = findRule(desired, "required_status_checks");
  const existingRsc = findRule(existing, "required_status_checks");
  if (desiredRsc && existingRsc) {
    compareRuleParam(changed, desiredRsc, existingRsc, "strict_required_status_checks_policy");
    compareRuleParam(changed, desiredRsc, existingRsc, "do_not_enforce_on_create");
  }

  const desiredCs = findRule(desired, "code_scanning");
  const existingCs = findRule(existing, "code_scanning");
  if (desiredCs && existingCs) {
    compareRuleParam(changed, desiredCs, existingCs, "code_scanning_tools");
  }

  // code_quality: compared only when BOTH sides carry the rule. Absent
  // on the server alone (e.g. after a prior 422-retry drop) is not
  // drift — it must not trigger a write that would just 422 again.
  const desiredCq = findRule(desired, "code_quality");
  const existingCq = findRule(existing, "code_quality");
  if (desiredCq && existingCq) {
    compareRuleParam(changed, desiredCq, existingCq, "severity");
  }

  return changed;
}

/** Return a copy of a ruleset body with the `code_quality` rule dropped. */
function withoutCodeQuality(body: RulesetBody): RulesetBody {
  return { ...body, rules: body.rules.filter((r) => r.type !== "code_quality") };
}

/**
 * Whether a body carries a `code_quality` rule (so the caller knows a
 * `code-quality-422` retry is applicable at all).
 */
function hasCodeQuality(rules: readonly RulesetRule[]): boolean {
  return rules.some((r) => r.type === "code_quality");
}

/**
 * Converge one repo's `protect-main` ruleset.
 *
 * Flow:
 * 1. List rulesets. If an active org ruleset governs the default branch,
 *    delete the repo-level `protect-main` copy (if any) and defer.
 * 2. Otherwise build the desired body (default-branch-resolved + App
 *    bypass union), read any existing repo `protect-main`, semantic-
 *    compare, and create / update / report-unchanged.
 * 3. A `code_quality`-attributable 422 on the write is retried once with
 *    that rule dropped, then reported as `codeQualitySkipped`.
 *
 * @param client the rulesets client (already authenticated).
 * @param owner the target repo's owner (org/user).
 * @param repo the target repo's name (without owner).
 * @param defaultBranch the repo's default branch (for the ref-name compare).
 * @param appBypass the Apps to ensure as `pull_request` bypass actors
 *   (each with its resolved app_id, or `undefined` when not installed).
 * @param dryRun when `true`, decide and report without writing.
 */
export async function convergeProtectMainRuleset(
  client: RulesetsClient,
  owner: string,
  repo: string,
  defaultBranch: string,
  appBypass: readonly AppBypass[],
  dryRun: boolean,
): Promise<RulesetConvergeResult> {
  const uninstalledApps = appBypass.filter((a) => a.appId === undefined).map((a) => a.slug);

  const rulesets = await client.listRulesets(owner, repo);
  const existingRepoCopy = rulesets.find(
    (r) => r.name === RULESET_NAME && r.source_type !== "Organization",
  );

  // 1. Org ruleset governs → delete repo copy (if any) and defer.
  if (orgRulesetGoverns(rulesets)) {
    if (existingRepoCopy && !dryRun) {
      await client.deleteRuleset(owner, repo, existingRepoCopy.id);
    }
    return {
      outcome: "org-governed",
      ...(uninstalledApps.length > 0 ? { uninstalledApps } : {}),
      reason: existingRepoCopy
        ? "org-level ruleset governs the default branch; deleted the repo-level protect-main copy and deferred"
        : "org-level ruleset governs the default branch; no repo-level copy to delete, deferred",
    };
  }

  // 2. No org ruleset → converge the repo-level copy.
  const desired = buildDesiredRuleset(appBypass);

  if (!existingRepoCopy) {
    if (dryRun) {
      return {
        outcome: "created",
        ...(uninstalledApps.length > 0 ? { uninstalledApps } : {}),
      };
    }
    const write = await writeWithCodeQualityRetry(desired, (body) =>
      client.createRuleset(owner, repo, body),
    );
    return {
      outcome: "created",
      ...(uninstalledApps.length > 0 ? { uninstalledApps } : {}),
      ...(write.codeQualitySkipped ? { codeQualitySkipped: true } : {}),
    };
  }

  const existing = await client.getRuleset(owner, repo, existingRepoCopy.id);
  // Union the desired bypass actors onto the existing ones so a PUT
  // preserves every actor the repo already had (never a replacement that
  // drops the operator's other bypasses).
  const desiredWithUnion: RulesetBody = {
    ...desired,
    bypass_actors: unionBypassActors(existing.bypass_actors, desired.bypass_actors),
  };
  const changedFields = rulesetSemanticDiff(desiredWithUnion, existing, defaultBranch);

  if (changedFields.length === 0) {
    return {
      outcome: "unchanged",
      ...(uninstalledApps.length > 0 ? { uninstalledApps } : {}),
    };
  }

  if (dryRun) {
    return {
      outcome: "updated",
      changedFields,
      ...(uninstalledApps.length > 0 ? { uninstalledApps } : {}),
    };
  }

  const write = await writeWithCodeQualityRetry(desiredWithUnion, (body) =>
    client.updateRuleset(owner, repo, existing.id, body),
  );
  return {
    outcome: "updated",
    changedFields,
    ...(uninstalledApps.length > 0 ? { uninstalledApps } : {}),
    ...(write.codeQualitySkipped ? { codeQualitySkipped: true } : {}),
  };
}

/**
 * Run a create/update write, retrying once without the `code_quality`
 * rule when the first attempt returns a `code_quality`-attributable 422.
 * Returns whether the rule ended up dropped.
 */
async function writeWithCodeQualityRetry(
  body: RulesetBody,
  write: (body: RulesetBody) => Promise<{ kind: "ok" | "code-quality-422" }>,
): Promise<{ codeQualitySkipped: boolean }> {
  const first = await write(body);
  if (first.kind === "ok") {
    return { codeQualitySkipped: false };
  }
  // code-quality-422: retry once with the rule dropped. If the body had
  // no code_quality rule to begin with, this cannot recur — but the
  // client only returns this kind on a code_quality-attributable 422, so
  // a body carrying the rule is the expected case.
  if (!hasCodeQuality(body.rules)) {
    throw new Error(
      "ruleset write returned a code_quality 422 but the desired body has no code_quality rule to drop",
    );
  }
  const retry = await write(withoutCodeQuality(body));
  if (retry.kind === "ok") {
    return { codeQualitySkipped: true };
  }
  throw new Error(
    "ruleset write still returned a code_quality 422 after dropping the code_quality rule",
  );
}
