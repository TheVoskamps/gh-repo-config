#!/usr/bin/env bash
#
# check-pin-shape.sh
#
# REPO-OWN script (issue #60) installed at <repo-root>/scripts/, NOT
# .github/scripts/ -- .github/scripts/ is sweep-rendered payload
# territory (the converger overwrites it from assets/ on every tick), so
# a repo-own script placed there would be destroyed on the next sweep.
#
# Purely SYNTACTIC, fully OFFLINE gate over every `uses:` action
# reference in assets/*.yml -- the fanout's authoritative payload
# templates. No network calls, no upstream queries. A `uses:` value must
# be either a local ref (`./...`, not version-pinned) or a full
# 40-character-hex commit SHA. A bare `uses:` with no `@ref`, or a
# `@ref` that is a tag/branch/short-SHA, is a violation.
#
# WHY assets/*.yml AND NOT .github/workflows/*.yml: this gate protects
# the templates that fan out to every managed repo, not this repo's own
# rendered copies (which the sweep already keeps converged). See the
# "Problem" section of issue #60 for why comparing against this repo's
# own .github/workflows/ is not the right anchor.
#
# CURRENCY IS EXPLICITLY OUT OF SCOPE. This gate must never fail because
# a pin is merely OLD -- that is scripts/bump-asset-pins.sh's job, on its
# own schedule. A gate that went red on stale pins would turn red on
# unrelated PRs the moment an upstream release crossed its soak
# threshold, and would fail the bumper's own PRs (which by construction
# change pins). The two concerns stay strictly separate: this gate
# proves pins are WELL-FORMED; the bumper keeps them CURRENT.
#
# Reuses the same classification regex as
# assets/dependency-pinned-gate.sh's classify_actions() (proven not to
# false-positive on a commented-out example `uses:` line, since a `#`
# prefix never matches the leading `^\s*-?\s*` the regex requires).
#
# SCOPED TO WORKFLOW/ACTION-SHAPED FILES ONLY: a file is scanned only
# when it has a top-level `on:` key (a workflow) or a top-level `runs:`
# key (a composite action) -- the two YAML shapes that can legitimately
# carry a GitHub-Actions `uses: <owner>/<repo>@<ref>` step reference.
# This deliberately excludes assets/codeql-config.yml, whose
# `queries: - uses: security-extended` is a CodeQL query-suite name, not
# an action pin (GitHub's CodeQL config schema, `queries[].uses:`) --
# scanning it unscoped would false-positive on that line every time.
#
# Exit codes:
#   0 -- every uses: in assets/*.yml is either a local ref or a
#        40-hex-SHA pin (or no assets/*.yml files exist)
#   1 -- at least one uses: is a bare/tag/branch/short-SHA reference
#
# bash 3.2 compatible (no `mapfile`) so the script and its self-test run
# on macOS too. Parsing uses stdlib tools (python3 + re).
#
# Used by .github/workflows/pin-shape.yml.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to the assets/ directory relative to the repo root (one level
# up from scripts/); overridable via $1 so the self-test can point at a
# throwaway fixture directory instead.
ASSETS_DIR="${1:-${SCRIPT_DIR}/../assets}"

if [ ! -d "$ASSETS_DIR" ]; then
  echo "check-pin-shape: no such directory: ${ASSETS_DIR}" >&2
  exit 1
fi

shopt -s nullglob
manifests=("$ASSETS_DIR"/*.yml "$ASSETS_DIR"/*.yaml)
shopt -u nullglob

if [ "${#manifests[@]}" -eq 0 ]; then
  echo "check-pin-shape: no *.yml/*.yaml files found under ${ASSETS_DIR} -- nothing to check."
  exit 0
fi

overall_status=0

# is_workflow_or_action_shaped <file> -> exit 0 when the file has a
# top-level `on:` key (workflow) or a top-level `runs:` key (composite
# action). Top-level means column 0 -- a nested `on:`/`runs:` under a
# job/step does not count, so the check is
# grep -E '^"?(on|runs)"?:'. The optional quotes accept the common
# `"on":` spelling (used to sidestep YAML 1.1's `on` -> `true` boolean
# coercion) as well as the bare form -- a file using that spelling
# would otherwise be silently SKIPped, leaving its pins entirely
# unchecked.
is_workflow_or_action_shaped() {
  grep -qE '^"?(on|runs)"?:' "$1"
}

for manifest in "${manifests[@]}"; do
  if ! is_workflow_or_action_shaped "$manifest"; then
    echo "SKIP (not workflow/action-shaped -- no top-level on:/runs: key): ${manifest}"
    continue
  fi
  echo "::group::${manifest}"
  if python3 - "$manifest" <<'PY'
import re, sys

manifest = sys.argv[1]
violations = []

# A `uses:` value must be either a local ref (./path) or a 40-hex SHA
# pin (owner/repo[/subpath]@<40-hex>). A floating @vN / @main /
# short-SHA tag, or a bare uses: with no @ref, is a violation. A
# trailing `# vX.Y.Z` comment is display-only and ignored. The leading
# `^\s*-?\s*` anchor means a commented-out example line (e.g.
# `#     - uses: actions/checkout@<sha>`) never matches, since `#` is
# not whitespace or `-`.
USES_RE = re.compile(r'^\s*-?\s*uses:\s*(\S+)')
SHA_RE = re.compile(r'^[0-9a-fA-F]{40}$')

with open(manifest) as f:
    lineno = 0
    for raw in f:
        lineno += 1
        m = USES_RE.match(raw)
        if not m:
            continue
        value = m.group(1)
        value = value.strip('\'"')
        # Local action ref -- no version to pin.
        if value.startswith("./") or value.startswith("../"):
            continue
        # Docker action ref `docker://image@sha256:...` -- not a
        # GitHub-Actions-style ref pin, out of scope for this gate.
        if value.startswith("docker://"):
            continue
        if "@" not in value:
            violations.append(f"line {lineno}: uses: {value} (no @ref -- not SHA-pinned)")
            continue
        ref = value.rsplit("@", 1)[1]
        if not SHA_RE.match(ref):
            violations.append(
                f"line {lineno}: uses: {value} (floating @{ref} ref -- not a 40-hex SHA)"
            )

for v in violations:
    print(f"::error file={manifest}::{v}")
    print(f"VIOLATION: {v}")

sys.exit(1 if violations else 0)
PY
  then
    echo "OK: ${manifest}"
  else
    overall_status=1
  fi
  echo "::endgroup::"
done

if [ "$overall_status" -eq 0 ]; then
  echo "check-pin-shape: all uses: pins in ${ASSETS_DIR} are exact 40-hex SHAs (or local refs)."
else
  echo "check-pin-shape: FAIL -- at least one non-exact uses: pin found." >&2
fi

exit "$overall_status"
