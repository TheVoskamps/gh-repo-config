#!/usr/bin/env bash
#
# test-bump-asset-pins.sh
#
# Self-test for scripts/bump-asset-pins.sh. Fully OFFLINE: stubs `gh`
# with a fake script on PATH that serves canned `releases` /
# `advisories` / `contents` / `git/ref/tags` / `git/tags` JSON fixtures
# instead of hitting the network, so the policy decision logic (soak,
# security bypass, semver-major releases, runtime check) is exercised
# deterministically.
#
# Cases:
#   1. A security release is selected regardless of age (even one
#      published today), over an older soaked release and a newer
#      soaking one.
#   2. A release published today with no advisory is not selected.
#   3. A semver-major release >= 7 days old is applied for
#      github/codeql-action/*.
#   4. A semver-major release >= 7 days old is applied for
#      actions/checkout, like any other action.
#   4b. A semver-major release published today, fixing no advisory that
#      affects the current pin, is not applied.
#   5. aws-actions/configure-aws-credentials (no rendered counterpart
#      anywhere) is covered like any other pin -- not special-cased.
#   6. SHA and trailing version comment stay in sync after a rewrite.
#   7. A file with no on:/runs: key is never touched.
#   8. A hostile release body is inert data, never executed.
#   9. A historical advisory below the current pin does not bypass the
#      soak.
#   10. A quoted `"on":` workflow is still scanned.
#   11. An unversioned pin is rewritten to the latest release >= 7 days
#      old, gaining its `# vX.Y.Z` comment.
#   12. An unversioned pin selects no release published today, even one
#      at an advisory's first patched version.
#   13. An unversioned pin selects no release whose action.yml declares
#      node20.
#   14. An unversioned pin already at the selected release's commit gains
#      its `# vX.Y.Z` comment.
#   15. An unversioned pin takes a soaked release at an advisory's first
#      patched version.
#   16. A partial-version pin (`# v4`, `# v4.4`) is unversioned: it
#      selects no node20 release and gains a full `# vX.Y.Z` comment.
#   17. A bare occurrence of a SHA another occurrence pins with a
#      `# vX.Y.Z` comment gains that comment when no bump is due, in
#      either scan order.
#   18. Such a bare occurrence, scanned first, moves with the versioned
#      one when a security bump is due.
#   19. The closing summary counts SHA bumps and comment-only rewrites
#      separately, as `M bumped, K annotated`, each count agreeing with
#      the per-pin lines; cases 1, 2, 14, 17 and 18 check it too.
#   20. An advisory bypasses the soak only for a pin inside its
#       vulnerable_version_range, not for one below it.
#   21. A failure anywhere in resolving a pin exits 2, never reporting
#       the pin up to date, and the other pins are still bumped.
#   22. An absent action.yml (HTTP 404) is not a failure: action.yaml is
#       read instead.
#
# Exit codes:
#   0 -- all cases pass
#   1 -- any case fails
#
# bash 3.2 compatible (runs on macOS).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUMPER="$SCRIPT_DIR/bump-asset-pins.sh"

if [ ! -f "$BUMPER" ]; then
  echo "FAIL: bumper script not found at $BUMPER" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 not found on PATH -- required by this self-test" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

failures=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

# now_iso / days_ago_iso: portable ISO-8601 timestamp helpers (macOS
# bash 3.2's `date` and GNU `date` take different flags).
iso_now() {
  python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))"
}
iso_days_ago() {
  python3 -c "
from datetime import datetime, timezone, timedelta
import sys
print((datetime.now(timezone.utc) - timedelta(days=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%SZ'))
" "$1"
}

# make_fake_gh <fixtures-dir>: writes a fake `gh` executable into
# <fixtures-dir>/bin that serves canned JSON based on the requested
# `gh api <endpoint>` argument. Fixtures are looked up by turning the
# WHOLE endpoint (path + query string) into a filename, replacing each
# of `/`, `?`, `&`, `=` with `_`; a missing fixture serves `[]`. A
# `<name>.status` file holding an HTTP status makes the call fail as gh
# does, printing `gh: ... (HTTP <status>)` on stderr and exiting 1.
make_fake_gh() {
  local bin_dir="$1/bin"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/gh" <<'FAKEGH'
#!/usr/bin/env bash
set -uo pipefail
if [ "$1" != "api" ]; then
  echo "fake gh: unsupported subcommand: $1" >&2
  exit 1
fi
endpoint="$2"
# Translate the WHOLE endpoint (path + query string) into a filename --
# NOT just the path before "?", which would discard ecosystem=/affects=
# entirely and collide every advisories query into the same fixture.
safe="$(echo "$endpoint" | tr '/?&=' '____')"
fixture="${FAKE_GH_FIXTURES}/${safe}.json"
status_file="${FAKE_GH_FIXTURES}/${safe}.status"
if [ -f "$status_file" ]; then
  status="$(cat "$status_file")"
  if [ "$status" = 404 ]; then
    echo "gh: Not Found (HTTP 404)" >&2
  else
    echo "gh: Server Error (HTTP ${status})" >&2
  fi
  exit 1
elif [ -f "$fixture" ]; then
  cat "$fixture"
else
  echo "[]"
fi
FAKEGH
  chmod +x "$bin_dir/gh"
}

# run_bumper <assets-dir> <fixtures-dir> -> runs the bumper with the
# fake gh on PATH and the given fixtures directory.
run_bumper() {
  local assets_dir="$1"
  local fixtures_dir="$2"
  local out_file="$TMP_ROOT/bumper-out.$$"
  FAKE_GH_FIXTURES="$fixtures_dir" PATH="${fixtures_dir}/bin:${PATH}" \
    bash "$BUMPER" "$assets_dir" >"$out_file" 2>&1
  local status=$?
  cat "$out_file"
  rm -f "$out_file"
  return $status
}

# check_summary <log> <bumped> <annotated> <case>: passes when the
# bumper's closing line reports <bumped> bumped and <annotated> annotated
# pins, and the log's per-pin `bumping` and `adding the` lines number the
# same.
check_summary() {
  local log="$1" want_bumped="$2" want_annotated="$3" label="$4"
  local bumping_lines adding_lines
  bumping_lines="$(grep -c '^  bumping ' "$log")"
  adding_lines="$(grep -c '^  adding the ' "$log")"
  if grep -qE "^bump-asset-pins: checked [0-9]+ distinct pin\(s\), ${want_bumped} bumped, ${want_annotated} annotated\.$" "$log" \
    && [ "$bumping_lines" -eq "$want_bumped" ] && [ "$adding_lines" -eq "$want_annotated" ]; then
    pass "summary reports ${want_bumped} bumped, ${want_annotated} annotated, matching the per-pin lines (${label})"
  else
    fail "expected the summary and per-pin lines to agree on ${want_bumped} bumped, ${want_annotated} annotated (${label})"
    cat "$log"
  fi
}

# ---------------------------------------------------------------------
# Case 1 + 2: soak vs. security bypass, checked over the SAME
# owner/repo so both policies are exercised against each other.
#   - v1.1.0: minor bump, published 30 days ago -> eligible on age.
#   - v1.2.0: minor bump, published TODAY, but fixes a security
#     advisory -> eligible immediately despite being brand new.
#   - v1.3.0: minor bump, published TODAY, no advisory -> NOT eligible
#     (still soaking). Confirms the bumper picks the security release
#     over both the older-and-eligible one AND the newest-but-soaking
#     one is excluded, i.e. it does not just take the newest tag.
# ---------------------------------------------------------------------
CASE1="$TMP_ROOT/case1"
mkdir -p "$CASE1/assets" "$CASE1/fixtures"
make_fake_gh "$CASE1/fixtures"

cat > "$CASE1/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: example-owner/example-action@1111111111111111111111111111111111111111 # v1.0.0
YAML

cat > "$CASE1/fixtures/repos_example-owner_example-action_releases.json" <<JSON
[
  {"tag_name": "v1.3.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false},
  {"tag_name": "v1.2.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false},
  {"tag_name": "v1.1.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON

cat > "$CASE1/fixtures/advisories_ecosystem_actions_affects_example-owner_example-action.json" <<'JSON'
[
  {"vulnerabilities": [{"first_patched_version": {"identifier": "v1.2.0"}}]}
]
JSON

cat > "$CASE1/fixtures/repos_example-owner_example-action_git_ref_tags_v1.2.0.json" <<'JSON'
{"object": {"sha": "2222222222222222222222222222222222222222", "type": "commit"}}
JSON

if run_bumper "$CASE1/assets" "$CASE1/fixtures" > "$TMP_ROOT/case1.log" 2>&1; then
  if grep -q "v1.2.0" "$CASE1/assets/workflow.yml" && grep -q "2222222222222222222222222222222222222222" "$CASE1/assets/workflow.yml"; then
    pass "security release (v1.2.0, published today) selected over older-but-eligible v1.1.0 and newer-but-soaking v1.3.0"
  else
    fail "expected v1.2.0 security release to be selected"
    cat "$TMP_ROOT/case1.log"
    cat "$CASE1/assets/workflow.yml"
  fi
else
  fail "bumper exited non-zero on case 1"
  cat "$TMP_ROOT/case1.log"
fi

# SHA and version comment stay in sync (case 6, folded into case 1's
# fixture: assert the OLD sha/version pair is entirely gone and the new
# pair appears together on the same line).
if grep -qE 'uses: example-owner/example-action@2222222222222222222222222222222222222222 # v1.2.0' "$CASE1/assets/workflow.yml"; then
  pass "SHA and trailing version comment are rewritten together, in sync"
else
  fail "SHA and version comment did not land together on one line"
  cat "$CASE1/assets/workflow.yml"
fi
check_summary "$TMP_ROOT/case1.log" 1 0 "case 1"

# ---------------------------------------------------------------------
# Case 2 (age-only, no security): a plain release must soak 7 days.
# v2.1.0 published today is NOT eligible; nothing changes.
# ---------------------------------------------------------------------
CASE2="$TMP_ROOT/case2"
mkdir -p "$CASE2/assets" "$CASE2/fixtures"
make_fake_gh "$CASE2/fixtures"

cat > "$CASE2/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: another-owner/another-action@3333333333333333333333333333333333333333 # v2.0.0
YAML

cat > "$CASE2/fixtures/repos_another-owner_another-action_releases.json" <<JSON
[
  {"tag_name": "v2.1.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE2/fixtures/advisories_ecosystem_actions_affects_another-owner_another-action.json"

before_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE2/assets/workflow.yml','rb').read()).hexdigest())")"
run_bumper "$CASE2/assets" "$CASE2/fixtures" > "$TMP_ROOT/case2.log" 2>&1
after_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE2/assets/workflow.yml','rb').read()).hexdigest())")"

if [ "$before_hash" = "$after_hash" ]; then
  pass "release published today (no advisory) is NOT eligible -- still soaking, no change made"
else
  fail "expected no change (release still soaking) but file was rewritten"
  cat "$TMP_ROOT/case2.log"
fi
check_summary "$TMP_ROOT/case2.log" 0 0 "case 2"

# ---------------------------------------------------------------------
# Case 3: a soaked semver-major release IS applied for
# github/codeql-action/*.
# ---------------------------------------------------------------------
CASE3="$TMP_ROOT/case3"
mkdir -p "$CASE3/assets" "$CASE3/fixtures"
make_fake_gh "$CASE3/fixtures"

cat > "$CASE3/assets/codeql.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: github/codeql-action/init@8888888888888888888888888888888888888888 # v4.36.2
YAML

cat > "$CASE3/fixtures/repos_github_codeql-action_releases.json" <<JSON
[
  {"tag_name": "v5.0.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE3/fixtures/advisories_ecosystem_actions_affects_github_codeql-action.json"
cat > "$CASE3/fixtures/repos_github_codeql-action_git_ref_tags_v5.0.0.json" <<'JSON'
{"object": {"sha": "4444444444444444444444444444444444444444", "type": "commit"}}
JSON

run_bumper "$CASE3/assets" "$CASE3/fixtures" > "$TMP_ROOT/case3.log" 2>&1
if grep -q "v5.0.0" "$CASE3/assets/codeql.yml"; then
  pass "soaked semver-major release IS applied for github/codeql-action/*"
else
  fail "expected github/codeql-action major bump to v5.0.0 to be applied"
  cat "$TMP_ROOT/case3.log"
  cat "$CASE3/assets/codeql.yml"
fi

# ---------------------------------------------------------------------
# Case 4: a soaked semver-major release IS applied for actions/checkout,
# like any other action.
# ---------------------------------------------------------------------
CASE4="$TMP_ROOT/case4"
mkdir -p "$CASE4/assets" "$CASE4/fixtures"
make_fake_gh "$CASE4/fixtures"

cat > "$CASE4/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v6.0.3
YAML

cat > "$CASE4/fixtures/repos_actions_checkout_releases.json" <<JSON
[
  {"tag_name": "v7.0.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE4/fixtures/advisories_ecosystem_actions_affects_actions_checkout.json"
cat > "$CASE4/fixtures/repos_actions_checkout_git_ref_tags_v7.0.0.json" <<'JSON'
{"object": {"sha": "dddddddddddddddddddddddddddddddddddddddd", "type": "commit"}}
JSON

run_bumper "$CASE4/assets" "$CASE4/fixtures" > "$TMP_ROOT/case4.log" 2>&1
if grep -qE 'uses: actions/checkout@dddddddddddddddddddddddddddddddddddddddd # v7.0.0' "$CASE4/assets/workflow.yml"; then
  pass "soaked semver-major release IS applied for actions/checkout"
else
  fail "expected actions/checkout major bump to v7.0.0 to be applied"
  cat "$TMP_ROOT/case4.log"
  cat "$CASE4/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 4b: a semver-major release published today that fixes no
# advisory affecting the current pin is NOT applied -- majors soak 7
# days like every other release.
# ---------------------------------------------------------------------
CASE4B="$TMP_ROOT/case4b"
mkdir -p "$CASE4B/assets" "$CASE4B/fixtures"
make_fake_gh "$CASE4B/fixtures"

cat > "$CASE4B/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v6.0.3
YAML

cat > "$CASE4B/fixtures/repos_actions_checkout_releases.json" <<JSON
[
  {"tag_name": "v7.0.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false}
]
JSON
# A historical advisory the current pin is already past, so it cannot
# make the major release security-eligible.
cat > "$CASE4B/fixtures/advisories_ecosystem_actions_affects_actions_checkout.json" <<'JSON'
[
  {"vulnerabilities": [{"first_patched_version": {"identifier": "v5.0.0"}}]}
]
JSON
cat > "$CASE4B/fixtures/repos_actions_checkout_git_ref_tags_v7.0.0.json" <<'JSON'
{"object": {"sha": "dddddddddddddddddddddddddddddddddddddddd", "type": "commit"}}
JSON

before_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE4B/assets/workflow.yml','rb').read()).hexdigest())")"
run_bumper "$CASE4B/assets" "$CASE4B/fixtures" > "$TMP_ROOT/case4b.log" 2>&1
after_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE4B/assets/workflow.yml','rb').read()).hexdigest())")"

if [ "$before_hash" = "$after_hash" ] && ! grep -q "bumping" "$TMP_ROOT/case4b.log"; then
  pass "semver-major release published today is NOT applied -- still soaking"
else
  fail "expected the same-day actions/checkout major release to be refused, but file changed"
  cat "$TMP_ROOT/case4b.log"
  cat "$CASE4B/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 5: aws-actions/configure-aws-credentials (no rendered
# counterpart anywhere -- issue #60 consequence 2) is covered like any
# other pin, not special-cased or excluded.
# ---------------------------------------------------------------------
CASE5="$TMP_ROOT/case5"
mkdir -p "$CASE5/assets" "$CASE5/fixtures"
make_fake_gh "$CASE5/fixtures"

cat > "$CASE5/assets/codeartifact-auth-action.yml" <<'YAML'
name: codeartifact-auth
runs:
  using: composite
  steps:
    - uses: aws-actions/configure-aws-credentials@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # v6.2.3
YAML

cat > "$CASE5/fixtures/repos_aws-actions_configure-aws-credentials_releases.json" <<JSON
[
  {"tag_name": "v6.3.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE5/fixtures/advisories_ecosystem_actions_affects_aws-actions_configure-aws-credentials.json"
cat > "$CASE5/fixtures/repos_aws-actions_configure-aws-credentials_git_ref_tags_v6.3.0.json" <<'JSON'
{"object": {"sha": "5555555555555555555555555555555555555555", "type": "commit"}}
JSON

run_bumper "$CASE5/assets" "$CASE5/fixtures" > "$TMP_ROOT/case5.log" 2>&1
if grep -q "v6.3.0" "$CASE5/assets/codeartifact-auth-action.yml"; then
  pass "aws-actions/configure-aws-credentials (no rendered counterpart) is covered like any other pin"
else
  fail "expected aws-actions/configure-aws-credentials to be bumped to v6.3.0"
  cat "$TMP_ROOT/case5.log"
  cat "$CASE5/assets/codeartifact-auth-action.yml"
fi

# ---------------------------------------------------------------------
# Case 7: codeql-config.yml-shaped file (no on:/runs:) with a
# uses:-like key is never touched, even if it happened to share text
# with a real pin elsewhere.
# ---------------------------------------------------------------------
CASE7="$TMP_ROOT/case7"
mkdir -p "$CASE7/assets" "$CASE7/fixtures"
make_fake_gh "$CASE7/fixtures"

cat > "$CASE7/assets/codeql-config.yml" <<'YAML'
name: "Default CodeQL config"
queries:
  - uses: security-extended
YAML

before_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE7/assets/codeql-config.yml','rb').read()).hexdigest())")"
run_bumper "$CASE7/assets" "$CASE7/fixtures" > "$TMP_ROOT/case7.log" 2>&1
after_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE7/assets/codeql-config.yml','rb').read()).hexdigest())")"

if [ "$before_hash" = "$after_hash" ]; then
  pass "non-workflow/action-shaped file (codeql-config.yml) is left untouched"
else
  fail "codeql-config.yml was unexpectedly modified"
  cat "$TMP_ROOT/case7.log"
fi

# ---------------------------------------------------------------------
# Case 8: a release body containing the embedded language's own string
# delimiters (a Python triple-quote) must be handled as INERT DATA, not
# executed. This is the regression test for the arbitrary-code-
# execution finding: releases/advisories JSON is fed to python3 via a
# file path on argv, never interpolated into Python source text, so a
# `'''` anywhere in the payload can never terminate a string literal
# early. Plant a marker-file side effect in the body exactly the way a
# real attack would, and assert it never appears -- plus assert the
# bumper still runs to completion and reaches its normal "up to date"
# outcome (no crash, no misparse) for this benign-shaped-but-hostile
# release.
# ---------------------------------------------------------------------
CASE8="$TMP_ROOT/case8"
mkdir -p "$CASE8/assets" "$CASE8/fixtures"
make_fake_gh "$CASE8/fixtures"
MARKER_FILE="$TMP_ROOT/case8-marker"
rm -f "$MARKER_FILE"

cat > "$CASE8/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: evil-owner/evil-action@1111111111111111111111111111111111111111 # v1.0.0
YAML

python3 - "$CASE8/fixtures/repos_evil-owner_evil-action_releases.json" "$MARKER_FILE" "$(iso_days_ago 30)" <<'PY'
import json, sys

out_path, marker_path, published = sys.argv[1:4]
body = (
    "release notes ''' + str(__import__('os').system("
    + repr("touch " + marker_path)
    + ")) + r''' end"
)
releases = [{
    "tag_name": "v1.1.0",
    "published_at": published,
    "draft": False,
    "prerelease": False,
    "body": body,
}]
with open(out_path, "w") as f:
    json.dump(releases, f)
PY
echo '[]' > "$CASE8/fixtures/advisories_ecosystem_actions_affects_evil-owner_evil-action.json"
cat > "$CASE8/fixtures/repos_evil-owner_evil-action_git_ref_tags_v1.1.0.json" <<'JSON'
{"object": {"sha": "6666666666666666666666666666666666666666", "type": "commit"}}
JSON

run_bumper "$CASE8/assets" "$CASE8/fixtures" > "$TMP_ROOT/case8.log" 2>&1
case8_status=$?

if [ -f "$MARKER_FILE" ]; then
  fail "malicious release body EXECUTED -- marker file was created (arbitrary code execution)"
  cat "$TMP_ROOT/case8.log"
else
  pass "malicious release body ('''  in its text) is treated as inert data, not executed"
fi

if [ "$case8_status" -eq 0 ] && grep -q "v1.1.0" "$CASE8/assets/workflow.yml"; then
  pass "bumper still parses and applies the eligible release despite hostile delimiters in its body"
else
  fail "bumper did not complete normally on a release body containing embedded delimiters"
  cat "$TMP_ROOT/case8.log"
fi

# ---------------------------------------------------------------------
# Case 9: the 7-day soak must still apply when the action has a
# HISTORICAL advisory but the CURRENTLY PINNED version is not itself
# affected by it (first_patched_version is BELOW the current pin).
# Without the current-pin-is-vulnerable guard, every release of an
# action that ever had any advisory would be treated as a security fix
# forever, bypassing the soak unconditionally. Here current is v2.0.0,
# the advisory's first_patched_version is v0.9.1 (long since surpassed
# by the current pin), and a same-day v2.1.0 release exists with no
# applicable advisory -- it must NOT be taken; the soak must still
# apply and the file must be unchanged.
# ---------------------------------------------------------------------
CASE9="$TMP_ROOT/case9"
mkdir -p "$CASE9/assets" "$CASE9/fixtures"
make_fake_gh "$CASE9/fixtures"

cat > "$CASE9/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: patched-owner/patched-action@7777777777777777777777777777777777777777 # v2.0.0
YAML

cat > "$CASE9/fixtures/repos_patched-owner_patched-action_releases.json" <<JSON
[
  {"tag_name": "v2.1.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false}
]
JSON

cat > "$CASE9/fixtures/advisories_ecosystem_actions_affects_patched-owner_patched-action.json" <<'JSON'
[
  {"vulnerabilities": [{"first_patched_version": {"identifier": "v0.9.1"}}]}
]
JSON

# Fixture for the downstream tag-resolution step too, so a would-be
# regression that reintroduces the soak bypass is caught by the
# CONTENT check below, not masked by an unrelated failure further down
# the pipeline (e.g. a missing tag-ref fixture) that happens to also
# leave the file unchanged.
cat > "$CASE9/fixtures/repos_patched-owner_patched-action_git_ref_tags_v2.1.0.json" <<'JSON'
{"object": {"sha": "9999999999999999999999999999999999999999", "type": "commit"}}
JSON

before_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE9/assets/workflow.yml','rb').read()).hexdigest())")"
run_bumper "$CASE9/assets" "$CASE9/fixtures" > "$TMP_ROOT/case9.log" 2>&1
after_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE9/assets/workflow.yml','rb').read()).hexdigest())")"

if [ "$before_hash" = "$after_hash" ] && ! grep -q "bumping" "$TMP_ROOT/case9.log"; then
  pass "historical advisory whose first_patched_version is already below the current pin does NOT bypass the soak"
else
  fail "expected soak to still apply (current pin already patched) but file was rewritten"
  cat "$TMP_ROOT/case9.log"
  cat "$CASE9/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 10: a workflow written with the quoted `"on":` spelling (a
# common way to sidestep YAML 1.1's `on` -> `true` boolean coercion) is
# still recognized as workflow-shaped and its pins are bumped -- not
# silently skipped, which would leave the pin unbumped forever.
# ---------------------------------------------------------------------
CASE10="$TMP_ROOT/case10"
mkdir -p "$CASE10/assets" "$CASE10/fixtures"
make_fake_gh "$CASE10/fixtures"

cat > "$CASE10/assets/workflow.yml" <<'YAML'
"on":
  pull_request:
steps:
  - uses: quoted-owner/quoted-action@1010101010101010101010101010101010101010 # v1.0.0
YAML

cat > "$CASE10/fixtures/repos_quoted-owner_quoted-action_releases.json" <<JSON
[
  {"tag_name": "v1.1.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE10/fixtures/advisories_ecosystem_actions_affects_quoted-owner_quoted-action.json"
cat > "$CASE10/fixtures/repos_quoted-owner_quoted-action_git_ref_tags_v1.1.0.json" <<'JSON'
{"object": {"sha": "1212121212121212121212121212121212121212", "type": "commit"}}
JSON

run_bumper "$CASE10/assets" "$CASE10/fixtures" > "$TMP_ROOT/case10.log" 2>&1
if grep -q "v1.1.0" "$CASE10/assets/workflow.yml"; then
  pass "quoted \"on\": spelling is still recognized as workflow-shaped and its pins are bumped"
else
  fail "expected quoted \"on\": workflow to be scanned and bumped to v1.1.0"
  cat "$TMP_ROOT/case10.log"
  cat "$CASE10/assets/workflow.yml"
fi

# write_action_yml_fixture <fixture-file> <runs.using>: writes a
# `repos/*/contents/*` payload whose base64 content is an action.yml
# declaring the given runtime.
write_action_yml_fixture() {
  python3 - "$1" "$2" <<'PY'
import base64, json, sys

out_path, using = sys.argv[1:3]
action_yml = f"name: fixture\nruns:\n  using: '{using}'\n  main: dist/index.js\n"
with open(out_path, "w") as f:
    json.dump({"encoding": "base64", "content": base64.b64encode(action_yml.encode()).decode()}, f)
PY
}

# ---------------------------------------------------------------------
# Case 11: an unversioned pin (no `# vX.Y.Z` comment) is rewritten to
# the latest release at least 7 days old -- v2.1.0, not the older
# v2.0.0 nor the still-soaking v3.0.0 -- and gains its version comment.
# ---------------------------------------------------------------------
CASE11="$TMP_ROOT/case11"
mkdir -p "$CASE11/assets" "$CASE11/fixtures"
make_fake_gh "$CASE11/fixtures"

cat > "$CASE11/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: bare-owner/bare-action@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
YAML

cat > "$CASE11/fixtures/repos_bare-owner_bare-action_releases.json" <<JSON
[
  {"tag_name": "v3.0.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false},
  {"tag_name": "v2.1.0", "published_at": "$(iso_days_ago 10)", "draft": false, "prerelease": false},
  {"tag_name": "v2.0.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE11/fixtures/advisories_ecosystem_actions_affects_bare-owner_bare-action.json"
write_action_yml_fixture "$CASE11/fixtures/repos_bare-owner_bare-action_contents_action.yml_ref_v3.0.0.json" node24
write_action_yml_fixture "$CASE11/fixtures/repos_bare-owner_bare-action_contents_action.yml_ref_v2.1.0.json" node24
write_action_yml_fixture "$CASE11/fixtures/repos_bare-owner_bare-action_contents_action.yml_ref_v2.0.0.json" node24
cat > "$CASE11/fixtures/repos_bare-owner_bare-action_git_ref_tags_v2.1.0.json" <<'JSON'
{"object": {"sha": "abababababababababababababababababababab", "type": "commit"}}
JSON

run_bumper "$CASE11/assets" "$CASE11/fixtures" > "$TMP_ROOT/case11.log" 2>&1
if grep -qE '^  - uses: bare-owner/bare-action@abababababababababababababababababababab # v2\.1\.0$' "$CASE11/assets/workflow.yml"; then
  pass "unversioned pin is rewritten to the latest release >= 7 days old, with its # vX.Y.Z comment"
else
  fail "expected the unversioned pin to move to v2.1.0 with its version comment"
  cat "$TMP_ROOT/case11.log"
  cat "$CASE11/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 12: an unversioned pin selects no release published today, even
# one at an advisory's first patched version -- with no current version
# the bumper cannot show the advisory affects the pin.
# ---------------------------------------------------------------------
CASE12="$TMP_ROOT/case12"
mkdir -p "$CASE12/assets" "$CASE12/fixtures"
make_fake_gh "$CASE12/fixtures"

cat > "$CASE12/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: bare-owner/bare-action@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
YAML

cat > "$CASE12/fixtures/repos_bare-owner_bare-action_releases.json" <<JSON
[
  {"tag_name": "v3.0.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false}
]
JSON
cat > "$CASE12/fixtures/advisories_ecosystem_actions_affects_bare-owner_bare-action.json" <<'JSON'
[
  {"vulnerabilities": [{"first_patched_version": {"identifier": "v3.0.0"}}]}
]
JSON
write_action_yml_fixture "$CASE12/fixtures/repos_bare-owner_bare-action_contents_action.yml_ref_v3.0.0.json" node24
cat > "$CASE12/fixtures/repos_bare-owner_bare-action_git_ref_tags_v3.0.0.json" <<'JSON'
{"object": {"sha": "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", "type": "commit"}}
JSON

before_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE12/assets/workflow.yml','rb').read()).hexdigest())")"
run_bumper "$CASE12/assets" "$CASE12/fixtures" > "$TMP_ROOT/case12.log" 2>&1
after_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE12/assets/workflow.yml','rb').read()).hexdigest())")"

if [ "$before_hash" = "$after_hash" ] && ! grep -q "bumping" "$TMP_ROOT/case12.log"; then
  pass "unversioned pin selects no release published today, even one at an advisory's first patched version"
else
  fail "expected no change for an unversioned pin whose only release is still soaking"
  cat "$TMP_ROOT/case12.log"
  cat "$CASE12/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 13: an unversioned pin selects no release whose action.yml
# declares node20. The newest soaked release, v2.1.0, runs on node20, so
# the bumper passes over it to v2.0.0, which runs on node24. The
# subpath action's action.yml is read from under its subpath.
# ---------------------------------------------------------------------
CASE13="$TMP_ROOT/case13"
mkdir -p "$CASE13/assets" "$CASE13/fixtures"
make_fake_gh "$CASE13/fixtures"

cat > "$CASE13/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: bare-owner/bare-action/sub@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
YAML

cat > "$CASE13/fixtures/repos_bare-owner_bare-action_releases.json" <<JSON
[
  {"tag_name": "v2.1.0", "published_at": "$(iso_days_ago 10)", "draft": false, "prerelease": false},
  {"tag_name": "v2.0.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE13/fixtures/advisories_ecosystem_actions_affects_bare-owner_bare-action.json"
write_action_yml_fixture "$CASE13/fixtures/repos_bare-owner_bare-action_contents_sub_action.yml_ref_v2.1.0.json" node20
write_action_yml_fixture "$CASE13/fixtures/repos_bare-owner_bare-action_contents_sub_action.yml_ref_v2.0.0.json" node24
cat > "$CASE13/fixtures/repos_bare-owner_bare-action_git_ref_tags_v2.1.0.json" <<'JSON'
{"object": {"sha": "abababababababababababababababababababab", "type": "commit"}}
JSON
cat > "$CASE13/fixtures/repos_bare-owner_bare-action_git_ref_tags_v2.0.0.json" <<'JSON'
{"object": {"sha": "efefefefefefefefefefefefefefefefefefefef", "type": "commit"}}
JSON

run_bumper "$CASE13/assets" "$CASE13/fixtures" > "$TMP_ROOT/case13.log" 2>&1
if grep -qE '^  - uses: bare-owner/bare-action/sub@efefefefefefefefefefefefefefefefefefefef # v2\.0\.0$' "$CASE13/assets/workflow.yml"; then
  pass "unversioned pin passes over a node20 release to the newest soaked node24 one"
else
  fail "expected the unversioned pin to skip node20 v2.1.0 and move to node24 v2.0.0"
  cat "$TMP_ROOT/case13.log"
  cat "$CASE13/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 14: an unversioned pin already at the commit of the release the
# bumper selects keeps its SHA and gains that release's comment.
# ---------------------------------------------------------------------
CASE14="$TMP_ROOT/case14"
mkdir -p "$CASE14/assets" "$CASE14/fixtures"
make_fake_gh "$CASE14/fixtures"

cat > "$CASE14/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: bare-owner/bare-action@abababababababababababababababababababab
YAML

cat > "$CASE14/fixtures/repos_bare-owner_bare-action_releases.json" <<JSON
[
  {"tag_name": "v2.1.0", "published_at": "$(iso_days_ago 10)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE14/fixtures/advisories_ecosystem_actions_affects_bare-owner_bare-action.json"
write_action_yml_fixture "$CASE14/fixtures/repos_bare-owner_bare-action_contents_action.yml_ref_v2.1.0.json" node24
cat > "$CASE14/fixtures/repos_bare-owner_bare-action_git_ref_tags_v2.1.0.json" <<'JSON'
{"object": {"sha": "abababababababababababababababababababab", "type": "commit"}}
JSON

run_bumper "$CASE14/assets" "$CASE14/fixtures" > "$TMP_ROOT/case14.log" 2>&1
if grep -qE '^  - uses: bare-owner/bare-action@abababababababababababababababababababab # v2\.1\.0$' "$CASE14/assets/workflow.yml"; then
  pass "unversioned pin already at the selected release's commit gains its # vX.Y.Z comment"
else
  fail "expected the unversioned pin at v2.1.0's commit to gain its # v2.1.0 comment"
  cat "$TMP_ROOT/case14.log"
  cat "$CASE14/assets/workflow.yml"
fi
check_summary "$TMP_ROOT/case14.log" 0 1 "case 14"

# ---------------------------------------------------------------------
# Case 15: an advisory leaves an unversioned pin's soak pool alone. The
# only release, v2.0.0, is 30 days old and is the advisory's first
# patched version; it is still the release the pin moves to.
# ---------------------------------------------------------------------
CASE15="$TMP_ROOT/case15"
mkdir -p "$CASE15/assets" "$CASE15/fixtures"
make_fake_gh "$CASE15/fixtures"

cat > "$CASE15/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: bare-owner/bare-action@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
YAML

cat > "$CASE15/fixtures/repos_bare-owner_bare-action_releases.json" <<JSON
[
  {"tag_name": "v2.0.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
cat > "$CASE15/fixtures/advisories_ecosystem_actions_affects_bare-owner_bare-action.json" <<'JSON'
[
  {"vulnerabilities": [{"first_patched_version": {"identifier": "v2.0.0"}}]}
]
JSON
write_action_yml_fixture "$CASE15/fixtures/repos_bare-owner_bare-action_contents_action.yml_ref_v2.0.0.json" node24
cat > "$CASE15/fixtures/repos_bare-owner_bare-action_git_ref_tags_v2.0.0.json" <<'JSON'
{"object": {"sha": "1313131313131313131313131313131313131313", "type": "commit"}}
JSON

run_bumper "$CASE15/assets" "$CASE15/fixtures" > "$TMP_ROOT/case15.log" 2>&1
if grep -qE '^  - uses: bare-owner/bare-action@1313131313131313131313131313131313131313 # v2\.0\.0$' "$CASE15/assets/workflow.yml"; then
  pass "unversioned pin takes a soaked release at an advisory's first patched version"
else
  fail "expected the unversioned pin to move to soaked v2.0.0 despite its advisory"
  cat "$TMP_ROOT/case15.log"
  cat "$CASE15/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 16: a pin whose comment is a partial version (`# v4`, `# v4.4`)
# is unversioned. The newest soaked release, v5.0.0, runs on node20, so
# both pins pass over it to v4.5.0, which runs on node24, and each gains
# the full `# v4.5.0` comment.
# ---------------------------------------------------------------------
CASE16="$TMP_ROOT/case16"
mkdir -p "$CASE16/assets" "$CASE16/fixtures"
make_fake_gh "$CASE16/fixtures"

cat > "$CASE16/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: partial-owner/partial-action@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee # v4
  - uses: partial-owner/partial-action@ffffffffffffffffffffffffffffffffffffffff # v4.4
YAML

cat > "$CASE16/fixtures/repos_partial-owner_partial-action_releases.json" <<JSON
[
  {"tag_name": "v5.0.0", "published_at": "$(iso_days_ago 10)", "draft": false, "prerelease": false},
  {"tag_name": "v4.5.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE16/fixtures/advisories_ecosystem_actions_affects_partial-owner_partial-action.json"
write_action_yml_fixture "$CASE16/fixtures/repos_partial-owner_partial-action_contents_action.yml_ref_v5.0.0.json" node20
write_action_yml_fixture "$CASE16/fixtures/repos_partial-owner_partial-action_contents_action.yml_ref_v4.5.0.json" node24
cat > "$CASE16/fixtures/repos_partial-owner_partial-action_git_ref_tags_v5.0.0.json" <<'JSON'
{"object": {"sha": "1515151515151515151515151515151515151515", "type": "commit"}}
JSON
cat > "$CASE16/fixtures/repos_partial-owner_partial-action_git_ref_tags_v4.5.0.json" <<'JSON'
{"object": {"sha": "1414141414141414141414141414141414141414", "type": "commit"}}
JSON

run_bumper "$CASE16/assets" "$CASE16/fixtures" > "$TMP_ROOT/case16.log" 2>&1
case16_lines="$(grep -cE '^  - uses: partial-owner/partial-action@1414141414141414141414141414141414141414 # v4\.5\.0$' "$CASE16/assets/workflow.yml")"
if [ "$case16_lines" -eq 2 ]; then
  pass "partial-version pins pass over a node20 release and gain a full # vX.Y.Z comment"
else
  fail "expected both partial-version pins to skip node20 v5.0.0 and move to node24 v4.5.0"
  cat "$TMP_ROOT/case16.log"
  cat "$CASE16/assets/workflow.yml"
fi

# ---------------------------------------------------------------------
# Case 17: a bare occurrence of a SHA another occurrence pins as
# `# v1.2.3`, already the newest release, keeps its SHA and gains the
# `# v1.2.3` comment whichever occurrence is scanned first. The versioned
# occurrence is left as it is. v1.2.3 runs on node20, so in the
# bare-first order a bumper that read the pin as unversioned would reject
# it and select no release; in the versioned-first order no release is
# newer than the pin. In both orders the bare occurrence gains its
# comment only from the rewrite of bare occurrences.
# ---------------------------------------------------------------------
for order in versioned-first bare-first; do
  CASE17="$TMP_ROOT/case17-$order"
  mkdir -p "$CASE17/assets" "$CASE17/fixtures"
  make_fake_gh "$CASE17/fixtures"

  versioned_line='  - uses: mixed-owner/mixed-action@1717171717171717171717171717171717171717 # v1.2.3'
  bare_line='  - uses: mixed-owner/mixed-action@1717171717171717171717171717171717171717'
  if [ "$order" = versioned-first ]; then
    first="$versioned_line" second="$bare_line"
  else
    first="$bare_line" second="$versioned_line"
  fi
  printf 'on:\n  pull_request:\nsteps:\n%s\n%s\n' "$first" "$second" > "$CASE17/assets/workflow.yml"

  cat > "$CASE17/fixtures/repos_mixed-owner_mixed-action_releases.json" <<JSON
[
  {"tag_name": "v1.2.3", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
  echo '[]' > "$CASE17/fixtures/advisories_ecosystem_actions_affects_mixed-owner_mixed-action.json"
  write_action_yml_fixture "$CASE17/fixtures/repos_mixed-owner_mixed-action_contents_action.yml_ref_v1.2.3.json" node20
  cat > "$CASE17/fixtures/repos_mixed-owner_mixed-action_git_ref_tags_v1.2.3.json" <<'JSON'
{"object": {"sha": "1717171717171717171717171717171717171717", "type": "commit"}}
JSON

  run_bumper "$CASE17/assets" "$CASE17/fixtures" > "$TMP_ROOT/case17-$order.log" 2>&1
  case17_lines="$(grep -cxF "$versioned_line" "$CASE17/assets/workflow.yml")"
  if [ "$case17_lines" -eq 2 ]; then
    pass "bare occurrence of a versioned pin's SHA gains its # vX.Y.Z comment ($order)"
  else
    fail "expected both occurrences to read '# v1.2.3' at the unchanged SHA ($order)"
    cat "$TMP_ROOT/case17-$order.log"
    cat "$CASE17/assets/workflow.yml"
  fi
  check_summary "$TMP_ROOT/case17-$order.log" 0 1 "case 17, $order"
done

# ---------------------------------------------------------------------
# Case 18: when a bump is due, a bare occurrence of the versioned pin's
# SHA moves with it, even when the bare occurrence is scanned first. The
# selected release, v1.3.0, is published today and fixes an advisory
# affecting v1.2.3, so only the security bypass of a versioned pin
# selects it; a bumper that read the pin as unversioned would leave both
# occurrences at v1.2.3's SHA. With the versioned occurrence scanned
# first the pin was never read as unversioned, so that order guards
# nothing here and is not run.
# ---------------------------------------------------------------------
CASE18="$TMP_ROOT/case18"
mkdir -p "$CASE18/assets" "$CASE18/fixtures"
make_fake_gh "$CASE18/fixtures"

cat > "$CASE18/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: mixed-owner/mixed-action@1717171717171717171717171717171717171717
  - uses: mixed-owner/mixed-action@1717171717171717171717171717171717171717 # v1.2.3
YAML

cat > "$CASE18/fixtures/repos_mixed-owner_mixed-action_releases.json" <<JSON
[
  {"tag_name": "v1.3.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false},
  {"tag_name": "v1.2.3", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
cat > "$CASE18/fixtures/advisories_ecosystem_actions_affects_mixed-owner_mixed-action.json" <<'JSON'
[
  {"vulnerabilities": [{"first_patched_version": {"identifier": "v1.3.0"}}]}
]
JSON
write_action_yml_fixture "$CASE18/fixtures/repos_mixed-owner_mixed-action_contents_action.yml_ref_v1.3.0.json" node24
write_action_yml_fixture "$CASE18/fixtures/repos_mixed-owner_mixed-action_contents_action.yml_ref_v1.2.3.json" node24
cat > "$CASE18/fixtures/repos_mixed-owner_mixed-action_git_ref_tags_v1.3.0.json" <<'JSON'
{"object": {"sha": "1818181818181818181818181818181818181818", "type": "commit"}}
JSON
cat > "$CASE18/fixtures/repos_mixed-owner_mixed-action_git_ref_tags_v1.2.3.json" <<'JSON'
{"object": {"sha": "1717171717171717171717171717171717171717", "type": "commit"}}
JSON

run_bumper "$CASE18/assets" "$CASE18/fixtures" > "$TMP_ROOT/case18.log" 2>&1
case18_lines="$(grep -cxF '  - uses: mixed-owner/mixed-action@1818181818181818181818181818181818181818 # v1.3.0' "$CASE18/assets/workflow.yml")"
if [ "$case18_lines" -eq 2 ]; then
  pass "bare occurrence scanned before a versioned pin's SHA moves with it to the selected release"
else
  fail "expected both occurrences to move to v1.3.0 with the bare one scanned first"
  cat "$TMP_ROOT/case18.log"
  cat "$CASE18/assets/workflow.yml"
fi
check_summary "$TMP_ROOT/case18.log" 1 0 "case 18"

# ---------------------------------------------------------------------
# Case 19: one run that bumps a SHA and makes both kinds of comment-only
# rewrite counts each separately. bump-owner/bump-action moves to a new
# SHA; bare-owner/bare-action is already at its selected release's
# commit; mixed-owner/mixed-action's bare occurrence gains its versioned
# occurrence's comment with no bump due.
# ---------------------------------------------------------------------
CASE19="$TMP_ROOT/case19"
mkdir -p "$CASE19/assets" "$CASE19/fixtures"
make_fake_gh "$CASE19/fixtures"

cat > "$CASE19/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: bump-owner/bump-action@1919191919191919191919191919191919191919 # v1.0.0
  - uses: bare-owner/bare-action@abababababababababababababababababababab
  - uses: mixed-owner/mixed-action@1717171717171717171717171717171717171717 # v1.2.3
  - uses: mixed-owner/mixed-action@1717171717171717171717171717171717171717
YAML

cat > "$CASE19/fixtures/repos_bump-owner_bump-action_releases.json" <<JSON
[
  {"tag_name": "v1.1.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
cat > "$CASE19/fixtures/repos_bump-owner_bump-action_git_ref_tags_v1.1.0.json" <<'JSON'
{"object": {"sha": "2020202020202020202020202020202020202020", "type": "commit"}}
JSON
cat > "$CASE19/fixtures/repos_bare-owner_bare-action_releases.json" <<JSON
[
  {"tag_name": "v2.1.0", "published_at": "$(iso_days_ago 10)", "draft": false, "prerelease": false}
]
JSON
write_action_yml_fixture "$CASE19/fixtures/repos_bare-owner_bare-action_contents_action.yml_ref_v2.1.0.json" node24
cat > "$CASE19/fixtures/repos_bare-owner_bare-action_git_ref_tags_v2.1.0.json" <<'JSON'
{"object": {"sha": "abababababababababababababababababababab", "type": "commit"}}
JSON
cat > "$CASE19/fixtures/repos_mixed-owner_mixed-action_releases.json" <<JSON
[
  {"tag_name": "v1.2.3", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON

run_bumper "$CASE19/assets" "$CASE19/fixtures" > "$TMP_ROOT/case19.log" 2>&1
if grep -qxF '  - uses: bump-owner/bump-action@2020202020202020202020202020202020202020 # v1.1.0' "$CASE19/assets/workflow.yml" \
  && grep -qxF '  - uses: bare-owner/bare-action@abababababababababababababababababababab # v2.1.0' "$CASE19/assets/workflow.yml" \
  && [ "$(grep -cxF '  - uses: mixed-owner/mixed-action@1717171717171717171717171717171717171717 # v1.2.3' "$CASE19/assets/workflow.yml")" -eq 2 ]; then
  pass "one run bumps one pin and adds comments to two others"
else
  fail "expected one SHA bump and two comment-only rewrites in one run"
  cat "$TMP_ROOT/case19.log"
  cat "$CASE19/assets/workflow.yml"
fi
check_summary "$TMP_ROOT/case19.log" 1 2 "case 19"

# ---------------------------------------------------------------------
# Case 20: an advisory applies only to a pin inside its
# vulnerable_version_range. v2.5.0, published today, is the first
# patched version of an advisory for `>= 2.0.0, < 2.5.0`. A v1.4.0 pin,
# below that range, is not affected, so v2.5.0 still soaks; a v2.1.0
# pin, inside it, takes v2.5.0 at once.
# ---------------------------------------------------------------------
for pinned in v1.4.0 v2.1.0; do
  CASE20="$TMP_ROOT/case20-$pinned"
  mkdir -p "$CASE20/assets" "$CASE20/fixtures"
  make_fake_gh "$CASE20/fixtures"

  printf 'on:\n  pull_request:\nsteps:\n  - uses: range-owner/range-action@2121212121212121212121212121212121212121 # %s\n' \
    "$pinned" > "$CASE20/assets/workflow.yml"

  cat > "$CASE20/fixtures/repos_range-owner_range-action_releases.json" <<JSON
[
  {"tag_name": "v2.5.0", "published_at": "$(iso_now)", "draft": false, "prerelease": false}
]
JSON
  cat > "$CASE20/fixtures/advisories_ecosystem_actions_affects_range-owner_range-action.json" <<'JSON'
[
  {"vulnerabilities": [{"vulnerable_version_range": ">= 2.0.0, < 2.5.0", "first_patched_version": "2.5.0"}]}
]
JSON
  cat > "$CASE20/fixtures/repos_range-owner_range-action_git_ref_tags_v2.5.0.json" <<'JSON'
{"object": {"sha": "2525252525252525252525252525252525252525", "type": "commit"}}
JSON

  run_bumper "$CASE20/assets" "$CASE20/fixtures" > "$TMP_ROOT/case20-$pinned.log" 2>&1
  case20_status=$?
  if [ "$pinned" = v1.4.0 ]; then
    want_line="  - uses: range-owner/range-action@2121212121212121212121212121212121212121 # v1.4.0"
    label="a pin below an advisory's vulnerable range does not bypass the soak"
  else
    want_line="  - uses: range-owner/range-action@2525252525252525252525252525252525252525 # v2.5.0"
    label="a pin inside an advisory's vulnerable range takes its fix at once"
  fi
  if [ "$case20_status" -eq 0 ] && grep -qxF "$want_line" "$CASE20/assets/workflow.yml"; then
    pass "$label ($pinned)"
  else
    fail "expected exit 0 and '${want_line}' ($pinned)"
    cat "$TMP_ROOT/case20-$pinned.log"
    cat "$CASE20/assets/workflow.yml"
  fi
done

# ---------------------------------------------------------------------
# Case 21: a failure anywhere in resolving a pin makes the bumper exit 2
# rather than report the pin up to date. Each run fails one lookup:
#   releases     -- listing the releases
#   advisories   -- listing the advisories
#   range        -- an advisory's vulnerable_version_range is unreadable
#   tag-ref      -- resolving the selected tag
#   tag-object   -- dereferencing the selected annotated tag
#   contents     -- reading an unversioned pin's action.yml (HTTP 500)
# Every run also carries a pin that resolves, which is still bumped.
# ---------------------------------------------------------------------
for failing in releases advisories range tag-ref tag-object contents; do
  CASE21="$TMP_ROOT/case21-$failing"
  mkdir -p "$CASE21/assets" "$CASE21/fixtures"
  make_fake_gh "$CASE21/fixtures"
  fx="$CASE21/fixtures"

  if [ "$failing" = contents ]; then
    fail_line='  - uses: fail-owner/fail-action@2222222222222222222222222222222222222222'
  else
    fail_line='  - uses: fail-owner/fail-action@2222222222222222222222222222222222222222 # v1.0.0'
  fi
  printf 'on:\n  pull_request:\nsteps:\n%s\n%s\n' "$fail_line" \
    '  - uses: ok-owner/ok-action@3030303030303030303030303030303030303030 # v1.0.0' > "$CASE21/assets/workflow.yml"

  cat > "$fx/repos_fail-owner_fail-action_releases.json" <<JSON
[
  {"tag_name": "v1.1.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
  write_action_yml_fixture "$fx/repos_fail-owner_fail-action_contents_action.yml_ref_v1.1.0.json" node24
  cat > "$fx/repos_fail-owner_fail-action_git_ref_tags_v1.1.0.json" <<'JSON'
{"object": {"sha": "2323232323232323232323232323232323232323", "type": "commit"}}
JSON
  cat > "$fx/repos_ok-owner_ok-action_releases.json" <<JSON
[
  {"tag_name": "v1.1.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
  cat > "$fx/repos_ok-owner_ok-action_git_ref_tags_v1.1.0.json" <<'JSON'
{"object": {"sha": "3131313131313131313131313131313131313131", "type": "commit"}}
JSON

  case "$failing" in
    releases) echo 500 > "$fx/repos_fail-owner_fail-action_releases.status" ;;
    advisories) echo 500 > "$fx/advisories_ecosystem_actions_affects_fail-owner_fail-action.status" ;;
    range)
      cat > "$fx/advisories_ecosystem_actions_affects_fail-owner_fail-action.json" <<'JSON'
[
  {"vulnerabilities": [{"vulnerable_version_range": "~> 1.0", "first_patched_version": "1.1.0"}]}
]
JSON
      ;;
    tag-ref) echo 500 > "$fx/repos_fail-owner_fail-action_git_ref_tags_v1.1.0.status" ;;
    tag-object)
      cat > "$fx/repos_fail-owner_fail-action_git_ref_tags_v1.1.0.json" <<'JSON'
{"object": {"sha": "2424242424242424242424242424242424242424", "type": "tag"}}
JSON
      echo 500 > "$fx/repos_fail-owner_fail-action_git_tags_2424242424242424242424242424242424242424.status"
      ;;
    contents) echo 500 > "$fx/repos_fail-owner_fail-action_contents_action.yml_ref_v1.1.0.status" ;;
  esac

  run_bumper "$CASE21/assets" "$CASE21/fixtures" > "$TMP_ROOT/case21-$failing.log" 2>&1
  case21_status=$?
  if [ "$case21_status" -eq 2 ] \
    && grep -q '^  error: ' "$TMP_ROOT/case21-$failing.log" \
    && ! grep -q 'up to date' "$TMP_ROOT/case21-$failing.log" \
    && grep -qxF "$fail_line" "$CASE21/assets/workflow.yml" \
    && grep -qxF '  - uses: ok-owner/ok-action@3131313131313131313131313131313131313131 # v1.1.0' "$CASE21/assets/workflow.yml"; then
    pass "a failed ${failing} lookup exits 2, leaves that pin alone, and still bumps the other pin"
  else
    fail "expected exit 2 and an error for the failed ${failing} lookup, got exit ${case21_status}"
    cat "$TMP_ROOT/case21-$failing.log"
    cat "$CASE21/assets/workflow.yml"
  fi
done

# ---------------------------------------------------------------------
# Case 22: an action.yml that is absent (HTTP 404) is not a failure: the
# runtime is read from action.yaml instead, and the unversioned pin moves.
# ---------------------------------------------------------------------
CASE22="$TMP_ROOT/case22"
mkdir -p "$CASE22/assets" "$CASE22/fixtures"
make_fake_gh "$CASE22/fixtures"

cat > "$CASE22/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: yaml-owner/yaml-action@eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
YAML

cat > "$CASE22/fixtures/repos_yaml-owner_yaml-action_releases.json" <<JSON
[
  {"tag_name": "v1.1.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo 404 > "$CASE22/fixtures/repos_yaml-owner_yaml-action_contents_action.yml_ref_v1.1.0.status"
write_action_yml_fixture "$CASE22/fixtures/repos_yaml-owner_yaml-action_contents_action.yaml_ref_v1.1.0.json" node24
cat > "$CASE22/fixtures/repos_yaml-owner_yaml-action_git_ref_tags_v1.1.0.json" <<'JSON'
{"object": {"sha": "2626262626262626262626262626262626262626", "type": "commit"}}
JSON

run_bumper "$CASE22/assets" "$CASE22/fixtures" > "$TMP_ROOT/case22.log" 2>&1
case22_status=$?
if [ "$case22_status" -eq 0 ] \
  && grep -qxF '  - uses: yaml-owner/yaml-action@2626262626262626262626262626262626262626 # v1.1.0' "$CASE22/assets/workflow.yml"; then
  pass "an absent action.yml is not a failure; action.yaml's runtime is read instead"
else
  fail "expected exit 0 and a move to v1.1.0 read from action.yaml, got exit ${case22_status}"
  cat "$TMP_ROOT/case22.log"
  cat "$CASE22/assets/workflow.yml"
fi

if [ "$failures" -ne 0 ]; then
  echo "test-bump-asset-pins: ${failures} case(s) failed." >&2
  exit 1
fi

echo "test-bump-asset-pins: all cases passed."
