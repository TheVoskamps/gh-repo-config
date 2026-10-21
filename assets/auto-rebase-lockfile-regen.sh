#!/usr/bin/env bash
#
# auto-rebase-lockfile-regen.sh
#
# Rendered by /gh-repo-setup-pr-automation into the target repo at
# .github/scripts/auto-rebase-lockfile-regen.sh. It has NO placeholders;
# it ships verbatim.
#
# Regenerate npm and pnpm lockfiles that are desynced from their
# manifest, the single most common Dependabot failure: package.json
# bumped, but package-lock.json / pnpm-lock.yaml not regenerated to
# match, so the dependency-install gate (`npm ci --ignore-scripts` /
# `pnpm install --frozen-lockfile --ignore-scripts`) fails. This is the
# shape of the recurring DIRTY Dependabot PRs.
#
# The caller (.github/workflows/auto-rebase-prs.yml) runs this with the
# PR head branch already checked out. This script does NOT commit, push,
# or touch git history -- it only mutates the lockfiles in the working
# tree and reports, via its exit code, whether a commit-and-force-push
# is warranted. Keeping git out of this script makes it cheaply
# self-testable (see test-auto-rebase-lockfile-regen.sh).
#
# Acts ONLY when the desync is LOCKFILE-ONLY (the guardrail):
#   - A manifest whose replay fails with its package manager's
#     lockfile-out-of-sync signature is regenerated:
#       npm:  replay `npm ci --ignore-scripts`, regen
#             `npm install --package-lock-only --ignore-scripts`.
#       pnpm: replay `pnpm install --frozen-lockfile --ignore-scripts`,
#             regen `pnpm install --lockfile-only --ignore-scripts`.
#     --ignore-scripts is the bundled-dep / lifecycle-script caveat: a
#     fresh worktree has no node_modules, so a postinstall like
#     `quasar prepare` would fail, and it matches the gate's own replay.
#   - If the regenerated lockfile then replays cleanly, the desync was
#     lockfile-only and the regen fixed it: record CHANGED.
#   - If the replay fails with something OTHER than the desync signature
#     (e.g. a genuinely unresolvable manifest), OR the regen does not
#     make the replay pass, this is NOT a fixable lockfile-only desync:
#     record UNFIXABLE and exit non-zero so the caller leaves the PR for
#     a human. Regenerating a lockfile cannot fix an unsatisfiable
#     manifest, and guessing a manifest resolution is not safe.
#   - pnpm runs through Corepack, so the regen uses the pnpm version the
#     manifest's `packageManager` pins. `corepack enable` must succeed:
#     on failure the manifest is UNFIXABLE and no pnpm command runs for
#     it, rather than falling back to whatever `pnpm` is on PATH.
#   - A directory tracking both package-lock.json and pnpm-lock.yaml is
#     UNFIXABLE and neither lockfile is regenerated: which one the
#     project means is not this script's call.
#
# pip is intentionally out of scope: pip does not use a lockfile the way
# npm does, and a pip gate failure is an unresolvable pin set (NOT
# lockfile-only), which must be left for a human. yarn lockfile
# regeneration is out of scope too.
#
# Why force-push-and-re-run is sufficient verification: a bad regen
# cannot slip through. The caller's force-push re-triggers the
# dependency-install gate (and any build gate); a still-broken lockfile
# fails the gate again and the PR stays red rather than merging. So this
# script does not need to pre-prove its own output beyond the local
# replay.
#
# Inputs: none (operates on the current working tree / checkout).
# NPM_BIN, PNPM_BIN, and COREPACK_BIN override the binaries, for the
# self-test.
#
# Output: human-readable progress on stdout. The machine-readable result
# is the exit code.
#
# Exit codes:
#   0 -- at least one lockfile was regenerated and now replays cleanly,
#        and NO manifest was left in an unfixable state. The caller
#        should commit the changed lockfile(s) and force-push.
#   1 -- a manifest is gate-red for a reason that is NOT a fixable
#        lockfile-only desync (or a regen failed to make the replay
#        pass). The caller MUST NOT push; leave the PR for a human.
#   3 -- nothing to do: every npm and pnpm manifest already replays
#        cleanly (no desync). The caller should not commit or push.
#   2 -- usage / environment error.
#
# Used by .github/workflows/auto-rebase-prs.yml. Self-tested by
# .github/scripts/test-auto-rebase-lockfile-regen.sh.

set -uo pipefail

# Discover tracked lockfiles matching $1, excluding generated/vendored
# trees. `git ls-files` lists only tracked files, so gitignored generated
# manifests under node_modules/ / cdk.out/ never appear; the grep is
# belt-and-suspenders in case any such path is ever force-added.
discover() {
  git ls-files "$1" \
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
is_npm_desync() {
  local out="$1"
  printf '%s' "$out" | grep -qE \
    'can only install packages when your package\.json and package-lock\.json|Missing: .* from lock file|Invalid: lock file'
}

# Does a pnpm frozen-lockfile replay carry the out-of-sync signature?
# Matched on the error code alone, never the message text after it.
is_pnpm_desync() {
  local out="$1"
  printf '%s' "$out" | grep -q 'ERR_PNPM_OUTDATED_LOCKFILE'
}

# Allow the self-test to inject fake binaries without a real registry.
NPM_BIN="${NPM_BIN:-npm}"
PNPM_BIN="${PNPM_BIN:-pnpm}"
COREPACK_BIN="${COREPACK_BIN:-corepack}"

MODE_NPM_CI=("$NPM_BIN" ci --ignore-scripts)
MODE_NPM_REGEN=("$NPM_BIN" install --package-lock-only --ignore-scripts)
MODE_PNPM_CI=("$PNPM_BIN" install --frozen-lockfile --ignore-scripts)
MODE_PNPM_REGEN=("$PNPM_BIN" install --lockfile-only --ignore-scripts)

# Read discovered lockfiles into arrays. Avoid `mapfile` (bash 4+) so
# this script and its self-test also run under macOS bash 3.2.
NPM_LOCKFILES=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  NPM_LOCKFILES+=("$line")
done < <(discover '*package-lock.json')

PNPM_LOCKFILES=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  PNPM_LOCKFILES+=("$line")
done < <(discover '*pnpm-lock.yaml')

if [ "${#NPM_LOCKFILES[@]}" -eq 0 ] && [ "${#PNPM_LOCKFILES[@]}" -eq 0 ]; then
  echo "No npm or pnpm lockfiles discovered. Nothing to regenerate."
  exit 3
fi

if [ "${#NPM_LOCKFILES[@]}" -gt 0 ]; then
  echo "Discovered ${#NPM_LOCKFILES[@]} npm lockfile(s):"
  printf '  %s\n' "${NPM_LOCKFILES[@]}"
  echo
fi
if [ "${#PNPM_LOCKFILES[@]}" -gt 0 ]; then
  echo "Discovered ${#PNPM_LOCKFILES[@]} pnpm lockfile(s):"
  printf '  %s\n' "${PNPM_LOCKFILES[@]}"
  echo
fi

changed=()      # lockfiles regenerated and now replaying cleanly
unfixable=()    # gate-red for a reason that is not a fixable desync

# Directories tracking both an npm and a pnpm lockfile, newline-joined.
MIXED_DIRS=""
if [ "${#NPM_LOCKFILES[@]}" -gt 0 ] && [ "${#PNPM_LOCKFILES[@]}" -gt 0 ]; then
  for npm_lock in "${NPM_LOCKFILES[@]}"; do
    for pnpm_lock in "${PNPM_LOCKFILES[@]}"; do
      if [ "$(dirname "$npm_lock")" = "$(dirname "$pnpm_lock")" ]; then
        dir="$(dirname "$npm_lock")"
        echo "::error file=$pnpm_lock::$dir tracks both package-lock.json and pnpm-lock.yaml; regenerating neither. Leaving for a human."
        unfixable+=("$npm_lock" "$pnpm_lock")
        MIXED_DIRS="$MIXED_DIRS$dir"$'\n'
      fi
    done
  done
fi

is_mixed_dir() {
  printf '%s' "$MIXED_DIRS" | grep -qxF -- "$1"
}

# check_lockfile <pm> <lockfile>: replay, and on a desync regenerate and
# replay again, recording the lockfile in `changed` or `unfixable`.
check_lockfile() {
  local pm="$1" lockfile="$2"
  local dir ci_out ci_rc corepack_out regen_desc
  local -a replay regen
  dir="$(dirname "$lockfile")"

  if is_mixed_dir "$dir"; then
    return
  fi

  if [ "$pm" = "npm" ]; then
    replay=("${MODE_NPM_CI[@]}")
    regen=("${MODE_NPM_REGEN[@]}")
    regen_desc="npm install --package-lock-only --ignore-scripts"
  else
    replay=("${MODE_PNPM_CI[@]}")
    regen=("${MODE_PNPM_REGEN[@]}")
    regen_desc="pnpm install --lockfile-only --ignore-scripts"
  fi

  echo "::group::$pm lockfile check: $lockfile"

  if [ "$pm" = "pnpm" ]; then
    # Corepack provisions the pnpm `packageManager` pins. Without it the
    # replay would run an unvetted pnpm from PATH, so a failure here
    # stops this manifest before any pnpm command runs.
    if ! corepack_out="$( cd "$dir" && "$COREPACK_BIN" enable 2>&1 )"; then
      echo "$corepack_out"
      echo "::error file=$lockfile::corepack enable failed for $lockfile; running no pnpm command for it. Leaving for a human."
      unfixable+=("$lockfile")
      echo "::endgroup::"
      return
    fi
  fi

  ci_out="$( cd "$dir" && "${replay[@]}" 2>&1 )"
  ci_rc=$?

  if [ "$ci_rc" -eq 0 ]; then
    if [ "$pm" = "npm" ]; then
      echo "IN SYNC: $lockfile (npm ci replays cleanly; nothing to do)"
    else
      echo "IN SYNC: $lockfile (pnpm install --frozen-lockfile replays cleanly; nothing to do)"
    fi
    echo "::endgroup::"
    return
  fi

  local desync=1
  if [ "$pm" = "npm" ]; then
    is_npm_desync "$ci_out" || desync=0
  else
    is_pnpm_desync "$ci_out" || desync=0
  fi
  if [ "$desync" -eq 0 ]; then
    # Gate-red, but not the lockfile-out-of-sync signature. Could be an
    # unresolvable manifest, a registry error, etc. Not a fixable
    # lockfile-only desync -- leave for a human.
    echo "$ci_out"
    if [ "$pm" = "npm" ]; then
      echo "::error file=$lockfile::npm ci failed for a reason that is not a lockfile-only desync; leaving for a human."
    else
      echo "::error file=$lockfile::pnpm install --frozen-lockfile failed for a reason that is not a lockfile-only desync; leaving for a human."
    fi
    unfixable+=("$lockfile")
    echo "::endgroup::"
    return
  fi

  echo "DESYNC DETECTED: $lockfile -- regenerating with '$regen_desc'"
  if ! ( cd "$dir" && "${regen[@]}" ); then
    echo "::error file=$lockfile::Lockfile regeneration command failed; leaving for a human."
    unfixable+=("$lockfile")
    echo "::endgroup::"
    return
  fi

  # Re-verify: the regenerated lockfile must now replay cleanly. If it
  # does not, the desync was not lockfile-only (the manifest itself is
  # unsatisfiable) -- do NOT push a still-broken lockfile.
  if ( cd "$dir" && "${replay[@]}" >/dev/null 2>&1 ); then
    echo "REGENERATED: $lockfile now replays cleanly."
    changed+=("$lockfile")
  elif [ "$pm" = "npm" ]; then
    echo "::error file=$lockfile::Regenerated lockfile still fails npm ci; the manifest is not satisfiable. Leaving for a human."
    unfixable+=("$lockfile")
  else
    echo "::error file=$lockfile::Regenerated lockfile still fails pnpm install --frozen-lockfile; the manifest is not satisfiable. Leaving for a human."
    unfixable+=("$lockfile")
  fi
  echo "::endgroup::"
}

for lockfile in ${NPM_LOCKFILES[@]+"${NPM_LOCKFILES[@]}"}; do
  check_lockfile npm "$lockfile"
done
for lockfile in ${PNPM_LOCKFILES[@]+"${PNPM_LOCKFILES[@]}"}; do
  check_lockfile pnpm "$lockfile"
done

echo
echo "Summary: ${#changed[@]} regenerated, ${#unfixable[@]} unfixable."

# Guardrail: if ANY manifest is unfixable, whatever its package manager,
# leave the whole PR for a human even if another lockfile regenerated
# cleanly. A partial push would re-run the gate red on the unfixable
# manifest anyway, and mixing a regen commit with a still-broken
# manifest only muddies the PR.
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
