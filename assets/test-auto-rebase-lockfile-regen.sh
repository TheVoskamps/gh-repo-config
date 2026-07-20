#!/usr/bin/env bash
#
# test-auto-rebase-lockfile-regen.sh
#
# Rendered by /gh-repo-setup-pr-automation into the target repo at
# .github/scripts/test-auto-rebase-lockfile-regen.sh. It has NO
# placeholders; it ships verbatim.
#
# Self-test for .github/scripts/auto-rebase-lockfile-regen.sh. Builds
# throwaway git repos under a temp dir and a FAKE `npm` (so no registry,
# no network) that simulates the three states the regen script must
# distinguish:
#   - in-sync:    `npm ci` exits 0.
#   - fixable desync: `npm ci` exits non-zero with the lockfile-out-of-
#     sync signature, and `npm install --package-lock-only` makes a
#     subsequent `npm ci` pass.
#   - unfixable:  `npm ci` fails with the desync signature, but even
#     after a regen `npm ci` still fails (an unsatisfiable manifest);
#     OR `npm ci` fails for a reason that is NOT the desync signature.
#
# The fake `npm` keys its behavior off a sentinel string in the
# package-lock.json so each case is deterministic. The regen step writes
# a "fixed" sentinel into the lockfile so the post-regen `npm ci`
# observes the repaired state.
#
# Cases:
#   (a) lockfile already in sync          -> exit 3 (nothing to do)
#   (b) fixable lockfile-only desync       -> exit 0, lockfile rewritten
#   (c) desync that regen cannot fix       -> exit 1 (unfixable)
#   (d) gate-red but NOT a desync signature-> exit 1 (unfixable)
#   (e) no lockfiles at all                -> exit 3 (nothing to do)
#   (f) two manifests: one fixable, one    -> exit 1 (any unfixable =>
#       unfixable                              leave PR for human)
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

# Write a fake `npm` into $1/bin and echo that bin dir. The fake reads
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

run_case() {
  local name="$1" expected_exit="$2" repo="$3" npm_bin="$4"
  local out actual
  set +e
  out=$( cd "$repo" && NPM_BIN="$npm_bin" bash "$REGEN" 2>&1 )
  actual=$?
  set -e
  if [ "$actual" = "$expected_exit" ]; then
    pass=$((pass + 1))
    echo "PASS [$name] (exit $actual)"
  else
    fail=$((fail + 1))
    echo "FAIL [$name] expected exit $expected_exit, got $actual"
    echo "----- regen output -----"
    echo "$out"
    echo "------------------------"
  fi
}

NPM_BIN_PATH=$(make_fake_npm "$TMP/fake")

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
# Summary
# ---------------------------------------------------------------
echo ""
echo "Results: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
