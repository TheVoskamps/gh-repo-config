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
# of `/`, `?`, `&`, `=` with `_`; a missing fixture serves `[]`.
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
if [ -f "$fixture" ]; then
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

if [ "$failures" -ne 0 ]; then
  echo "test-bump-asset-pins: ${failures} case(s) failed." >&2
  exit 1
fi

echo "test-bump-asset-pins: all cases passed."
