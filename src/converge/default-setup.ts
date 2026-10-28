/**
 * The CodeQL default-setup convergence step (issue #16). Pure API
 * mutation — no files, no PR. The converger ships an *advanced* CodeQL
 * workflow, so it drives server-side default setup to `not-configured`:
 * default setup and an advanced workflow are mutually exclusive, and a
 * default setup left on suppresses the advanced workflow's results.
 *
 * Read-then-write on a fixed target: read the current state first and
 * PATCH only when it differs from `not-configured` (the read exists to
 * converge to the fixed target, never to decide *whether* to act).
 *
 * Once default setup is `not-configured`, the step deletes the stale
 * per-language CodeQL configurations on the default branch.
 * Default setup and the old matrix-shaped `codeql.yml` both uploaded
 * under `/language:<lang>` categories, which the shipped workflow never
 * writes, so those configurations stop updating and would otherwise stay
 * listed with their last alerts. Deletion is irreversible, so it also
 * requires the shipped workflow, identified by its `codeql-required` job,
 * to be on the default branch.
 *
 * Entitlement / availability responses (403/404 meaning "code scanning
 * not available on this repo/plan") are report-and-skip, scoped to these
 * calls only. Auth/scope errors are real failures that propagate (the
 * client throws), so the sweep's per-repo try/catch records that repo as
 * `failed`.
 */
import type { CodeScanningClient } from "../github/code-scanning.js";

/**
 * The category prefix of every configuration the converger deletes. Both
 * setups it replaces wrote it and the shipped workflow never does, so a
 * category outside it, a third-party tool's included, is never touched.
 */
export const STALE_CATEGORY_PREFIX = "/language:";

/** The shipped CodeQL workflow's path on a managed repo. */
const CODEQL_WORKFLOW_PATH = ".github/workflows/codeql.yml";

/** The shipped workflow's `codeql-required` job key, under `jobs:`. */
const CODEQL_REQUIRED_JOB = /^[ \t]+codeql-required:[ \t]*(#.*)?$/m;

/** One repo's default-setup convergence outcome. */
export type DefaultSetupOutcome =
  /** Was `configured` (or other non-target) → PATCHed to not-configured. */
  | "changed"
  /** Already `not-configured` — no write needed. */
  | "already-converged"
  /** Feature/plan unavailable (403/404) — reported, not an error. */
  | "skipped";

/** Full result of converging one repo's CodeQL default-setup state. */
export interface DefaultSetupConvergeResult {
  readonly outcome: DefaultSetupOutcome;
  /** Why it was skipped (unavailability), or the prior state on change. */
  readonly reason?: string;
  /**
   * The `/language:*` categories whose configurations were deleted, or in
   * a dry run would be. Empty when the outcome is `skipped`.
   */
  readonly staleConfigurationsDeleted: readonly string[];
  /** Why the stale-configuration deletion did not run, or stopped. */
  readonly staleConfigurationsSkipped?: string;
}

/** What {@link deleteStaleConfigurations} did. */
interface StaleConfigurationsResult {
  readonly deleted: readonly string[];
  readonly skipped?: string;
}

/**
 * Converge one repo's CodeQL default-setup to `not-configured`, then
 * delete its stale `/language:*` configurations.
 *
 * @param client the code-scanning client (already authenticated).
 * @param owner the target repo's owner (org/user).
 * @param repo the target repo's name (without owner).
 * @param dryRun when `true`, decide and report the diff without writing.
 */
export async function convergeDefaultSetup(
  client: CodeScanningClient,
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<DefaultSetupConvergeResult> {
  const read = await client.readDefaultSetup(owner, repo);
  if (read.kind === "unavailable") {
    return {
      outcome: "skipped",
      reason: `code scanning unavailable (${read.status}) — default-setup convergence skipped`,
      staleConfigurationsDeleted: [],
    };
  }

  if (read.status.state === "not-configured") {
    return withStale(
      { outcome: "already-converged" },
      await deleteStaleConfigurations(client, owner, repo, dryRun),
    );
  }

  const priorReason = `was ${read.status.state}${
    read.status.languages.length > 0 ? ` (languages: ${read.status.languages.join(", ")})` : ""
  } → not-configured`;

  if (!dryRun) {
    const res = await client.setDefaultSetupNotConfigured(owner, repo);
    if (res.status === 403 || res.status === 404) {
      return {
        outcome: "skipped",
        reason: `default-setup write unavailable (${res.status}) — skipped`,
        staleConfigurationsDeleted: [],
      };
    }
    if (!res.ok) {
      throw new Error(
        `Failed to set default-setup not-configured for ${owner}/${repo}: ${res.status} ${res.statusText}`,
      );
    }
  }

  return withStale(
    { outcome: "changed", reason: priorReason },
    await deleteStaleConfigurations(client, owner, repo, dryRun),
  );
}

/**
 * A default-setup outcome with its stale-configuration deletion's result,
 * carrying `staleConfigurationsSkipped` only when the deletion set one.
 */
function withStale(
  head: Pick<DefaultSetupConvergeResult, "outcome" | "reason">,
  stale: StaleConfigurationsResult,
): DefaultSetupConvergeResult {
  return {
    ...head,
    staleConfigurationsDeleted: stale.deleted,
    ...(stale.skipped !== undefined ? { staleConfigurationsSkipped: stale.skipped } : {}),
  };
}

/**
 * Delete every `/language:*` CodeQL configuration on the default branch,
 * provided the shipped workflow is there. GitHub deletes one analysis at a
 * time, newest first, and a configuration disappears with its last
 * analysis, so each configuration's deletion follows the response's next
 * URL until none is returned. Under `dryRun` nothing is deleted and the
 * categories that would be are returned.
 *
 * A missing workflow returns `skipped` before anything is listed. A
 * 403/404 on the list, or on any deletion, returns `skipped` with the
 * categories already deleted; any other non-ok status throws.
 */
async function deleteStaleConfigurations(
  client: CodeScanningClient,
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<StaleConfigurationsResult> {
  const workflow = await client.readDefaultBranchFile(owner, repo, CODEQL_WORKFLOW_PATH);
  if (workflow.content === undefined || !CODEQL_REQUIRED_JOB.test(workflow.content)) {
    return {
      deleted: [],
      skipped: `the default branch has no ${CODEQL_WORKFLOW_PATH} with a codeql-required job`,
    };
  }

  const list = await client.listCodeqlAnalyses(owner, repo, workflow.branch);
  if (list.kind === "unavailable") {
    return { deleted: [], skipped: `code scanning analyses unavailable (${list.status})` };
  }

  // The list is newest first, so the first analysis seen for a category is
  // the one deletion starts from.
  const configurations = new Map<string, { newestId: number; count: number }>();
  for (const analysis of list.analyses) {
    if (!analysis.category.startsWith(STALE_CATEGORY_PREFIX)) continue;
    const seen = configurations.get(analysis.category);
    if (seen === undefined) {
      configurations.set(analysis.category, { newestId: analysis.id, count: 1 });
    } else {
      seen.count++;
    }
  }

  if (dryRun) {
    return { deleted: [...configurations.keys()] };
  }

  const deleted: string[] = [];
  for (const [category, { newestId, count }] of configurations) {
    let res = await client.deleteAnalysis(owner, repo, newestId, count === 1);
    while (res.kind === "deleted" && res.next !== undefined) {
      res = await client.deleteAnalysisAt(res.next);
    }
    if (res.kind === "unavailable") {
      return {
        deleted,
        skipped: `code scanning analysis deletion unavailable (${res.status}) at ${category}`,
      };
    }
    deleted.push(category);
  }
  return { deleted };
}
