/**
 * The sweep's control plane: deciding *whether* a repo is managed by the
 * converger, purely from the three org custom properties.
 *
 * Slice 2 of the org-wide repo-configuration fan-out (issue #13). This
 * module is the authoritative implementation of the decomposition's
 * "Repo selection model" precedence table
 * (`docs/org-repo-configuration-fanout-decomposition.md`). It answers the
 * managed-or-not question only; the separate version-skip question ("is
 * this managed repo already at the current release?") lives in
 * `../version-compare.ts` and is combined with this in `../stamp/decide.ts`.
 */

/**
 * The per-repo `gh-repo-config-mode` custom property. `unset` models the
 * property being absent on the repo (the sweep normalizes a missing or
 * empty value to `unset` before calling `resolveManaged`).
 */
export type SelectionMode = "process" | "ignore" | "unset";

/**
 * The org-level `gh-repo-config-default` custom property, applied to any
 * repo whose own `gh-repo-config-mode` is `unset`.
 *
 * - `opt-in`  — an unset repo is *not* managed (must be explicitly
 *   flagged `process`). This is the safe default for testing/early
 *   rollout and doubles as a kill switch (opt-in with no `process`
 *   flags anywhere manages nothing).
 * - `opt-out` — an unset repo *is* managed (must be explicitly flagged
 *   `ignore` to exclude). This is steady state: every repo, including
 *   brand-new ones, is converged automatically.
 */
export type OrgDefault = "opt-in" | "opt-out";

/**
 * Resolve whether a repo is *managed* by the converger, applying the
 * precedence table's managed-or-not rules (step 1 and step 2 of the
 * decomposition; the version-skip step 3 is applied separately).
 *
 * Precedence:
 * 1. An explicit per-repo `mode` beats the org default. `ignore` is the
 *    fail-safe verdict — when in doubt, don't touch — so an explicit
 *    `ignore` excludes the repo regardless of the org default.
 * 2. An `unset` repo follows the org default: `opt-in` ⇒ not managed,
 *    `opt-out` ⇒ managed.
 *
 * @returns `true` when the repo is managed (a convergence candidate),
 *   `false` when it is excluded from the sweep.
 */
export function resolveManaged(
  mode: SelectionMode,
  orgDefault: OrgDefault,
): boolean {
  switch (mode) {
    case "process":
      return true;
    case "ignore":
      return false;
    case "unset":
      return orgDefault === "opt-out";
  }
}

/**
 * Normalize a raw custom-property value (which may be `undefined`, an
 * empty string, or an unrecognized token) into a {@link SelectionMode}.
 *
 * Anything that is not exactly `process` or `ignore` — including a
 * missing property, an empty value, or a typo'd token — collapses to
 * `unset`, which then defers to the org default. This keeps a malformed
 * per-repo flag from silently being treated as `process`.
 */
export function normalizeMode(raw: string | undefined | null): SelectionMode {
  if (raw === "process" || raw === "ignore") {
    return raw;
  }
  return "unset";
}

/**
 * Normalize a raw org-default custom-property value into an
 * {@link OrgDefault}, falling back to the fail-safe `opt-in` when the
 * value is missing or unrecognized. A missing org default must never
 * silently manage every repo, so the fallback is `opt-in` (manage
 * nothing unless explicitly flagged).
 */
export function normalizeOrgDefault(
  raw: string | undefined | null,
): OrgDefault {
  return raw === "opt-out" ? "opt-out" : "opt-in";
}
