#!/usr/bin/env bash
#
# test-check-pin-shape.sh
#
# Self-test for scripts/check-pin-shape.sh. Builds throwaway *.yml
# fixtures under a temp directory and asserts the gate's verdicts:
#
#   - A uses: pinned to a tag (e.g. @v4)        -> exit 1 (red).
#   - A uses: with no @ref at all               -> exit 1 (red).
#   - A uses: correctly SHA-pinned (40-hex)      -> exit 0 (green).
#   - A well-formed-but-OLD SHA pin              -> exit 0 (green),
#     proving staleness is never a blocking condition for this gate.
#   - A commented-out example `uses:` line is never treated as a real
#     pin (mirrors assets/codeartifact-auth-action.yml's doc comment).
#   - A local `uses: ./...` ref is exempt (not version-pinned).
#   - No *.yml files in the target directory -> exit 0 (nothing to
#     check).
#   - A non-workflow/non-action-shaped file (no top-level on:/runs:)
#     carrying a `uses:`-shaped key that is NOT a GitHub Actions
#     reference (mirrors assets/codeql-config.yml's
#     `queries: - uses: security-extended`) is skipped, not flagged.
#   - A workflow written with the quoted `"on":` spelling is still
#     recognized as workflow-shaped and scanned (not silently skipped).
#
# Exit codes:
#   0 -- all cases pass
#   1 -- any case fails
#
# bash 3.2 compatible (runs on macOS).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/check-pin-shape.sh"

if [ ! -f "$GATE" ]; then
  echo "FAIL: gate script not found at $GATE" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

failures=0

assert_exit() {
  local desc="$1"
  local expected="$2"
  local dir="$3"
  local actual
  local out_file="$TMP_ROOT/out.$$"

  bash "$GATE" "$dir" >"$out_file" 2>&1
  actual=$?
  if [ "$actual" -ne "$expected" ]; then
    echo "FAIL: ${desc} -- expected exit ${expected}, got ${actual}"
    cat "$out_file"
    failures=$((failures + 1))
  else
    echo "PASS: ${desc}"
  fi
  rm -f "$out_file"
}

# Case 1: floating tag -> RED. `on:` makes this workflow-shaped so it
# is actually scanned.
CASE1="$TMP_ROOT/case1"
mkdir -p "$CASE1"
cat > "$CASE1/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: actions/checkout@v4
YAML
assert_exit "floating tag @v4 is a violation" 1 "$CASE1"

# Case 2: no @ref at all -> RED.
CASE2="$TMP_ROOT/case2"
mkdir -p "$CASE2"
cat > "$CASE2/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: actions/checkout
YAML
assert_exit "bare uses: with no @ref is a violation" 1 "$CASE2"

# Case 3: correctly SHA-pinned -> GREEN.
CASE3="$TMP_ROOT/case3"
mkdir -p "$CASE3"
cat > "$CASE3/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
YAML
assert_exit "exact 40-hex SHA pin is well-formed" 0 "$CASE3"

# Case 4: well-formed but OLD SHA pin -> still GREEN (staleness is not
# this gate's concern).
CASE4="$TMP_ROOT/case4"
mkdir -p "$CASE4"
cat > "$CASE4/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  # Deliberately ancient version comment -- shape is still exact.
  - uses: actions/checkout@1e31de5234b9f8995739874a8ce0492dc87873e2 # v1.0.0
YAML
assert_exit "old-but-well-formed SHA pin passes (staleness is not blocking)" 0 "$CASE4"

# Case 5: commented-out example uses: line is never treated as a real
# pin (mirrors assets/codeartifact-auth-action.yml).
CASE5="$TMP_ROOT/case5"
mkdir -p "$CASE5"
cat > "$CASE5/workflow.yml" <<'YAML'
on:
  pull_request:
# Example usage:
#   steps:
#     - uses: actions/checkout@<sha>
#     - uses: ./.github/actions/codeartifact-auth
steps:
  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
YAML
assert_exit "commented-out example uses: lines are ignored" 0 "$CASE5"

# Case 6: local ./ ref is exempt.
CASE6="$TMP_ROOT/case6"
mkdir -p "$CASE6"
cat > "$CASE6/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: ./.github/actions/codeartifact-auth
YAML
assert_exit "local ./ ref is exempt from pinning" 0 "$CASE6"

# Case 7: no *.yml files at all -> GREEN (nothing to check).
CASE7="$TMP_ROOT/case7"
mkdir -p "$CASE7"
assert_exit "empty directory has nothing to check" 0 "$CASE7"

# Case 8: a non-workflow/non-action-shaped file (no top-level on:/runs:)
# carrying a `uses:`-shaped key that is NOT an action pin (mirrors
# assets/codeql-config.yml) is skipped, never flagged, even though its
# `uses: security-extended` would otherwise look like a bare
# no-@ref violation.
CASE8="$TMP_ROOT/case8"
mkdir -p "$CASE8"
cat > "$CASE8/codeql-config.yml" <<'YAML'
name: "Default CodeQL config"
queries:
  - uses: security-extended
YAML
assert_exit "non-workflow/action-shaped file with a uses:-like key is skipped" 0 "$CASE8"

# Case 8b: a composite-action-shaped file (top-level runs:, no on:) IS
# scanned, and a violation inside it is still caught.
CASE8B="$TMP_ROOT/case8b"
mkdir -p "$CASE8B"
cat > "$CASE8B/action.yml" <<'YAML'
name: some-composite-action
runs:
  using: composite
  steps:
    - uses: aws-actions/configure-aws-credentials@v6
YAML
assert_exit "composite-action-shaped file (runs:, no on:) is scanned" 1 "$CASE8B"

# Case 9: a workflow written with the quoted `"on":` spelling (a common
# way to sidestep YAML 1.1's `on` -> `true` boolean coercion) is still
# recognized as workflow-shaped and scanned -- not silently SKIPped,
# which would leave a violation inside it entirely unchecked.
CASE9="$TMP_ROOT/case9"
mkdir -p "$CASE9"
cat > "$CASE9/workflow.yml" <<'YAML'
"on":
  pull_request:
steps:
  - uses: actions/checkout@v4
YAML
assert_exit "quoted \"on\": spelling is still recognized as workflow-shaped and scanned" 1 "$CASE9"

if [ "$failures" -ne 0 ]; then
  echo "test-check-pin-shape: ${failures} case(s) failed." >&2
  exit 1
fi

echo "test-check-pin-shape: all cases passed."
