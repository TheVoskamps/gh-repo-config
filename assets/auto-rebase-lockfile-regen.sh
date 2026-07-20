#!/usr/bin/env bash
#
# auto-rebase-lockfile-regen.sh
#
# Rendered by /gh-repo-setup-pr-automation into the target repo at
# .github/scripts/auto-rebase-lockfile-regen.sh. It has NO placeholders;
# it ships verbatim.
#
# Regenerate npm lockfiles that are desynced from their manifest, the
# single most common Dependabot failure: package.json bumped, but
# package-lock.json not regenerated to match, so the dependency-install
# gate (`npm ci --ignore-scripts`) fails. This is the shape of the
# recurring DIRTY Dependabot PRs.
#
# The caller (.github/workflows/auto-rebase-prs.yml) runs this with the
# PR head branch already checked out. This script does NOT commit, push,
# or touch git history -- it only mutates the lockfiles in the working
# tree and reports, via its exit code, whether a commit-and-force-push
# is warranted. Keeping git out of this script makes it cheaply
# self-testable (see test-auto-rebase-lockfile-regen.sh).
#
# Acts ONLY when the desync is LOCKFILE-ONLY (the guardrail):
#   - A manifest whose `npm ci --ignore-scripts` fails with the npm
#     lockfile-out-of-sync signature is regenerated with
#     `npm install --package-lock-only --ignore-scripts` (the bundled-dep /
#     lifecycle-script caveat: a fresh worktree has no node_modules, so a
#     postinstall like `quasar prepare` would fail -- --ignore-scripts
#     avoids it, matching the gate's own `npm ci --ignore-scripts`).
#   - If the regenerated lockfile then replays cleanly (`npm ci
#     --ignore-scripts` passes), the desync was lockfile-only and the
#     regen fixed it: record CHANGED.
#   - If `npm ci` fails with something OTHER than the desync signature
#     (e.g. a genuinely unresolvable manifest), OR the regen does not
#     make `npm ci` pass, this is NOT a fixable lockfile-only desync:
#     record UNFIXABLE and exit non-zero so the caller leaves the PR for
#     a human. Regenerating a lockfile cannot fix an unsatisfiable
#     manifest, and guessing a manifest resolution is not safe.
#
# pip is intentionally out of scope: pip does not use a lockfile the way
# npm does, and a pip gate failure is an unresolvable pin set (NOT
# lockfile-only), which must be left for a human.
#
# Why force-push-and-re-run is sufficient verification: a bad regen
# cannot slip through. The caller's force-push re-triggers the
# dependency-install gate (and any build gate); a still-broken lockfile
# fails the gate again and the PR stays red rather than merging. So this
# script does not need to pre-prove its own output beyond the local
# `npm ci` replay.
#
# Inputs: none (operates on the current working tree / checkout).
#
# Output: human-readable progress on stdout. The machine-readable result
# is the exit code.
#
# Exit codes:
#   0 -- at least one lockfile was regenerated and now replays cleanly,
#        and NO manifest was left in an unfixable state. The caller
#        should commit the changed lockfile(s) and force-push.
#   1 -- a manifest is gate-red for a reason that is NOT a fixable
#        lockfile-only desync (or a regen failed to make `npm ci` pass).
#        The caller MUST NOT push; leave the PR for a human.
#   3 -- nothing to do: every npm manifest already replays cleanly (no
#        desync). The caller should not commit or push.
#   2 -- usage / environment error.
#
# Used by .github/workflows/auto-rebase-prs.yml. Self-tested by
# .github/scripts/test-auto-rebase-lockfile-regen.sh.

set -uo pipefail

# Discover tracked npm lockfiles, excluding generated/vendored trees.
# `git ls-files` lists only tracked files, so gitignored generated
# manifests under node_modules/ / cdk.out/ never appear; the grep is
# belt-and-suspenders in case any such path is ever force-added.
discover_npm() {
  git ls-files '*package-lock.json' \
    | grep -vE '(^|/)(node_modules|cdk\.out)/' || true
}

# Does `npm ci` output carry the lockfile-out-of-sync signature?
# npm reports a desynced package.json/package-lock.json with an EUSAGE
# error whose text is one of:
#   - "`npm ci` can only install packages when your package.json and
#      package-lock.json ... are in sync ..."
#   - "Missing: <pkg>@<ver> from lock file"
#   - "Invalid: lock file's <pkg>@... does not satisfy <pkg>@..."
# Any of these means the lockfile does not match the manifest -- exactly
# the lockfile-only desync this script is allowed to fix. Other npm
# failures (a registry 404, an unresolvable manifest, a network error)
# do NOT match and are left for a human.
is_lockfile_desync() {
  local out="$1"
  printf '%s' "$out" | grep -qE \
    'can only install packages when your package\.json and package-lock\.json|Missing: .* from lock file|Invalid: lock file'
}

MODE_NPM_CI=(npm ci --ignore-scripts)
MODE_NPM_REGEN=(npm install --package-lock-only --ignore-scripts)

# Allow the self-test to inject a fake `npm` without a real registry.
NPM_BIN="${NPM_BIN:-npm}"
MODE_NPM_CI[0]="$NPM_BIN"
MODE_NPM_REGEN[0]="$NPM_BIN"

# Read discovered lockfiles into an array. Avoid `mapfile` (bash 4+) so
# this script and its self-test also run under macOS bash 3.2.
LOCKFILES=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  LOCKFILES+=("$line")
done < <(discover_npm)

if [ "${#LOCKFILES[@]}" -eq 0 ]; then
  echo "No npm lockfiles discovered. Nothing to regenerate."
  exit 3
fi

echo "Discovered ${#LOCKFILES[@]} npm lockfile(s):"
printf '  %s\n' "${LOCKFILES[@]}"
echo

changed=()      # lockfiles regenerated and now replaying cleanly
unfixable=()    # gate-red for a reason that is not a fixable desync

for lockfile in "${LOCKFILES[@]}"; do
  dir="$(dirname "$lockfile")"
  echo "::group::npm lockfile check: $lockfile"

  ci_out="$( cd "$dir" && "${MODE_NPM_CI[@]}" 2>&1 )"
  ci_rc=$?

  if [ "$ci_rc" -eq 0 ]; then
    echo "IN SYNC: $lockfile (npm ci replays cleanly; nothing to do)"
    echo "::endgroup::"
    continue
  fi

  if ! is_lockfile_desync "$ci_out"; then
    # Gate-red, but not the lockfile-out-of-sync signature. Could be an
    # unresolvable manifest, a registry error, etc. Not a fixable
    # lockfile-only desync -- leave for a human.
    echo "$ci_out"
    echo "::error file=$lockfile::npm ci failed for a reason that is not a lockfile-only desync; leaving for a human."
    unfixable+=("$lockfile")
    echo "::endgroup::"
    continue
  fi

  echo "DESYNC DETECTED: $lockfile -- regenerating with 'npm install --package-lock-only --ignore-scripts'"
  if ! ( cd "$dir" && "${MODE_NPM_REGEN[@]}" ); then
    echo "::error file=$lockfile::Lockfile regeneration command failed; leaving for a human."
    unfixable+=("$lockfile")
    echo "::endgroup::"
    continue
  fi

  # Re-verify: the regenerated lockfile must now replay cleanly. If it
  # does not, the desync was not lockfile-only (the manifest itself is
  # unsatisfiable) -- do NOT push a still-broken lockfile.
  if ( cd "$dir" && "${MODE_NPM_CI[@]}" >/dev/null 2>&1 ); then
    echo "REGENERATED: $lockfile now replays cleanly."
    changed+=("$lockfile")
  else
    echo "::error file=$lockfile::Regenerated lockfile still fails npm ci; the manifest is not satisfiable. Leaving for a human."
    unfixable+=("$lockfile")
  fi
  echo "::endgroup::"
done

echo
echo "Summary: ${#changed[@]} regenerated, ${#unfixable[@]} unfixable."

# Guardrail: if ANY manifest is unfixable, leave the whole PR for a
# human even if another lockfile regenerated cleanly. A partial push
# would re-run the gate red on the unfixable manifest anyway, and mixing
# a regen commit with a still-broken manifest only muddies the PR.
if [ "${#unfixable[@]}" -gt 0 ]; then
  echo "FAILED: leaving PR for a human (unfixable manifest present):"
  printf '  %s\n' "${unfixable[@]}"
  exit 1
fi

if [ "${#changed[@]}" -gt 0 ]; then
  echo "Regenerated lockfile(s) ready to commit:"
  printf '  %s\n' "${changed[@]}"
  exit 0
fi

echo "No desynced lockfiles found; nothing to commit."
exit 3
