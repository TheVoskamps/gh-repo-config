/**
 * GitHub App permission checks: the one ordering of permission levels
 * and the one granted-vs-required comparison. A caller holds its own
 * required map and words its own failure; this module only says which
 * required entries a grant leaves unsatisfied.
 */

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
