#!/usr/bin/env bash
#
# test-codeql-language-present.sh
#
# Self-test for .github/scripts/codeql-language-present.sh. Builds
# throwaway per-language fixtures under temp git repos and asserts:
#
#   - A single-language query (`<language>` mode) is `present`/exit 0 for
#     a repo carrying that language's source, and `absent`/exit 1 for a
#     repo without it.
#   - `actions` is ALWAYS present (the floor) even in an empty repo.
#   - `--matrix` emits a valid JSON array of {language,runner} entries
#     for exactly the present languages. `actions` is the always-present
#     floor, so the minimal matrix carries the actions entry (never an
#     empty string).
#   - `swift` carries runner=macos-latest and every other language
#     carries runner=ubuntu-latest.
#   - A Swift-less repo's matrix contains NO swift entry (so the workflow
#     never provisions macOS).
#   - `--matrix` on an empty repo still contains the actions floor and is
#     valid JSON.
#   - An unknown language is a usage error (exit 2).
#
# The script discovers source via `git ls-files`, so each fixture lives
# in its own throwaway git repo with the relevant files committed.
#
# Exit codes:
#   0 -- all cases pass
#   1 -- any case fails
#
# bash 3.2 compatible (runs on macOS).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT="$SCRIPT_DIR/codeql-language-present.sh"

if [ ! -f "$DETECT" ]; then
  echo "FAIL: detect script not found at $DETECT" >&2
  exit 1
fi

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t codeql-language-present)
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

commit_all() {
  local dir="$1"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "fixture"
}

writef() {
  # writef <path> -- read content from stdin.
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

# run_case <name> <expected_exit> <repo-dir> <arg...>
run_case() {
  local name="$1" expected="$2" repo="$3"
  shift 3
  local out actual
  out=$(cd "$repo" && bash "$DETECT" "$@" 2>&1)
  actual=$?
  if [ "$actual" = "$expected" ]; then
    pass=$((pass + 1))
    echo "PASS [$name] (exit $actual)"
  else
    fail=$((fail + 1))
    echo "FAIL [$name] expected exit $expected, got $actual"
    echo "----- detect output -----"
    echo "$out"
    echo "-------------------------"
  fi
}

# assert_matrix_contains <name> <repo-dir> <needle>
assert_matrix_contains() {
  local name="$1" repo="$2" needle="$3"
  local out
  out=$(cd "$repo" && bash "$DETECT" --matrix 2>&1)
  case "$out" in
    *"$needle"*)
      pass=$((pass + 1))
      echo "PASS [$name] (matrix contains $needle)"
      ;;
    *)
      fail=$((fail + 1))
      echo "FAIL [$name] matrix missing $needle"
      echo "----- matrix -----"
      echo "$out"
      echo "------------------"
      ;;
  esac
}

# assert_matrix_absent <name> <repo-dir> <needle>
assert_matrix_absent() {
  local name="$1" repo="$2" needle="$3"
  local out
  out=$(cd "$repo" && bash "$DETECT" --matrix 2>&1)
  case "$out" in
    *"$needle"*)
      fail=$((fail + 1))
      echo "FAIL [$name] matrix unexpectedly contains $needle"
      echo "----- matrix -----"
      echo "$out"
      echo "------------------"
      ;;
    *)
      pass=$((pass + 1))
      echo "PASS [$name] (matrix omits $needle)"
      ;;
  esac
}

# assert_valid_json_array <name> <repo-dir>
assert_valid_json_array() {
  local name="$1" repo="$2"
  local out
  out=$(cd "$repo" && bash "$DETECT" --matrix 2>&1)
  # Must be a single line beginning with '[' and ending with ']'.
  case "$out" in
    \[*\])
      # Optional stronger check when python3 is available.
      if command -v python3 >/dev/null 2>&1; then
        if printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
          pass=$((pass + 1)); echo "PASS [$name] (valid JSON array)"
        else
          fail=$((fail + 1)); echo "FAIL [$name] not parseable JSON: $out"
        fi
      else
        pass=$((pass + 1)); echo "PASS [$name] (bracketed array)"
      fi
      ;;
    *)
      fail=$((fail + 1)); echo "FAIL [$name] not a JSON array: $out"
      ;;
  esac
}

# =====================================================================
# python
# =====================================================================
R="$TMP/py"; git_init_repo "$R"
writef "$R/app.py" <<'PY'
print("hi")
PY
commit_all "$R"
run_case "python present -> present/exit 0" 0 "$R" python
run_case "go absent in python repo -> absent/exit 1" 1 "$R" go
assert_matrix_contains "python matrix has python ubuntu" "$R" '"language":"python","runner":"ubuntu-latest"'
assert_matrix_contains "python matrix has actions floor" "$R" '"language":"actions"'
assert_matrix_absent "python matrix omits swift" "$R" 'swift'
assert_valid_json_array "python matrix is valid JSON" "$R"

# =====================================================================
# javascript-typescript
# =====================================================================
R="$TMP/ts"; git_init_repo "$R"
writef "$R/src/index.ts" <<'TS'
export const x = 1;
TS
commit_all "$R"
run_case "js-ts present via .ts -> exit 0" 0 "$R" javascript-typescript

# =====================================================================
# swift -> macos-latest
# =====================================================================
R="$TMP/swift"; git_init_repo "$R"
writef "$R/Sources/main.swift" <<'SW'
print("hi")
SW
commit_all "$R"
run_case "swift present -> exit 0" 0 "$R" swift
assert_matrix_contains "swift matrix carries macos-latest" "$R" '"language":"swift","runner":"macos-latest"'

# =====================================================================
# ruby (source + Gemfile)
# =====================================================================
R="$TMP/ruby"; git_init_repo "$R"
writef "$R/Gemfile" <<'RB'
source "https://rubygems.org"
RB
commit_all "$R"
run_case "ruby present via Gemfile -> exit 0" 0 "$R" ruby

# =====================================================================
# rust (Cargo.toml)
# =====================================================================
R="$TMP/rust"; git_init_repo "$R"
writef "$R/Cargo.toml" <<'RS'
[package]
name = "x"
RS
commit_all "$R"
run_case "rust present via Cargo.toml -> exit 0" 0 "$R" rust

# =====================================================================
# empty repo: only the actions floor
# =====================================================================
R="$TMP/empty"; git_init_repo "$R"
writef "$R/README.md" <<'MD'
# empty
MD
commit_all "$R"
run_case "actions floor present in empty repo -> exit 0" 0 "$R" actions
run_case "python absent in empty repo -> exit 1" 1 "$R" python
assert_matrix_contains "empty repo matrix has actions floor" "$R" '"language":"actions","runner":"ubuntu-latest"'
assert_valid_json_array "empty repo matrix is valid JSON" "$R"

# =====================================================================
# usage errors
# =====================================================================
R="$TMP/usage"; git_init_repo "$R"; writef "$R/README.md" <<'MD'
x
MD
commit_all "$R"
run_case "unknown language -> usage error (exit 2)" 2 "$R" cobol

# =====================================================================
echo
echo "codeql-language-present self-test: $pass passed, $fail failed."
[ "$fail" -eq 0 ]
