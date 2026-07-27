#!/usr/bin/env bash
#
# test-bump-asset-pins.sh
#
# Self-test for scripts/bump-asset-pins.sh. Fully OFFLINE: stubs `gh`
# with a fake script on PATH that serves canned `releases` /
# `advisories` / `git/ref/tags` / `git/tags` JSON fixtures instead of
# hitting the network, so the policy decision logic (soak, security
# bypass, semver-major gate) is exercised deterministically.
#
# Cases (mirroring the issue's acceptance criteria):
#   1. A release >= 7 days old is selected over a newer release still
#      inside the 7-day soak window.
#   2. A security release is selected regardless of age (even one
#      published today).
#   3. A semver-major bump is applied for github/codeql-action/* (the
#      one named group whose patterns match a GitHub Action).
#   4. A semver-major bump is REFUSED for an action outside the named
#      groups.
#   5. aws-actions/configure-aws-credentials (no rendered counterpart
#      anywhere) is covered like any other pin -- not special-cased.
#   6. SHA and trailing version comment stay in sync after a rewrite.
#   7. No eligible bump -> no file changes at all.
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
# Case 3: semver-major bump IS applied for github/codeql-action/* (the
# one named Dependabot group whose patterns match a GitHub Action).
# ---------------------------------------------------------------------
CASE3="$TMP_ROOT/case3"
mkdir -p "$CASE3/assets" "$CASE3/fixtures"
make_fake_gh "$CASE3/fixtures"

cat > "$CASE3/assets/codeql.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: github/codeql-action/init@8aad20d150bbac5944a9f9d289da16a4b0d87c1e # v4.36.2
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
  pass "semver-major bump IS applied for github/codeql-action/* (named group)"
else
  fail "expected github/codeql-action major bump to v5.0.0 to be applied"
  cat "$TMP_ROOT/case3.log"
  cat "$CASE3/assets/codeql.yml"
fi

# ---------------------------------------------------------------------
# Case 4: semver-major bump is REFUSED for an action outside the named
# groups (e.g. actions/checkout).
# ---------------------------------------------------------------------
CASE4="$TMP_ROOT/case4"
mkdir -p "$CASE4/assets" "$CASE4/fixtures"
make_fake_gh "$CASE4/fixtures"

cat > "$CASE4/assets/workflow.yml" <<'YAML'
on:
  pull_request:
steps:
  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
YAML

cat > "$CASE4/fixtures/repos_actions_checkout_releases.json" <<JSON
[
  {"tag_name": "v7.0.0", "published_at": "$(iso_days_ago 30)", "draft": false, "prerelease": false}
]
JSON
echo '[]' > "$CASE4/fixtures/advisories_ecosystem_actions_affects_actions_checkout.json"

before_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE4/assets/workflow.yml','rb').read()).hexdigest())")"
run_bumper "$CASE4/assets" "$CASE4/fixtures" > "$TMP_ROOT/case4.log" 2>&1
after_hash="$(python3 -c "import hashlib; print(hashlib.sha256(open('$CASE4/assets/workflow.yml','rb').read()).hexdigest())")"

if [ "$before_hash" = "$after_hash" ]; then
  pass "semver-major bump is REFUSED for actions/checkout (not a named group)"
else
  fail "expected actions/checkout major bump to be refused, but file changed"
  cat "$TMP_ROOT/case4.log"
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
    - uses: aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c # v6.2.3
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

if [ "$failures" -ne 0 ]; then
  echo "test-bump-asset-pins: ${failures} case(s) failed." >&2
  exit 1
fi

echo "test-bump-asset-pins: all cases passed."
