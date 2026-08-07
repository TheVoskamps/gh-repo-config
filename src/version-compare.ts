/**
 * Semantic-version comparison for the sweep's version-skip decision
 * (issue #13, slice 2).
 *
 * The sweep converges a *managed* repo only when its
 * `gh-repo-config-version` stamp is missing or behind the converger's
 * `CURRENT_VERSION`. That "behind" test is the only comparison this
 * module needs to answer, so it deliberately parses just the
 * `MAJOR.MINOR.PATCH` core and ignores pre-release/build metadata.
 *
 * That is safe only because the value the fan-out stamps with is
 * `CURRENT_VERSION` — this package's own `package.json` version — and a
 * prerelease `CURRENT_VERSION` is *rejected*, not tolerated:
 * `test/version.test.js` asserts it against an anchored
 * `/^\d+\.\d+\.\d+$/`, so `0.3.0-rc.1` (or `0.3.0+build5`) fails
 * `npm test` and cannot ship.
 *
 * Rejecting is the only option because a prerelease and its release
 * share an `X.Y.Z` core, which this comparison cannot tell apart: a
 * repo stamped `0.3.0-rc.1` reads as *not behind* `0.3.0`, so it would
 * never converge to the release. (`CURRENT_VERSION` need not
 * correspond to any release tag: the version is bumped in every PR,
 * while tags are pushed separately — see CLAUDE.md > Conventions.)
 */

interface SemverCore {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse the leading `MAJOR.MINOR.PATCH` of a version string, tolerating a
 * `v` prefix and semver's own pre-release/build metadata separators
 * (`1.2.3-rc.1`, `1.2.3+build5`). Returns `undefined` for a value that
 * has no parseable numeric core (including an empty or absent stamp, or
 * a core followed by anything other than end-of-string / `-` / `+`),
 * which the caller treats as "never (validly) stamped" and therefore
 * behind — the fail-safe direction. This is deliberately *not* a loose
 * "starts with digits" match: a corrupted stamp like `1.2.3junk` or
 * `1.2.3.4` must fail to parse and fall into the re-converge path rather
 * than silently matching its leading `1.2.3` and being treated as
 * current forever.
 */
function parseCore(version: string | undefined | null): SemverCore | undefined {
  if (!version) {
    return undefined;
  }
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Decide whether a repo's applied stamp is *behind* the converger's
 * current version and therefore due for (re-)convergence.
 *
 * @param stamp   the repo's `gh-repo-config-version` value, or
 *   `undefined`/empty when the property is unset (never converged).
 * @param current the converger's `CURRENT_VERSION`.
 * @returns `true` when the repo should be converged: the stamp is
 *   missing, unparseable, or strictly older than `current`. `false` when
 *   the stamp is equal to or newer than `current` (already current — a
 *   newer stamp means a newer converger ran here; a stale scheduled run
 *   must not downgrade it).
 *
 * @throws if `current` itself is not a parseable `X.Y.Z` version — that
 *   is a converger-side bug, not a target-repo condition, and must fail
 *   loudly rather than silently skipping every repo.
 */
export function isBehind(
  stamp: string | undefined | null,
  current: string,
): boolean {
  const currentCore = parseCore(current);
  if (!currentCore) {
    throw new Error(
      `Converger CURRENT_VERSION is not a parseable X.Y.Z version: ${current}`,
    );
  }
  const stampCore = parseCore(stamp);
  if (!stampCore) {
    // Missing or unparseable stamp: never (validly) converged ⇒ behind.
    return true;
  }
  if (stampCore.major !== currentCore.major) {
    return stampCore.major < currentCore.major;
  }
  if (stampCore.minor !== currentCore.minor) {
    return stampCore.minor < currentCore.minor;
  }
  return stampCore.patch < currentCore.patch;
}
