/**
 * The per-repo sweep verdict: combine the selection precedence
 * (managed-or-not) with the version-skip check into a single decision the
 * sweep acts on (issue #13, slice 2).
 *
 * This is the whole control plane of the walking skeleton, expressed as a
 * pure function so the sweep's I/O (reading properties, stub-converging,
 * stamping) is trivially testable around it.
 */
import {
  normalizeMode,
  normalizeOrgDefault,
  resolveManaged,
  type OrgDefault,
} from "../config/selection.js";
import { isBehind } from "../version-compare.js";

/**
 * What the sweep should do with a single repo, or (for `failed`) what it
 * ended up doing after an attempted convergence didn't succeed.
 *
 * {@link decideRepo} only ever returns the first three — `failed` is not
 * a selection/version-skip verdict, it is a post-hoc outcome the sweep
 * itself assigns in {@link SweepRepoResult} when a `converge` decision's
 * convergence step throws. It is part of this shared union (rather than
 * a separate sweep-only type) so callers that switch over
 * `SweepRepoResult.action` get exhaustiveness checking against the same
 * type `decideRepo` produces.
 */
export type RepoAction =
  /** Not managed (excluded by selection) — the sweep leaves it alone. */
  | "skip-unmanaged"
  /** Managed, but already at/ahead of the current version — no work. */
  | "skip-current"
  /** Managed and behind — converge (stubbed this slice) and re-stamp. */
  | "converge"
  /**
   * Managed and behind, convergence was attempted, and it threw. Distinct
   * from `skip-current` (which means "already up to date") — a `failed`
   * repo is *not* stamped and *not* up to date; it must be retried on the
   * next sweep and must not be silently reported as a success.
   */
  | "failed";

/** The raw custom-property values read for one repo, before normalization. */
export interface RepoProperties {
  /** `gh-repo-config-mode` — per-repo `process`/`ignore`/unset. */
  readonly mode: string | undefined | null;
  /** `gh-repo-config-version` — the applied-release stamp. */
  readonly version: string | undefined | null;
}

/** The decision for one repo, with the reason for logging/reporting. */
export interface RepoDecision {
  readonly action: RepoAction;
  /** Human-readable justification, surfaced in the sweep log. */
  readonly reason: string;
}

/**
 * Decide what to do with one repo given its raw custom-property values,
 * the org default, and the converger's current version.
 *
 * Applies the decomposition's precedence table in order: resolve
 * managed-or-not first (per-repo flag beats org default; `ignore` beats
 * `process`), then, only for managed repos, apply the version-skip.
 */
export function decideRepo(
  props: RepoProperties,
  orgDefault: OrgDefault,
  currentVersion: string,
): RepoDecision {
  const mode = normalizeMode(props.mode);
  const managed = resolveManaged(mode, orgDefault);

  if (!managed) {
    const why =
      mode === "ignore"
        ? "mode=ignore"
        : `mode=unset, org default=${orgDefault}`;
    return { action: "skip-unmanaged", reason: `not managed (${why})` };
  }

  if (!isBehind(props.version, currentVersion)) {
    return {
      action: "skip-current",
      reason: `managed, stamp ${props.version ?? "(unset)"} is current (${currentVersion})`,
    };
  }

  return {
    action: "converge",
    reason: `managed, stamp ${props.version ?? "(unset)"} behind ${currentVersion}`,
  };
}

/**
 * Convenience wrapper that also normalizes the org default from its raw
 * `gh-repo-config-default` custom-property value.
 */
export function decideRepoFromRaw(
  props: RepoProperties,
  rawOrgDefault: string | undefined | null,
  currentVersion: string,
): RepoDecision {
  return decideRepo(props, normalizeOrgDefault(rawOrgDefault), currentVersion);
}
