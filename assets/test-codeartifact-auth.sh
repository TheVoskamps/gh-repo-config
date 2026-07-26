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
#     (l) value containing a glob          -- field count is the operator's,
#                                             not the working directory's
#   configure
#     (m) happy path                       -- writes $RUNNER_TEMP/.npmrc, exports
#                                             NPM_CONFIG_USERCONFIG + yarn env,
#                                             and writes NOTHING into the tree
#     (n) nested manifest                  -- run from a subdirectory reaches the
#                                             same credential (the whole point of
#                                             the job-scoped file)
#     (o) RUNNER_TEMP unset                -- fail, write nothing, no AWS call
#     (p) GITHUB_ENV unset                 -- fail, write nothing, no AWS call
#     (q) run twice                        -- idempotent, unrelated lines kept,
#                                             ANOTHER registry's credential kept
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

# Run `configure` with cwd `$1` and RUNNER_TEMP `$2`. Sets CONF_STATUS,
# CONF_LOG, CONF_ENV_FILE and CONF_NPMRC. A third argument of `no-env`
# runs with GITHUB_ENV unset, and a RUNNER_TEMP of `-` runs with
# RUNNER_TEMP unset.
run_configure() {
  local dir="$1" runner_temp="$2" mode="${3:-}" logfile
  logfile="$(mktemp "$TMP/conflog.XXXXXX")"
  CONF_ENV_FILE="$dir/github-env"
  : > "$CONF_ENV_FILE"
  CONF_NPMRC="$runner_temp/.npmrc"
  (
    cd "$dir" || exit 1
    export AWS_STUB_CALLS="$dir/aws-calls.log"
    export CA_HOST="my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com"
    export CA_PATH="/npm/releases/"
    export CA_REGISTRY="https://my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/releases/"
    export CA_DOMAIN="my_domain"
    export CA_DOMAIN_OWNER="111122223333"
    export CA_REGION="us-west-2"
    if [ "$runner_temp" = "-" ]; then
      unset RUNNER_TEMP
    else
      export RUNNER_TEMP="$runner_temp"
    fi
    if [ "$mode" = "no-env" ]; then
      unset GITHUB_ENV
    else
      export GITHUB_ENV="$CONF_ENV_FILE"
    fi
    bash "$AUTH" configure
  ) > "$logfile" 2>&1
  CONF_STATUS=$?
  CONF_LOG="$(cat "$logfile")"
}

# A throwaway job-scoped RUNNER_TEMP.
new_runner_temp() {
  local dir="$TMP/runner-temp-$1"
  mkdir -p "$dir"
  printf '%s' "$dir"
}

# Assert that `configure` left the working tree alone. The whole safety
# property of the job-scoped design is structural: there is no in-tree
# path to write, so there is nothing to assert about gitignore state.
expect_clean_tree() {
  local case_name="$1" dir="$2" dirty
  dirty="$(git -C "$dir" status --porcelain --ignored 2>/dev/null | grep -v 'github-env\|aws-calls.log' || true)"
  if [ -z "$dirty" ]; then
    ok "$case_name: nothing written into the working tree"
  else
    bad "$case_name" "the working tree gained: $dirty"
  fi
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
# (l) A glob metacharacter is word-split, never pathname-expanded, so
#     the reported field count describes the operator's value and not
#     the contents of whatever directory the step happened to run in.
# ---------------------------------------------------------------
GLOB_DIR="$TMP/glob-dir"
mkdir -p "$GLOB_DIR"
touch "$GLOB_DIR/one" "$GLOB_DIR/two" "$GLOB_DIR/three"
(
  cd "$GLOB_DIR" || exit 1
  CODEARTIFACT_ROLE='*' bash "$AUTH" parse
) > "$TMP/glob.log" 2>&1
GLOB_STATUS=$?
GLOB_LOG="$(cat "$TMP/glob.log")"
expect_status "l: glob value" 1 "$GLOB_STATUS"
expect_match "l: glob value" "$GLOB_LOG" "has 1 field(s)"

# ---------------------------------------------------------------
# (m) configure: happy path -- job-scoped file, exported env, and an
#     untouched working tree
# ---------------------------------------------------------------
REPO_M="$TMP/repo-m"
RT_M="$(new_runner_temp m)"
git_init_repo "$REPO_M" "node_modules/"
run_configure "$REPO_M" "$RT_M"
expect_status "m: happy path" 0 "$CONF_STATUS"
if [ -f "$CONF_NPMRC" ]; then
  ok "m: happy path: \$RUNNER_TEMP/.npmrc written"
  expect_match "m: happy path" "$(cat "$CONF_NPMRC")" \
    "registry=https://$VALID_HOST/npm/releases/"
  expect_match "m: happy path" "$(cat "$CONF_NPMRC")" \
    "//$VALID_HOST/npm/releases/:_authToken=$STUB_TOKEN"
else
  bad "m: happy path" "\$RUNNER_TEMP/.npmrc was not written"
fi
expect_match "m: happy path npm env" "$(cat "$CONF_ENV_FILE")" \
  "NPM_CONFIG_USERCONFIG=$RT_M/.npmrc"
expect_match "m: happy path yarn env" "$(cat "$CONF_ENV_FILE")" \
  "YARN_NPM_REGISTRY_SERVER=https://$VALID_HOST/npm/releases/"
expect_match "m: happy path yarn env" "$(cat "$CONF_ENV_FILE")" \
  "YARN_NPM_AUTH_TOKEN=$STUB_TOKEN"
expect_match "m: happy path masks the token" "$CONF_LOG" "::add-mask::$STUB_TOKEN"
expect_match "m: happy path token is domain-scoped" "$(cat "$REPO_M/aws-calls.log")" \
  "get-authorization-token --domain my_domain --domain-owner 111122223333"
if grep -q -- "--repository" "$REPO_M/aws-calls.log"; then
  bad "m: happy path" "the token request passed --repository; it is domain-scoped"
else
  ok "m: happy path: token request passes no --repository"
fi
expect_clean_tree "m: happy path" "$REPO_M"

# ---------------------------------------------------------------
# (n) configure from a NESTED manifest directory -- the shape
#     dependency-install-gate.sh actually installs from. The credential
#     must reach it, and still nothing may land in the tree. This is the
#     case a repo-root .npmrc silently failed.
# ---------------------------------------------------------------
REPO_N="$TMP/repo-n"
RT_N="$(new_runner_temp n)"
git_init_repo "$REPO_N" "node_modules/"
mkdir -p "$REPO_N/services/api"
printf '{}\n' > "$REPO_N/services/api/package.json"
git -C "$REPO_N" add services/api/package.json
git -C "$REPO_N" commit -q -m "nested manifest"
run_configure "$REPO_N/services/api" "$RT_N"
expect_status "n: nested manifest dir" 0 "$CONF_STATUS"
if [ -f "$RT_N/.npmrc" ]; then
  ok "n: nested manifest dir: credential lands in \$RUNNER_TEMP, not beside the manifest"
else
  bad "n: nested manifest dir" "\$RUNNER_TEMP/.npmrc was not written"
fi
if [ -e "$REPO_N/services/api/.npmrc" ] || [ -e "$REPO_N/.npmrc" ]; then
  bad "n: nested manifest dir" "an .npmrc was written into the working tree"
else
  ok "n: nested manifest dir: no .npmrc anywhere in the working tree"
fi
expect_match "n: nested manifest dir" "$(cat "$CONF_ENV_FILE")" \
  "NPM_CONFIG_USERCONFIG=$RT_N/.npmrc"

# ---------------------------------------------------------------
# (o) configure: RUNNER_TEMP unset -> refuse before minting
# ---------------------------------------------------------------
REPO_O="$TMP/repo-o"
git_init_repo "$REPO_O" "node_modules/"
run_configure "$REPO_O" "-"
expect_status "o: no RUNNER_TEMP" 1 "$CONF_STATUS"
expect_match "o: no RUNNER_TEMP" "$CONF_LOG" "RUNNER_TEMP is not set"
if [ ! -s "$REPO_O/aws-calls.log" ]; then
  ok "o: no RUNNER_TEMP: no AWS call"
else
  bad "o: no RUNNER_TEMP" "the aws stub was invoked before the precondition check"
fi
expect_clean_tree "o: no RUNNER_TEMP" "$REPO_O"

# ---------------------------------------------------------------
# (p) configure: GITHUB_ENV unset -> refuse before minting
# ---------------------------------------------------------------
REPO_P="$TMP/repo-p"
RT_P="$(new_runner_temp p)"
git_init_repo "$REPO_P" "node_modules/"
run_configure "$REPO_P" "$RT_P" no-env
expect_status "p: no GITHUB_ENV" 1 "$CONF_STATUS"
expect_match "p: no GITHUB_ENV" "$CONF_LOG" "GITHUB_ENV is not set"
if [ ! -e "$RT_P/.npmrc" ]; then
  ok "p: no GITHUB_ENV: nothing written"
else
  bad "p: no GITHUB_ENV" "\$RUNNER_TEMP/.npmrc was written anyway"
fi
if [ ! -s "$REPO_P/aws-calls.log" ]; then
  ok "p: no GITHUB_ENV: no AWS call"
else
  bad "p: no GITHUB_ENV" "the aws stub was invoked before the precondition check"
fi

# ---------------------------------------------------------------
# (q) configure twice: idempotent, unrelated settings preserved, and
#     ANOTHER registry's credential survives. Stripping the whole `//`
#     namespace would leave a surviving `@scope:registry=` line pointing
#     at a host whose auth token had just been deleted -- a silent 401.
# ---------------------------------------------------------------
REPO_Q="$TMP/repo-q"
RT_Q="$(new_runner_temp q)"
git_init_repo "$REPO_Q" "node_modules/"
cat > "$RT_Q/.npmrc" <<'EOF'
ignore-scripts=true
@myorg:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=gh-packages-token
EOF
run_configure "$REPO_Q" "$RT_Q"
run_configure "$REPO_Q" "$RT_Q"
expect_status "q: second run" 0 "$CONF_STATUS"
q_registry_lines="$(grep -c '^registry=' "$RT_Q/.npmrc")"
q_token_lines="$(grep -c "^//$VALID_HOST" "$RT_Q/.npmrc")"
if [ "$q_registry_lines" = "1" ] && [ "$q_token_lines" = "1" ]; then
  ok "q: second run: no duplicated registry/auth lines"
else
  bad "q: second run" "expected 1 registry and 1 auth line, got $q_registry_lines / $q_token_lines"
fi
if grep -q '^ignore-scripts=true$' "$RT_Q/.npmrc"; then
  ok "q: second run: unrelated settings preserved"
else
  bad "q: second run" "an unrelated .npmrc setting was dropped"
fi
if grep -q '^@myorg:registry=https://npm.pkg.github.com/$' "$RT_Q/.npmrc" \
  && grep -q '^//npm.pkg.github.com/:_authToken=gh-packages-token$' "$RT_Q/.npmrc"; then
  ok "q: second run: an unrelated registry keeps BOTH its lines"
else
  bad "q: second run" "an unrelated registry's credential was dropped: $(cat "$RT_Q/.npmrc")"
fi
q_env_lines="$(grep -c '^NPM_CONFIG_USERCONFIG=' "$CONF_ENV_FILE")"
if [ "$q_env_lines" = "1" ]; then
  ok "q: second run: one NPM_CONFIG_USERCONFIG export per run"
else
  bad "q: second run" "expected 1 NPM_CONFIG_USERCONFIG line, got $q_env_lines"
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
