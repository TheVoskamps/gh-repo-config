/**
 * GitHub App permission checks: the one ordering of permission levels
 * and the one granted-vs-required comparison. A caller holds its own
 * required map and words its own failure; {@link findMissingPermissions}
 * only says which required entries a grant leaves unsatisfied.
 *
 * Also the PR-automation App preflight: the sweep refuses to
 * run when the App the fanned-out PR-automation workflows run as is not
 * installed on the org, or is installed without every permission those
 * workflows need. The converger cannot grant a permission itself, and
 * workflows that half-work go unnoticed: an App lacking `issues: write`
 * merges a PR carrying a closing keyword and leaves the issue open.
 */
import type { InstallationInfo } from "../github/rulesets.js";

/** A permission level an App can be granted, lowest first. */
export type PermissionLevel = "read" | "write" | "admin";

const LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = {
  read: 1,
  write: 2,
  admin: 3,
};

/** One required permission the grant does not satisfy. */
export interface MissingPermission {
  readonly permission: string;
  readonly required: PermissionLevel;
  /** The granted level as GitHub reported it, or `"none"` when absent. */
  readonly granted: string;
}

/**
 * The entries of `required` that `granted` does not satisfy, sorted by
 * permission name.
 *
 * Levels order `read < write < admin`, so a granted level at or above
 * the required one satisfies it. An absent key is reported as granted
 * `"none"`, and a granted level this ordering does not recognize never
 * satisfies (fail closed).
 */
export function findMissingPermissions(
  granted: Readonly<Record<string, string>>,
  required: Readonly<Record<string, PermissionLevel>>,
): MissingPermission[] {
  const missing: MissingPermission[] = [];
  for (const [permission, level] of Object.entries(required)) {
    const grantedLevel = Object.hasOwn(granted, permission)
      ? granted[permission]
      : undefined;
    const rank = Object.hasOwn(LEVEL_RANK, grantedLevel ?? "")
      ? LEVEL_RANK[grantedLevel as PermissionLevel]
      : 0;
    if (rank < LEVEL_RANK[level]) {
      missing.push({ permission, required: level, granted: grantedLevel ?? "none" });
    }
  }
  return missing.sort((a, b) =>
    a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0,
  );
}

/**
 * The permissions the fanned-out PR-automation workflows
 * (`auto-enable-automerge.yml`, `auto-rebase-prs.yml`) need of the App
 * they run as.
 */
export const PR_AUTOMATION_REQUIRED_PERMISSIONS: Readonly<
  Record<string, "read" | "write">
> = {
  /** Resolving a check run's workflow when judging which required checks are green. */
  actions: "read",
  /** Reading a PR's check runs before merging it. */
  checks: "read",
  /** Pushing a rebased PR head, and merging. */
  contents: "write",
  /**
   * Solely so that merging a PR carrying a closing keyword closes the
   * linked issue: the close runs under the merging token, and without
   * this grant the merge succeeds and the issue silently stays open.
   */
  issues: "write",
  /** Every repository read. */
  metadata: "read",
  /** Enabling auto-merge on a PR, and merging it. */
  pull_requests: "write",
};

/**
 * Throw unless the PR-automation App is installed on the org with every
 * permission in {@link PR_AUTOMATION_REQUIRED_PERMISSIONS}.
 *
 * @param installations the org's installations, keyed by App slug.
 * @param org the org being swept.
 * @param slug the PR-automation App's resolved slug.
 */
export function assertPrAutomationPermissions(
  installations: ReadonlyMap<string, InstallationInfo>,
  org: string,
  slug: string,
): void {
  const installation = installations.get(slug);
  if (!installation) {
    throw new Error(
      `The PR-automation App ${slug} is not installed on ${org}. Every managed ` +
        `repo gets workflows that run as this App, so install it on the ${org} ` +
        `organization with access to all repositories, then re-run the sweep.`,
    );
  }
  const missing = findMissingPermissions(
    installation.permissions,
    PR_AUTOMATION_REQUIRED_PERMISSIONS,
  );
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    [
      `The PR-automation App ${slug} on ${org} lacks permissions its workflows need:`,
      ...missing.map((m) => `  ${m.permission}: ${m.granted} (need ${m.required})`),
      `An App's permissions change only through the GitHub web UI, under Settings > ` +
        `Developer settings > GitHub Apps > ${slug} > Permissions & events; no REST ` +
        `endpoint updates them.`,
      `Updated permissions stay inactive until every installing account approves them: ` +
        `after saving, an owner of ${org} must accept the new permission request from ` +
        `the installation's settings page. Until then the installation keeps its old ` +
        `grant and this check keeps failing.`,
    ].join("\n"),
  );
}
