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
 * Entitlement / availability responses (403/404 meaning "code scanning
 * not available on this repo/plan") are report-and-skip, scoped to these
 * calls only. Auth/scope errors are real failures that propagate (the
 * client throws), so the sweep's per-repo try/catch records that repo as
 * `failed`.
 */
import type { CodeScanningClient } from "../github/code-scanning.js";

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
}

/**
 * Converge one repo's CodeQL default-setup to `not-configured`.
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
    };
  }

  if (read.status.state === "not-configured") {
    return { outcome: "already-converged" };
  }

  const priorReason = `was ${read.status.state}${
    read.status.languages.length > 0
      ? ` (languages: ${read.status.languages.join(", ")})`
      : ""
  } → not-configured`;

  if (dryRun) {
    return { outcome: "changed", reason: priorReason };
  }

  const res = await client.setDefaultSetupNotConfigured(owner, repo);
  if (res.ok) {
    return { outcome: "changed", reason: priorReason };
  }
  if (res.status === 403 || res.status === 404) {
    return {
      outcome: "skipped",
      reason: `default-setup write unavailable (${res.status}) — skipped`,
    };
  }
  throw new Error(
    `Failed to set default-setup not-configured for ${owner}/${repo}: ${res.status} ${res.statusText}`,
  );
}
