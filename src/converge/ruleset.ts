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
 * default branch. "Governs" = an `active`, `source_type: "Organization"`
 * ruleset (branch target) is present in the repo's inherited ruleset
 * list. The list endpoint already resolves ref-name conditions to the
 * repo (an org ruleset only appears here when its include-minus-exclude
 * conditions cover this repo), so an inherited org ruleset's presence is
 * itself the "covers the default branch" signal.
 */
export function orgRulesetGoverns(rulesets: readonly RulesetSummary[]): boolean {
  return rulesets.some(
    (r) =>
      r.source_type === "Organization" &&
      (r.enforcement === undefined || r.enforcement === "active"),
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
 * Normalizes per the issue's compare rules:
 *
 * - `ref_name.include`: converged when it contains `~DEFAULT_BRANCH` (or
 *   the concrete `refs/heads/<default>`), superset ok.
 * - required checks: compared on the `context` set only (ignore
 *   `integration_id`).
 * - bypass actors: converged when the existing set **contains** every
 *   desired actor (set-containment on the `(actor_id/app_id, actor_type,
 *   bypass_mode)` tuple).
 * - rule types + enforcement compared directly.
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

  // Bypass actors: converged when existing contains every desired actor.
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
