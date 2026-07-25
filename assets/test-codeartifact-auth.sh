#!/usr/bin/env bash
#
# test-codeartifact-auth.sh
#
# Self-test for .github/scripts/codeartifact-auth.sh. Runs the script's
# `parse` and `configure` subcommands against throwaway git repos under a
# temp dir, with a stub `aws` on PATH, so no AWS call and no GitHub runner
# is needed.
#
# Cases:
#   parse
#     (a) CODEARTIFACT_ROLE unset          -- exit 0, enabled=false, no AWS call
#     (b) CODEARTIFACT_ROLE blank/whitespace -- exit 0, enabled=false
#     (c) one valid entry                  -- domain/owner/region/registry parsed
#     (d) https:// prefixed endpoint       -- same parse result as (c)
#     (e) endpoint with no trailing slash  -- path normalised to end in /
#     (f) domain containing hyphens        -- split at the ACCOUNT, not the hyphen
#     (g) two lines                        -- fail: more than one endpoint
#     (h) two pairs on one line            -- fail: more than one endpoint
#     (i) non-CodeArtifact host            -- fail
#     (j) endpoint with no path            -- fail
#     (k) malformed role ARN               -- fail
#   configure
#     (l) .npmrc gitignored and untracked  -- writes .npmrc + yarn env
#     (m) .npmrc TRACKED                   -- fail, write nothing, no AWS call
#     (n) .npmrc not gitignored            -- fail, write nothing, no AWS call
#     (o) run twice                        -- idempotent, unrelated lines kept
#
# Exit codes:
#   0 -- all cases pass
#   1 -- any case fails

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH="$SCRIPT_DIR/codeartifact-auth.sh"

if [ ! -x "$AUTH" ]; then
  echo "FAIL: codeartifact-auth.sh not executable at $AUTH" >&2
  exit 1
fi

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t codeartifact-auth)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

STUB_TOKEN="stub-codeartifact-token-value"

# A stub `aws` on PATH: records that it was called, and prints the token
# for `codeartifact get-authorization-token`. Keeps the test off the
# network and out of any real AWS account.
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/aws" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "\${AWS_STUB_CALLS:-/dev/null}"
printf '%s\n' "$STUB_TOKEN"
EOF
chmod +x "$STUB_BIN/aws"
PATH="$STUB_BIN:$PATH"
export PATH

ok() {
  pass=$((pass + 1))
  echo "PASS [$1]"
}

bad() {
  fail=$((fail + 1))
  echo "FAIL [$1] $2"
}

# Run `parse` with the given CODEARTIFACT_ROLE. Sets PARSE_STATUS,
# PARSE_OUT (the emitted key=value lines) and PARSE_LOG (stdout+stderr).
run_parse() {
  local value="$1" outfile logfile
  outfile="$(mktemp "$TMP/out.XXXXXX")"
  logfile="$(mktemp "$TMP/log.XXXXXX")"
  AWS_STUB_CALLS="$TMP/aws-calls-parse.log" \
  CODEARTIFACT_ROLE="$value" \
  GITHUB_OUTPUT="$outfile" \
    bash "$AUTH" parse > "$logfile" 2>&1
  PARSE_STATUS=$?
  PARSE_OUT="$(cat "$outfile")"
  PARSE_LOG="$(cat "$logfile")"
}

# Value of a single emitted step output, or the empty string.
parsed() {
  printf '%s\n' "$PARSE_OUT" | sed -n "s/^$1=//p"
}

assert_parsed() {
  local case_name="$1" key="$2" want="$3" got
  got="$(parsed "$key")"
  if [ "$got" = "$want" ]; then
    ok "$case_name: $key=$want"
  else
    bad "$case_name" "expected $key='$want', got '$got'"
  fi
}

# Build a throwaway git repo. `$2` = gitignore contents (may be empty).
git_init_repo() {
  local dir="$1" ignore="${2:-}"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test User"
  git -C "$dir" config commit.gpgsign false
  if [ -n "$ignore" ]; then
    printf '%s\n' "$ignore" > "$dir/.gitignore"
  else
    : > "$dir/.gitignore"
  fi
  git -C "$dir" add .gitignore
  git -C "$dir" commit -q -m "init"
}

# Run `configure` inside `$1`. Sets CONF_STATUS, CONF_LOG, CONF_ENV_FILE.
run_configure() {
  local dir="$1" logfile
  logfile="$(mktemp "$TMP/conflog.XXXXXX")"
  CONF_ENV_FILE="$dir/github-env"
  : > "$CONF_ENV_FILE"
  (
    cd "$dir" || exit 1
    AWS_STUB_CALLS="$dir/aws-calls.log" \
    GITHUB_ENV="$CONF_ENV_FILE" \
    CA_HOST="my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com" \
    CA_PATH="/npm/releases/" \
    CA_REGISTRY="https://my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/releases/" \
    CA_DOMAIN="my_domain" \
    CA_DOMAIN_OWNER="111122223333" \
    CA_REGION="us-west-2" \
      bash "$AUTH" configure
  ) > "$logfile" 2>&1
  CONF_STATUS=$?
  CONF_LOG="$(cat "$logfile")"
}

expect_status() {
  local case_name="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    ok "$case_name: exit $got"
  else
    bad "$case_name" "expected exit $want, got $got"
  fi
}

expect_match() {
  local case_name="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) ok "$case_name: mentions '$needle'" ;;
    *) bad "$case_name" "expected output to mention '$needle'; got: $haystack" ;;
  esac
}

VALID_HOST="my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com"
VALID_ARN="arn:aws:iam::111122223333:role/gh-actions-ca-releases-read"

# ---------------------------------------------------------------
# (a) Unset -> no-op
# ---------------------------------------------------------------
rm -f "$TMP/aws-calls-parse.log"
run_parse ""
expect_status "a: unset" 0 "$PARSE_STATUS"
assert_parsed "a: unset" enabled false
if [ ! -s "$TMP/aws-calls-parse.log" ]; then
  ok "a: unset makes no AWS call"
else
  bad "a: unset" "the aws stub was invoked: $(cat "$TMP/aws-calls-parse.log")"
fi
if [ "$(printf '%s\n' "$PARSE_OUT" | grep -c .)" = "1" ]; then
  ok "a: unset emits only 'enabled'"
else
  bad "a: unset" "expected a single output line, got: $PARSE_OUT"
fi

# ---------------------------------------------------------------
# (b) Blank / whitespace-only -> no-op
# ---------------------------------------------------------------
run_parse "

"
expect_status "b: whitespace only" 0 "$PARSE_STATUS"
assert_parsed "b: whitespace only" enabled false

# ---------------------------------------------------------------
# (c) One valid entry
# ---------------------------------------------------------------
run_parse "$VALID_HOST/npm/releases/  $VALID_ARN"
expect_status "c: one entry" 0 "$PARSE_STATUS"
assert_parsed "c: one entry" enabled true
assert_parsed "c: one entry" host "$VALID_HOST"
assert_parsed "c: one entry" path "/npm/releases/"
assert_parsed "c: one entry" registry "https://$VALID_HOST/npm/releases/"
assert_parsed "c: one entry" domain "my_domain"
assert_parsed "c: one entry" domain_owner "111122223333"
assert_parsed "c: one entry" region "us-west-2"
assert_parsed "c: one entry" role_arn "$VALID_ARN"

# ---------------------------------------------------------------
# (d) https:// prefixed endpoint parses identically
# ---------------------------------------------------------------
run_parse "https://$VALID_HOST/npm/releases/ $VALID_ARN"
expect_status "d: https:// prefix" 0 "$PARSE_STATUS"
assert_parsed "d: https:// prefix" host "$VALID_HOST"
assert_parsed "d: https:// prefix" registry "https://$VALID_HOST/npm/releases/"

# ---------------------------------------------------------------
# (e) Missing trailing slash is normalised
# ---------------------------------------------------------------
run_parse "$VALID_HOST/npm/releases $VALID_ARN"
expect_status "e: no trailing slash" 0 "$PARSE_STATUS"
assert_parsed "e: no trailing slash" path "/npm/releases/"

# ---------------------------------------------------------------
# (f) Domain containing hyphens splits at the ACCOUNT
# ---------------------------------------------------------------
run_parse "my-shared-domain-111122223333.d.codeartifact.eu-west-1.amazonaws.com/npm/releases/ $VALID_ARN"
expect_status "f: hyphenated domain" 0 "$PARSE_STATUS"
assert_parsed "f: hyphenated domain" domain "my-shared-domain"
assert_parsed "f: hyphenated domain" domain_owner "111122223333"
assert_parsed "f: hyphenated domain" region "eu-west-1"

# ---------------------------------------------------------------
# (g) Two lines -> more than one endpoint
# ---------------------------------------------------------------
run_parse "$VALID_HOST/npm/releases/ $VALID_ARN
$VALID_HOST/npm/candidates/ $VALID_ARN"
expect_status "g: two lines" 1 "$PARSE_STATUS"
expect_match "g: two lines" "$PARSE_LOG" "names 2 endpoints"

# ---------------------------------------------------------------
# (h) Two pairs on one line -> more than one endpoint
# ---------------------------------------------------------------
run_parse "$VALID_HOST/npm/releases/ $VALID_ARN $VALID_HOST/npm/candidates/ $VALID_ARN"
expect_status "h: two pairs on one line" 1 "$PARSE_STATUS"
expect_match "h: two pairs on one line" "$PARSE_LOG" "exactly one endpoint per repo"

# ---------------------------------------------------------------
# (i) Non-CodeArtifact host
# ---------------------------------------------------------------
run_parse "registry.npmjs.org/npm/releases/ $VALID_ARN"
expect_status "i: non-codeartifact host" 1 "$PARSE_STATUS"
expect_match "i: non-codeartifact host" "$PARSE_LOG" "is not of the form"

# ---------------------------------------------------------------
# (j) Endpoint with no path
# ---------------------------------------------------------------
run_parse "$VALID_HOST $VALID_ARN"
expect_status "j: no path" 1 "$PARSE_STATUS"
expect_match "j: no path" "$PARSE_LOG" "has no path"

# ---------------------------------------------------------------
# (k) Malformed role ARN
# ---------------------------------------------------------------
run_parse "$VALID_HOST/npm/releases/ not-an-arn"
expect_status "k: bad role arn" 1 "$PARSE_STATUS"
expect_match "k: bad role arn" "$PARSE_LOG" "is not an IAM role ARN"

# ---------------------------------------------------------------
# (l) configure: .npmrc gitignored and untracked
# ---------------------------------------------------------------
REPO_L="$TMP/repo-l"
git_init_repo "$REPO_L" ".npmrc"
run_configure "$REPO_L"
expect_status "l: safe .npmrc" 0 "$CONF_STATUS"
if [ -f "$REPO_L/.npmrc" ]; then
  ok "l: safe .npmrc: file written"
  expect_match "l: safe .npmrc" "$(cat "$REPO_L/.npmrc")" \
    "registry=https://$VALID_HOST/npm/releases/"
  expect_match "l: safe .npmrc" "$(cat "$REPO_L/.npmrc")" \
    "//$VALID_HOST/npm/releases/:_authToken=$STUB_TOKEN"
else
  bad "l: safe .npmrc" ".npmrc was not written"
fi
expect_match "l: safe .npmrc yarn env" "$(cat "$CONF_ENV_FILE")" \
  "YARN_NPM_REGISTRY_SERVER=https://$VALID_HOST/npm/releases/"
expect_match "l: safe .npmrc yarn env" "$(cat "$CONF_ENV_FILE")" \
  "YARN_NPM_AUTH_TOKEN=$STUB_TOKEN"
expect_match "l: safe .npmrc masks the token" "$CONF_LOG" "::add-mask::$STUB_TOKEN"
expect_match "l: safe .npmrc token is domain-scoped" "$(cat "$REPO_L/aws-calls.log")" \
  "get-authorization-token --domain my_domain --domain-owner 111122223333"
if grep -q -- "--repository" "$REPO_L/aws-calls.log"; then
  bad "l: safe .npmrc" "the token request passed --repository; it is domain-scoped"
else
  ok "l: safe .npmrc: token request passes no --repository"
fi

# ---------------------------------------------------------------
# (m) configure: .npmrc is TRACKED -> refuse
# ---------------------------------------------------------------
REPO_M="$TMP/repo-m"
git_init_repo "$REPO_M" ".npmrc"
printf 'some-setting=1\n' > "$REPO_M/.npmrc"
git -C "$REPO_M" add -f .npmrc
git -C "$REPO_M" commit -q -m "track .npmrc"
run_configure "$REPO_M"
expect_status "m: tracked .npmrc" 1 "$CONF_STATUS"
expect_match "m: tracked .npmrc" "$CONF_LOG" "TRACKED by git"
if [ "$(cat "$REPO_M/.npmrc")" = "some-setting=1" ]; then
  ok "m: tracked .npmrc: left untouched"
else
  bad "m: tracked .npmrc" ".npmrc was modified: $(cat "$REPO_M/.npmrc")"
fi
if [ ! -s "$REPO_M/aws-calls.log" ]; then
  ok "m: tracked .npmrc: no AWS call"
else
  bad "m: tracked .npmrc" "the aws stub was invoked before the safety check"
fi

# ---------------------------------------------------------------
# (n) configure: .npmrc not gitignored -> refuse
# ---------------------------------------------------------------
REPO_N="$TMP/repo-n"
git_init_repo "$REPO_N" "node_modules/"
run_configure "$REPO_N"
expect_status "n: unignored .npmrc" 1 "$CONF_STATUS"
expect_match "n: unignored .npmrc" "$CONF_LOG" "not gitignored"
if [ ! -e "$REPO_N/.npmrc" ]; then
  ok "n: unignored .npmrc: nothing written"
else
  bad "n: unignored .npmrc" ".npmrc was created anyway"
fi
if [ ! -s "$REPO_N/aws-calls.log" ]; then
  ok "n: unignored .npmrc: no AWS call"
else
  bad "n: unignored .npmrc" "the aws stub was invoked before the safety check"
fi

# ---------------------------------------------------------------
# (o) configure twice: idempotent, unrelated settings preserved
# ---------------------------------------------------------------
REPO_O="$TMP/repo-o"
git_init_repo "$REPO_O" ".npmrc"
printf 'ignore-scripts=true\n' > "$REPO_O/.npmrc"
run_configure "$REPO_O"
run_configure "$REPO_O"
expect_status "o: second run" 0 "$CONF_STATUS"
o_registry_lines="$(grep -c '^registry=' "$REPO_O/.npmrc")"
o_token_lines="$(grep -c '_authToken=' "$REPO_O/.npmrc")"
if [ "$o_registry_lines" = "1" ] && [ "$o_token_lines" = "1" ]; then
  ok "o: second run: no duplicated registry/auth lines"
else
  bad "o: second run" "expected 1 registry and 1 auth line, got $o_registry_lines / $o_token_lines"
fi
if grep -q '^ignore-scripts=true$' "$REPO_O/.npmrc"; then
  ok "o: second run: unrelated settings preserved"
else
  bad "o: second run" "an unrelated .npmrc setting was dropped"
fi

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo "Results: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
