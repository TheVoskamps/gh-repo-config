#!/usr/bin/env bash
#
# test-auto-rebase-lockfile-regen.sh
#
# Rendered by /gh-repo-setup-pr-automation into the target repo at
# .github/scripts/test-auto-rebase-lockfile-regen.sh. It has NO
# placeholders; it ships verbatim.
#
# Self-test for .github/scripts/auto-rebase-lockfile-regen.sh. Builds
# throwaway git repos under a temp dir and FAKE `npm`, `pnpm`, and
# `corepack` binaries (so no registry, no network) that simulate the
# states the regen script must distinguish:
#   - in-sync:    the replay (`npm ci` / `pnpm install --frozen-lockfile`)
#     exits 0.
#   - fixable desync: the replay exits non-zero with the lockfile-out-of-
#     sync signature, and the regen (`npm install --package-lock-only` /
#     `pnpm install --lockfile-only`) makes a subsequent replay pass.
#   - unfixable:  the replay fails with the desync signature, but even
#     after a regen it still fails (an unsatisfiable manifest); OR the
#     replay fails for a reason that is NOT the desync signature; OR
#     `corepack enable` fails before a pnpm replay; OR one directory
#     tracks both package-lock.json and pnpm-lock.yaml.
#
# Each fake keys its behavior off a sentinel string in its lockfile so
# each case is deterministic. The regen step writes a "fixed" sentinel
# into the lockfile so the post-regen replay observes the repaired
# state. The fake `pnpm` and `corepack` append each call to a log, so a
# case can assert which commands ran.
#
# Cases:
#   (a) lockfile already in sync          -> exit 3 (nothing to do)
#   (b) fixable lockfile-only desync       -> exit 0, lockfile rewritten
#   (c) desync that regen cannot fix       -> exit 1 (unfixable)
#   (d) gate-red but NOT a desync signature-> exit 1 (unfixable)
#   (e) no lockfiles at all                -> exit 3 (nothing to do)
#   (f) two manifests: one fixable, one    -> exit 1 (any unfixable =>
#       unfixable                              leave PR for human)
#   (g) pnpm lockfile already in sync      -> exit 3
#   (h) fixable pnpm desync                -> exit 0, lockfile rewritten
#   (i) pnpm replay fails WITHOUT          -> exit 1
#       ERR_PNPM_OUTDATED_LOCKFILE
#   (j) pnpm desync that regen cannot fix  -> exit 1
#   (k) fixable npm + unfixable pnpm       -> exit 1
#   (l) one directory tracking both        -> exit 1, neither rewritten
#       package-lock.json and pnpm-lock.yaml
#   (m) `corepack enable` fails            -> exit 1, corepack's output
#                                              shown, no pnpm command run
#
# Exit codes:
#   0 -- all cases pass
#   1 -- any case fails

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGEN="$SCRIPT_DIR/auto-rebase-lockfile-regen.sh"

if [ ! -f "$REGEN" ]; then
  echo "FAIL: regen script not found at $REGEN" >&2
  exit 1
fi

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t auto-rebase-lockfile-regen)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

git_init_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test User"
  git -C "$dir" config commit.gpgsign false
}

# Create and track a manifest dir with a package.json and a
# package-lock.json carrying a sentinel that the fake npm reads.
make_manifest() {
  local repo="$1" subdir="$2" sentinel="$3"
  local dir="$repo/$subdir"
  mkdir -p "$dir"
  printf '{ "name": "x", "version": "1.0.0" }\n' > "$dir/package.json"
  printf '{ "lockfileVersion": 3, "sentinel": "%s" }\n' "$sentinel" \
    > "$dir/package-lock.json"
  git -C "$repo" add "$subdir/package.json" "$subdir/package-lock.json"
  git -C "$repo" commit -q -m "add $subdir manifest"
}

# Write a fake `npm` into $1/bin and echo its path. The fake reads
# the sentinel in ./package-lock.json:
#   sentinel=insync      -> `npm ci` succeeds.
#   sentinel=desync      -> `npm ci` fails with the out-of-sync signature;
#                           `npm install --package-lock-only` rewrites the
#                           sentinel to `fixed` so the next `npm ci` passes.
#   sentinel=fixed       -> `npm ci` succeeds.
#   sentinel=hard-desync -> `npm ci` fails with the signature; regen
#                           rewrites to `still-broken`.
#   sentinel=still-broken-> `npm ci` fails with the signature (regen did
#                           not help -> unfixable).
#   sentinel=other-error -> `npm ci` fails WITHOUT the signature (a
#                           non-desync failure -> unfixable).
make_fake_npm() {
  local root="$1"
  local bindir="$root/bin"
  mkdir -p "$bindir"
  cat > "$bindir/npm" <<'FAKE'
#!/usr/bin/env bash
set -u
sentinel=""
if [ -f package-lock.json ]; then
  sentinel="$(sed -n 's/.*"sentinel": "\([^"]*\)".*/\1/p' package-lock.json)"
fi

# `npm ci --ignore-scripts`
if [ "${1:-}" = "ci" ]; then
  case "$sentinel" in
    insync|fixed)
      echo "added 1 package, and audited 2 packages"
      exit 0
      ;;
    other-error)
      echo "npm error code ENOTFOUND" >&2
      echo "npm error network request failed" >&2
      exit 1
      ;;
    *)
      # desync / hard-desync / still-broken: out-of-sync signature.
      echo "npm error code EUSAGE" >&2
      echo "npm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync." >&2
      echo "npm error Missing: left-pad@1.3.0 from lock file" >&2
      exit 1
      ;;
  esac
fi

# `npm install --package-lock-only --ignore-scripts`
if [ "${1:-}" = "install" ]; then
  case "$sentinel" in
    desync)
      printf '{ "lockfileVersion": 3, "sentinel": "fixed" }\n' > package-lock.json
      ;;
    hard-desync)
      printf '{ "lockfileVersion": 3, "sentinel": "still-broken" }\n' > package-lock.json
      ;;
    *)
      : # leave the lockfile as-is
      ;;
  esac
  echo "up to date, audited 2 packages"
  exit 0
fi

echo "fake npm: unhandled args: $*" >&2
exit 99
FAKE
  chmod +x "$bindir/npm"
  echo "$bindir/npm"
}

# Create and track a manifest dir with a package.json and a
# pnpm-lock.yaml carrying a sentinel that the fake pnpm reads.
make_pnpm_manifest() {
  local repo="$1" subdir="$2" sentinel="$3"
  local dir="$repo/$subdir"
  mkdir -p "$dir"
  printf '{ "name": "x", "version": "1.0.0" }\n' > "$dir/package.json"
  printf "lockfileVersion: '9.0'\nsentinel: %s\n" "$sentinel" \
    > "$dir/pnpm-lock.yaml"
  git -C "$repo" add "$subdir/package.json" "$subdir/pnpm-lock.yaml"
  git -C "$repo" commit -q -m "add $subdir pnpm manifest"
}

# Write a fake `pnpm` into $1/bin and echo its path. The fake appends
# `<cwd> pnpm <args>` to $FAKE_CALL_LOG and reads the sentinel in
# ./pnpm-lock.yaml with the same meanings as the fake npm's, where the
# out-of-sync signature is the ERR_PNPM_OUTDATED_LOCKFILE code.
make_fake_pnpm() {
  local root="$1"
  local bindir="$root/bin"
  mkdir -p "$bindir"
  cat > "$bindir/pnpm" <<'FAKE'
#!/usr/bin/env bash
set -u
echo "$PWD pnpm $*" >> "$FAKE_CALL_LOG"
sentinel=""
if [ -f pnpm-lock.yaml ]; then
  sentinel="$(sed -n 's/^sentinel: *//p' pnpm-lock.yaml)"
fi

# `pnpm install --frozen-lockfile --ignore-scripts`
if [ "${1:-}" = "install" ] && [ "${2:-}" = "--frozen-lockfile" ]; then
  case "$sentinel" in
    insync|fixed)
      echo "Lockfile is up to date, resolution step is skipped"
      exit 0
      ;;
    other-error)
      echo " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/left-pad: Not Found - 404" >&2
      exit 1
      ;;
    *)
      echo " ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with package.json" >&2
      exit 1
      ;;
  esac
fi

# `pnpm install --lockfile-only --ignore-scripts`
if [ "${1:-}" = "install" ] && [ "${2:-}" = "--lockfile-only" ]; then
  case "$sentinel" in
    desync)
      printf "lockfileVersion: '9.0'\nsentinel: fixed\n" > pnpm-lock.yaml
      ;;
    hard-desync)
      printf "lockfileVersion: '9.0'\nsentinel: still-broken\n" > pnpm-lock.yaml
      ;;
    *)
      : # leave the lockfile as-is
      ;;
  esac
  echo "Done"
  exit 0
fi

echo "fake pnpm: unhandled args: $*" >&2
exit 99
FAKE
  chmod +x "$bindir/pnpm"
  echo "$bindir/pnpm"
}

# Write a fake `corepack` into $1/bin and echo its path. It appends
# `<cwd> corepack <args>` to $FAKE_CALL_LOG, and `corepack enable` fails
# with a recognizable message when ./pnpm-lock.yaml carries the
# `corepack-fail` sentinel.
make_fake_corepack() {
  local root="$1"
  local bindir="$root/bin"
  mkdir -p "$bindir"
  cat > "$bindir/corepack" <<'FAKE'
#!/usr/bin/env bash
set -u
echo "$PWD corepack $*" >> "$FAKE_CALL_LOG"
if [ -f pnpm-lock.yaml ] && grep -q '^sentinel: corepack-fail$' pnpm-lock.yaml; then
  echo "Internal Error: EACCES: fake corepack could not write its shims" >&2
  exit 1
fi
exit 0
FAKE
  chmod +x "$bindir/corepack"
  echo "$bindir/corepack"
}

# Output of the most recent run_case, for cases that assert on it.
LAST_OUT=""

run_case() {
  local name="$1" expected_exit="$2" repo="$3" npm_bin="$4"
  local actual
  : > "$FAKE_CALL_LOG"
  set +e
  LAST_OUT=$( cd "$repo" && NPM_BIN="$npm_bin" PNPM_BIN="$PNPM_BIN_PATH" \
    COREPACK_BIN="$COREPACK_BIN_PATH" bash "$REGEN" 2>&1 )
  actual=$?
  set -e
  if [ "$actual" = "$expected_exit" ]; then
    pass=$((pass + 1))
    echo "PASS [$name] (exit $actual)"
  else
    fail=$((fail + 1))
    echo "FAIL [$name] expected exit $expected_exit, got $actual"
    echo "----- regen output -----"
    echo "$LAST_OUT"
    echo "------------------------"
  fi
}

# check <name> <command…>: count a PASS when the command succeeds.
check() {
  local name="$1"
  shift
  if "$@"; then
    pass=$((pass + 1)); echo "PASS [$name]"
  else
    fail=$((fail + 1)); echo "FAIL [$name]"
    echo "----- regen output -----"
    echo "$LAST_OUT"
    echo "------------------------"
  fi
}

# check_lacks <name> <pattern> <file>: count a PASS when no line of <file>
# matches <pattern>.
check_lacks() {
  local name="$1" pattern="$2" file="$3"
  if grep -q -- "$pattern" "$file"; then
    check "$name" false
  else
    check "$name" true
  fi
}

FAKE_CALL_LOG="$TMP/fake-calls.log"
export FAKE_CALL_LOG
NPM_BIN_PATH=$(make_fake_npm "$TMP/fake")
PNPM_BIN_PATH=$(make_fake_pnpm "$TMP/fake")
COREPACK_BIN_PATH=$(make_fake_corepack "$TMP/fake")

# ---------------------------------------------------------------
# Case (a): lockfile already in sync -> exit 3
# ---------------------------------------------------------------
REPO_A="$TMP/case-a"
git_init_repo "$REPO_A"
make_manifest "$REPO_A" "apps/frontend" "insync"
run_case "a: already in sync" 3 "$REPO_A" "$NPM_BIN_PATH"

# ---------------------------------------------------------------
# Case (b): fixable lockfile-only desync -> exit 0, lockfile rewritten
# ---------------------------------------------------------------
REPO_B="$TMP/case-b"
git_init_repo "$REPO_B"
make_manifest "$REPO_B" "apps/frontend" "desync"
run_case "b: fixable desync" 0 "$REPO_B" "$NPM_BIN_PATH"
if grep -q '"sentinel": "fixed"' "$REPO_B/apps/frontend/package-lock.json"; then
  pass=$((pass + 1)); echo "PASS [b: lockfile actually rewritten]"
else
  fail=$((fail + 1)); echo "FAIL [b: lockfile not rewritten to fixed state]"
fi

# ---------------------------------------------------------------
# Case (c): desync that regen cannot fix -> exit 1 (unfixable)
# ---------------------------------------------------------------
REPO_C="$TMP/case-c"
git_init_repo "$REPO_C"
make_manifest "$REPO_C" "apps/frontend" "hard-desync"
run_case "c: regen cannot fix" 1 "$REPO_C" "$NPM_BIN_PATH"

# ---------------------------------------------------------------
# Case (d): gate-red but NOT a desync signature -> exit 1 (unfixable)
# ---------------------------------------------------------------
REPO_D="$TMP/case-d"
git_init_repo "$REPO_D"
make_manifest "$REPO_D" "apps/frontend" "other-error"
run_case "d: non-desync gate failure" 1 "$REPO_D" "$NPM_BIN_PATH"

# ---------------------------------------------------------------
# Case (e): no lockfiles at all -> exit 3
# ---------------------------------------------------------------
REPO_E="$TMP/case-e"
git_init_repo "$REPO_E"
echo "readme" > "$REPO_E/README.md"
git -C "$REPO_E" add README.md
git -C "$REPO_E" commit -q -m "no manifests"
run_case "e: no lockfiles" 3 "$REPO_E" "$NPM_BIN_PATH"

# ---------------------------------------------------------------
# Case (f): one fixable + one unfixable -> exit 1 (any unfixable wins)
# ---------------------------------------------------------------
REPO_F="$TMP/case-f"
git_init_repo "$REPO_F"
make_manifest "$REPO_F" "apps/frontend" "desync"
make_manifest "$REPO_F" "apps/backend" "hard-desync"
run_case "f: mixed fixable + unfixable" 1 "$REPO_F" "$NPM_BIN_PATH"

# ---------------------------------------------------------------
# Case (g): pnpm lockfile already in sync -> exit 3
# ---------------------------------------------------------------
REPO_G="$TMP/case-g"
git_init_repo "$REPO_G"
make_pnpm_manifest "$REPO_G" "." "insync"
run_case "g: pnpm already in sync" 3 "$REPO_G" "$NPM_BIN_PATH"
check "g: corepack enable ran" \
  grep -q "corepack enable" "$FAKE_CALL_LOG"

# ---------------------------------------------------------------
# Case (h): fixable pnpm desync -> exit 0, lockfile rewritten
# ---------------------------------------------------------------
REPO_H="$TMP/case-h"
git_init_repo "$REPO_H"
make_pnpm_manifest "$REPO_H" "apps/web" "desync"
run_case "h: fixable pnpm desync" 0 "$REPO_H" "$NPM_BIN_PATH"
check "h: pnpm lockfile actually rewritten" \
  grep -q '^sentinel: fixed$' "$REPO_H/apps/web/pnpm-lock.yaml"

# ---------------------------------------------------------------
# Case (i): pnpm replay fails without ERR_PNPM_OUTDATED_LOCKFILE -> exit 1
# ---------------------------------------------------------------
REPO_I="$TMP/case-i"
git_init_repo "$REPO_I"
make_pnpm_manifest "$REPO_I" "apps/web" "other-error"
run_case "i: pnpm non-desync failure" 1 "$REPO_I" "$NPM_BIN_PATH"
check_lacks "i: no pnpm regen ran" '--lockfile-only' "$FAKE_CALL_LOG"

# ---------------------------------------------------------------
# Case (j): pnpm desync that regen cannot fix -> exit 1
# ---------------------------------------------------------------
REPO_J="$TMP/case-j"
git_init_repo "$REPO_J"
make_pnpm_manifest "$REPO_J" "apps/web" "hard-desync"
run_case "j: pnpm regen cannot fix" 1 "$REPO_J" "$NPM_BIN_PATH"

# ---------------------------------------------------------------
# Case (k): fixable npm + unfixable pnpm -> exit 1
# ---------------------------------------------------------------
REPO_K="$TMP/case-k"
git_init_repo "$REPO_K"
make_manifest "$REPO_K" "apps/frontend" "desync"
make_pnpm_manifest "$REPO_K" "apps/web" "hard-desync"
run_case "k: npm fixable + pnpm unfixable" 1 "$REPO_K" "$NPM_BIN_PATH"

# ---------------------------------------------------------------
# Case (l): one directory tracks both lockfiles -> exit 1, neither
# regenerated
# ---------------------------------------------------------------
REPO_L="$TMP/case-l"
git_init_repo "$REPO_L"
make_manifest "$REPO_L" "apps/frontend" "desync"
printf "lockfileVersion: '9.0'\nsentinel: desync\n" \
  > "$REPO_L/apps/frontend/pnpm-lock.yaml"
git -C "$REPO_L" add apps/frontend/pnpm-lock.yaml
git -C "$REPO_L" commit -q -m "add a pnpm lockfile beside the npm one"
run_case "l: npm and pnpm lockfile in one directory" 1 "$REPO_L" "$NPM_BIN_PATH"
check "l: npm lockfile not regenerated" \
  grep -q '"sentinel": "desync"' "$REPO_L/apps/frontend/package-lock.json"
check "l: pnpm lockfile not regenerated" \
  grep -q '^sentinel: desync$' "$REPO_L/apps/frontend/pnpm-lock.yaml"

# ---------------------------------------------------------------
# Case (m): `corepack enable` fails -> exit 1, no pnpm command run
# ---------------------------------------------------------------
REPO_M="$TMP/case-m"
git_init_repo "$REPO_M"
make_pnpm_manifest "$REPO_M" "apps/web" "corepack-fail"
run_case "m: corepack enable fails" 1 "$REPO_M" "$NPM_BIN_PATH"
check "m: corepack's own output is shown" \
  grep -q 'fake corepack could not write its shims' <<< "$LAST_OUT"
check "m: the error names the manifest" \
  grep -q 'corepack enable failed for apps/web/pnpm-lock.yaml' <<< "$LAST_OUT"
check_lacks "m: no pnpm command ran" ' pnpm ' "$FAKE_CALL_LOG"

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo "Results: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
