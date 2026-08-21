/**
 * The sweep's control plane: deciding *whether* a repo is managed by the
 * converger, purely from the org custom properties.
 *
 * Slice 2 of the org-wide repo-configuration fan-out (issue #13). This
 * module answers the managed-or-not question only; the separate
 * version-skip question ("is this managed repo already at the current
 * release?") lives in `../version-compare.ts` and is combined with this
 * in `../stamp/decide.ts`.
 *
 * Selection reads exactly one property, `gh-repo-config-mode` (issue
 * #68). Its per-repo value and its schema `default_value` speak the same
 * vocabulary and carry the same meaning — the repo's state — so the
 * org-level value read-through is a plain fallback rather than a
 * translation between two vocabularies. See `docs/repo-selection.md`.
 */

/**
 * The per-repo `gh-repo-config-mode` custom property. `unset` models the
 * property being absent on the repo (the sweep normalizes a missing,
 * empty, or unrecognized value to `unset` before calling
 * {@link resolveManaged}).
 */
export type SelectionMode = "opt-in" | "opt-out" | "unset";

/**
 * The `gh-repo-config-mode` schema's `default_value`, applied to any repo
 * whose own value is `unset`. It states the same thing a repo value
 * states — whether the repo is managed — so `opt-in` means an unset repo
 * *is* managed and `opt-out` means it is not.
 *
 * These two tokens also spelled the retired org-level default property's
 * vocabulary, with the opposite sense: that property named the org's
 * *regime*, so its `opt-in` ("repos must opt in") is this type's
 * `opt-out`, and its `opt-out` is this type's `opt-in`. A mapping ported
 * from that property inverts — see `docs/repo-selection.md`.
 */
export type DefaultMode = "opt-in" | "opt-out";

/**
 * Resolve whether a repo is *managed* by the converger.
 *
 * Precedence:
 * 1. An explicit per-repo `mode` beats the default.
 * 2. An `unset` repo follows the default: `opt-in` ⇒ managed,
 *    `opt-out` ⇒ not managed.
 *
 * @returns `true` when the repo is managed (a convergence candidate),
 *   `false` when it is excluded from the sweep.
 */
export function resolveManaged(
  mode: SelectionMode,
  defaultMode: DefaultMode,
): boolean {
  switch (mode) {
    case "opt-in":
      return true;
    case "opt-out":
      return false;
    case "unset":
      return defaultMode === "opt-in";
  }
}

/**
 * Normalize a raw custom-property value (which may be `undefined`, an
 * empty string, or an unrecognized token) into a {@link SelectionMode}.
 *
 * Anything that is not exactly `opt-in` or `opt-out` — including a
 * missing property, an empty value, or a typo'd token — collapses to
 * `unset`, which then defers to the schema default. The collapse carries
 * no verdict of its own: a malformed flag is never read as an intent to
 * manage or not to manage, so the org's declared default decides, and
 * under `default_value: opt-in` such a repo is managed.
 */
export function normalizeMode(raw: string | undefined | null): SelectionMode {
  if (raw === "opt-in" || raw === "opt-out") {
    return raw;
  }
  return "unset";
}

/**
 * Normalize a raw schema `default_value` into a {@link DefaultMode},
 * falling back to the fail-safe `opt-out` when the value is missing or
 * unrecognized. A missing default must never silently manage every repo
 * in the org, so the fallback is "manage nothing unless explicitly
 * flagged".
 */
export function normalizeDefaultMode(
  raw: string | undefined | null,
): DefaultMode {
  return raw === "opt-in" ? "opt-in" : "opt-out";
}
