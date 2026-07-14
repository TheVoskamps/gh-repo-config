#!/usr/bin/env bash
#
# dependency-install-gate.sh
#
# Installed verbatim (no placeholders) at
# <repo-root>/.github/scripts/dependency-install-gate.sh by
# /gh-repo-setup-protection, alongside its workflow at
# <repo-root>/.github/workflows/dependency-install-gate.yml.
#
# Strict, lockfile-honoring install gate over the repo's dependency
# manifests, discovered at RUNTIME from the tracked git tree (not a
# hardcoded path list -- a list rots when a new CDK app / lambda /
# package is added). Catches a drifted package.json/<lockfile>
# (or an unresolvable requirements pin) BEFORE merge to the default
# branch, blocking a desynced lockfile (a common Dependabot / hand-edit
# failure mode) from auto-merging and breaking local dev and downstream
# pipelines.
#
# This is install-integrity ONLY -- NO build (`npm run build`,
# `cdk synth`, etc.).
#
# Inputs:
#   $1 -- mode: "npm", "pip", "pnpm", or "yarn"
#
# Behavior:
#   - Discovers every relevant manifest via `git ls-files` (tracked
#     files only), excluding generated/vendored trees. Each Node package
#     manager is keyed off its OWN lockfile (npm -> package-lock.json,
#     pnpm -> pnpm-lock.yaml, yarn -> yarn.lock) so a repo on pnpm/yarn
#     is gated by the right tool instead of silently passing an
#     npm-only check.
#   - npm: runs `npm ci --ignore-scripts` (replays the lockfile and
#     fails on any package.json/package-lock.json drift; --ignore-scripts
#     blocks install lifecycle scripts, which the integrity check never
#     needs and which are an arbitrary-code-execution vector in CI).
#   - pnpm: runs `pnpm install --frozen-lockfile --ignore-scripts`
#     (Corepack-aware -- honors a `packageManager` pin in package.json;
#     --frozen-lockfile fails on any package.json/pnpm-lock.yaml drift).
#   - yarn: replays yarn.lock and fails on any package.json/yarn.lock
#     drift, blocking install/build lifecycle scripts to the same ACE
#     standard as npm/pnpm (Corepack-aware). The flag surface is version-
#     aware: yarn v1 -> `--frozen-lockfile --ignore-scripts`; yarn Berry
#     (v2+) -> `--immutable --mode=skip-build`.
#   - pip: runs a resolver-only pre-flight over each requirements*.txt,
#     and over each pyproject.toml that DECLARES dependencies
#     (validate-when-present -- a deps-less, config-only pyproject is
#     skipped, not installed).
#   - Runs the strict install for EVERY discovered manifest, even if
#     an earlier one fails (run-all-then-fail, not fail-fast).
#   - Prints a clear summary of which manifests broke.
#   - No manifests found => SUCCESS (exit 0).
#
# Exit codes:
#   0 -- all discovered manifests installed cleanly (or none found)
#   1 -- at least one manifest failed its strict install
#   2 -- usage error
#
# bash 3.2 compatible (no `mapfile`) so the script and its self-test
# run on macOS too.
#
# Used by .github/workflows/dependency-install-gate.yml.

set -uo pipefail

MODE="${1:-}"

case "$MODE" in
  npm|pip|pnpm|yarn) ;;
  *)
    echo "usage: $0 <npm|pip|pnpm|yarn>" >&2
    exit 2
    ;;
esac

# Discover tracked manifests, excluding generated/vendored trees.
# `git ls-files` lists only tracked files, so gitignored generated
# manifests (cdk.out/, .build/, node_modules/) never appear; the
# greps below are belt-and-suspenders in case any such path is ever
# force-added.
discover() {
  case "$MODE" in
    npm)
      git ls-files '*package-lock.json' \
        | grep -vE '(^|/)(node_modules|cdk\.out|\.build)/' || true
      ;;
    pnpm)
      git ls-files '*pnpm-lock.yaml' \
        | grep -vE '(^|/)(node_modules|cdk\.out|\.build)/' || true
      ;;
    yarn)
      git ls-files '*yarn.lock' \
        | grep -vE '(^|/)(node_modules|cdk\.out|\.build)/' || true
      ;;
    *)
      # pip: requirements*.txt plus pyproject.toml (the latter is
      # validate-when-present: a deps-less, config-only pyproject is
      # filtered out by declares_deps() below, not installed here).
      git ls-files '*requirements*.txt' '*pyproject.toml' \
        | grep -vE '(^|/)(node_modules|cdk\.out|\.build)/' || true
      ;;
  esac
}

# A pyproject.toml is install-relevant only if it actually DECLARES
# dependencies: a non-empty [project].dependencies, any
# [project.optional-dependencies], or a [tool.poetry.dependencies]
# table. A config/pytest-only pyproject (a [project] table with no
# deps and no [build-system]) must be SKIPPED -- it would error a
# naive `pip install .` and is not a dependency manifest. Parsed with
# tomllib (stdlib in the gate's Python 3.11) rather than fragile grep.
declares_deps() {
  local pyproject="$1"
  python3 - "$pyproject" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as f:
    data = tomllib.load(f)
project = data.get("project", {})
poetry = data.get("tool", {}).get("poetry", {})
has_deps = (
    bool(project.get("dependencies"))
    or bool(project.get("optional-dependencies"))
    or bool(poetry.get("dependencies"))
)
sys.exit(0 if has_deps else 1)
PY
}

# Strict, lockfile-honoring install for one manifest. No build steps.
install_one() {
  local manifest="$1"
  if [ "$MODE" = "npm" ]; then
    # npm ci replays package-lock.json exactly and fails on any drift
    # between package.json and package-lock.json. --ignore-scripts blocks
    # install lifecycle scripts (preinstall/install/postinstall): the
    # integrity check never needs them, and they are an arbitrary-code-
    # execution vector in CI from a malicious/compromised lockfile entry.
    # The "out of sync" / "Missing X from lock file" check runs before
    # any script would, so drift detection is fully preserved.
    local dir
    dir="$(dirname "$manifest")"
    ( cd "$dir" && npm ci --ignore-scripts )
  elif [ "$MODE" = "pnpm" ]; then
    # pnpm install --frozen-lockfile replays pnpm-lock.yaml exactly and
    # fails on any drift between package.json and pnpm-lock.yaml.
    # --ignore-scripts blocks lifecycle scripts (same ACE rationale as
    # npm above). Corepack provisions the pnpm version pinned by the
    # project's `packageManager` field, so the gate runs the same pnpm
    # the project does.
    local dir
    dir="$(dirname "$manifest")"
    ( cd "$dir" \
      && { corepack enable >/dev/null 2>&1 || true; } \
      && pnpm install --frozen-lockfile --ignore-scripts )
  elif [ "$MODE" = "yarn" ]; then
    # Replay yarn.lock exactly (drift check) AND block install/build
    # lifecycle scripts -- the same ACE rationale as npm/pnpm above: the
    # integrity check never needs scripts to run, and a malicious/
    # compromised lockfile entry can otherwise execute arbitrary code in
    # CI. Yarn's flag surface differs by major version, so detect it and
    # pick the right invocation (Corepack provisions the yarn version
    # pinned by `packageManager`, so the detected version is the version
    # the project actually uses):
    #   - v1 (classic): `--frozen-lockfile --ignore-scripts`. v1 DOES
    #     support `--ignore-scripts`, which suppresses every lifecycle
    #     script (preinstall/install/postinstall/prepare) on the project
    #     and its dependencies.
    #   - Berry (v2+): dropped `--frozen-lockfile` (use `--immutable`,
    #     which fails on any yarn.lock drift) and dropped
    #     `--ignore-scripts`; `--mode=skip-build` skips the build step so
    #     no dependency build/postinstall script runs.
    # Either way the lockfile-drift check runs to completion, so drift
    # detection is fully preserved.
    local dir
    dir="$(dirname "$manifest")"
    # FAILS CLOSED: if yarn cannot be provisioned (Corepack absent or
    # unbundled, shim dir not writable, no registry egress to download the
    # pinned `packageManager` yarn, an unresolvable `packageManager` pin, or a
    # yarn.lock present with no pin and no yarn on the runner), `yarn --version`
    # fails, $yarn_major is empty, the && chain short-circuits, and this gate
    # job goes RED. That is the correct direction for an integrity gate: a red
    # check the operator investigates beats a silent green that gives false
    # assurance the lockfile was actually verified.
    ( cd "$dir" \
      && { corepack enable >/dev/null 2>&1 || true; } \
      && yarn_major="$(yarn --version 2>/dev/null | cut -d. -f1)" \
      && if [ "$yarn_major" = "1" ]; then
           yarn install --frozen-lockfile --ignore-scripts
         else
           yarn install --immutable --mode=skip-build
         fi )
  elif [ "${manifest##*/}" = "pyproject.toml" ]; then
    # Validate-when-present: only deps-declaring pyprojects reach here
    # (filtered in the discovery loop). Resolver-only pre-flight on the
    # project's own declared deps, host-Python independent, no wheel
    # build -- consistent with the requirements*.txt path below.
    local dir
    dir="$(dirname "$manifest")"
    ( cd "$dir" && pip install --dry-run --ignore-installed . )
  else
    # Resolver-only pre-flight: host-Python independent, does NOT build
    # wheels, catches mutually-incompatible pins. --ignore-installed so
    # already-present host packages don't mask a manifest that under-
    # specifies its deps.
    pip install --dry-run --ignore-installed -r "$manifest"
  fi
}

# Read discovered manifests into an array. Avoid `mapfile` (bash 4+)
# so the script and its self-test also run under macOS bash 3.2.
# A pyproject.toml that declares no dependencies is dropped here so it
# never enters the run loop and never affects no-manifests-green.
MANIFESTS=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if [ "${line##*/}" = "pyproject.toml" ] && ! declares_deps "$line"; then
    echo "Skipping $line (declares no dependencies)."
    continue
  fi
  MANIFESTS+=("$line")
done < <(discover)

if [ "${#MANIFESTS[@]}" -eq 0 ]; then
  echo "No $MODE manifests discovered. Nothing to gate -- success."
  exit 0
fi

echo "Discovered ${#MANIFESTS[@]} $MODE manifest(s):"
printf '  %s\n' "${MANIFESTS[@]}"
echo

failures=()
for manifest in "${MANIFESTS[@]}"; do
  echo "::group::$MODE strict install: $manifest"
  if install_one "$manifest"; then
    echo "OK: $manifest"
  else
    echo "::error file=$manifest::Strict $MODE install failed for $manifest"
    failures+=("$manifest")
  fi
  echo "::endgroup::"
done

echo
if [ "${#failures[@]}" -eq 0 ]; then
  echo "All ${#MANIFESTS[@]} $MODE manifest(s) installed cleanly."
  exit 0
fi

echo "FAILED: ${#failures[@]} of ${#MANIFESTS[@]} $MODE manifest(s) broke:"
printf '  %s\n' "${failures[@]}"
exit 1
