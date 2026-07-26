#!/usr/bin/env bash
#
# codeartifact-auth.sh
#
# Shell half of the `codeartifact-auth` composite action (issue #39).
#
# Installed at <repo-root>/.github/scripts/codeartifact-auth.sh, alongside
# its sibling action at
# <repo-root>/.github/actions/codeartifact-auth/action.yml. The action is
# thin YAML glue (parse -> OIDC role assumption -> configure); ALL of the
# logic worth testing lives here, so it can be exercised by
# test-codeartifact-auth.sh without a GitHub runner.
#
# WHY A COMPOSITE ACTION AND NOT A REUSABLE WORKFLOW: authentication has
# to happen between checkout and install INSIDE the caller's job. A
# reusable workflow (`workflow_call`) runs as its own job, so its
# credentials never reach the caller's steps.
#
# CONFIGURATION -- ONE VARIABLE, ORG DEFAULT WITH REPO OVERRIDE.
# `CODEARTIFACT_ROLE` is a GitHub Actions *variable* holding a single
# line: a CodeArtifact npm endpoint, whitespace, and the ARN of the IAM
# role that may read it.
#
#   my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/releases/  arn:aws:iam::111122223333:role/gh-actions-ca-releases-read
#
# Set it at ORGANIZATION level for the CodeArtifact repository most repos
# consume; set it at REPOSITORY level on a repo that consumes a different
# one. GitHub resolves a variable at the lowest level it is defined, so
# the repository value REPLACES the organization value -- the override is
# GitHub's own precedence, and there is deliberately no merge logic here.
# Unset at both levels means this script no-ops.
#
# Composite actions cannot read the `vars` context (a template validation
# error -- community discussions #49689 and #43878), which is why the
# value arrives as an action input and why the variable name is static.
#
# EXACTLY ONE ENDPOINT PER REPO. A value naming more than one endpoint is
# an ERROR, not a supported configuration. This is a constraint of the
# package managers, not a simplification of convenience: npm, pnpm, and
# yarn each resolve a package to exactly one registry -- the default
# `registry`, or `@scope:registry` when scoped -- with no fallback chain.
# Two CodeArtifact repositories holding the same npm scope therefore
# cannot both be consumed. CodeArtifact *upstream* relationships solve
# that at the CodeArtifact layer and are out of scope here.
#
# ARMING. A non-empty `CODEARTIFACT_ROLE` means the repo uses
# CodeArtifact; empty means no-op. Arming is deliberately NOT driven by
# scanning the tree for registry URLs: `.npmrc` is gitignored on repos
# whose developers mint tokens interactively, so the endpoint is
# frequently in no tracked file at all, and lockfile `resolved` URLs
# carry it only inconsistently across package managers.
#
# OPERATOR PREREQUISITES (provisioned in the target AWS account, not by
# this repo -- see docs/codeartifact-auth.md):
#   - the GitHub OIDC identity provider,
#   - a role with `ReadFromRepository` on the CodeArtifact repository,
#   - a trust policy naming the consuming GitHub repositories CONCRETELY
#     in its `sub` condition, never with a wildcard.
#
# NOTHING IS WRITTEN INTO THE WORKING TREE. The credential lives in
# JOB-SCOPED storage reached by ENVIRONMENT VARIABLE:
#
#   npm + pnpm  $RUNNER_TEMP/.npmrc, with NPM_CONFIG_USERCONFIG exported
#               through $GITHUB_ENV to point at it.
#   yarn Berry  YARN_NPM_REGISTRY_SERVER / YARN_NPM_AUTH_TOKEN in
#               $GITHUB_ENV, no file at all.
#
# WHY NOT THE REPO-ROOT `.npmrc` (the shape `aws codeartifact login`
# produces locally): npm resolves a project `.npmrc` relative to the
# NEAREST package directory and never walks up to the git root, and pnpm
# only walks up to a covering `pnpm-workspace.yaml`. `dependency-install-
# gate.sh` discovers lockfiles at ANY depth and installs with cwd set to
# each lockfile's OWN directory, and a lockfile below the repo root
# exists precisely when no workspace root covers it. So a repo-root file
# would be invisible to exactly the installs that need it -- a
# `frontend/` beside a Python service, an independent `infra/` CDK app,
# per-function Lambda manifests. Environment-reached job-scoped storage
# is the only shape where this script does not have to know or guess
# which directory the installer will `cd` into; it is also symmetric
# with how yarn Berry is already handled.
#
# WHY NOT `$HOME/.npmrc`: on a machine running more than one repo it
# pools every repo's token in one file that any repo's install reads --
# a cross-boundary credential hole, and the opposite of the
# endpoint-as-allowlist property this design rests on. `$RUNNER_TEMP` is
# created and wiped per job, so it does not have that problem.
#
# Subcommands:
#   parse      Read CODEARTIFACT_ROLE from the environment, validate it,
#              and emit the parsed fields as step outputs. Never calls
#              AWS and never writes credentials.
#   configure  Mint a domain-scoped CodeArtifact authorization token and
#              point npm/pnpm ($RUNNER_TEMP/.npmrc via
#              NPM_CONFIG_USERCONFIG) and yarn Berry ($GITHUB_ENV) at
#              the endpoint.
#
# Exit codes:
#   0 -- success (including the unconfigured no-op)
#   1 -- usage error, malformed configuration, or missing job-scoped
#        storage to write the credential into

set -euo pipefail

fatal() {
  echo "codeartifact-auth: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: codeartifact-auth.sh <parse|configure>

  parse      Validate CODEARTIFACT_ROLE and emit its parsed fields as
             GitHub Actions step outputs (or to stdout when
             GITHUB_OUTPUT is unset).
  configure  Mint a CodeArtifact token and configure npm/pnpm/yarn.
             Requires CA_HOST, CA_PATH, CA_REGISTRY, CA_DOMAIN,
             CA_DOMAIN_OWNER, and CA_REGION -- all emitted by `parse` --
             plus the runner's own RUNNER_TEMP and GITHUB_ENV.
EOF
  exit 1
}

# Emit a step output. Falls back to stdout when GITHUB_OUTPUT is unset so
# the script is directly runnable (and testable) outside a runner.
emit() {
  local key="$1" value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

# ---------------------------------------------------------------------
# parse
# ---------------------------------------------------------------------
#
# Parses CODEARTIFACT_ROLE into an endpoint and a role ARN, then parses
# the domain, domain-owner account, and region out of the endpoint HOST,
# which encodes all three:
#
#   <domain>-<owner-account>.d.codeartifact.<region>.amazonaws.com/npm/<repo>/
#
# Nothing is configured separately that the endpoint already carries.
cmd_parse() {
  local raw trimmed count endpoint role_arn host path
  raw="${CODEARTIFACT_ROLE:-}"

  # Strip surrounding whitespace from every line and drop blank ones, so
  # a variable that is set-but-blank (or padded by the GitHub UI) is
  # treated as unset rather than as a malformed entry.
  trimmed="$(
    printf '%s\n' "$raw" \
      | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
      | grep -v '^$' || true
  )"

  count=0
  if [ -n "$trimmed" ]; then
    count="$(printf '%s\n' "$trimmed" | wc -l | tr -d '[:space:]')"
  fi

  if [ "$count" -eq 0 ]; then
    echo "CODEARTIFACT_ROLE is unset or empty -- this repo does not use CodeArtifact; nothing to do."
    emit enabled false
    return 0
  fi

  if [ "$count" -gt 1 ]; then
    fatal "CODEARTIFACT_ROLE names ${count} endpoints, but exactly one is supported.
A repo resolves from one CodeArtifact repository at a time: npm, pnpm, and yarn
each resolve a package to exactly one registry, with no fallback chain. Use
CodeArtifact upstream relationships to reach a second repository, or set
CODEARTIFACT_ROLE at the repository level to override the organization value."
  fi

  # Exactly one line: split it on whitespace. Anything other than an
  # <endpoint> <role-arn> pair is malformed -- in particular, a second
  # pair crammed onto the same line is the same "more than one endpoint"
  # error as a second line.
  #
  # `set -f` disables pathname expansion for the duration of the split:
  # word splitting is wanted, globbing is NOT. Without it a value
  # containing a glob metacharacter (a bare `*` is the degenerate case)
  # would be expanded against the current directory, so the reported
  # field count and error message would describe the runner's filesystem
  # rather than what the operator typed.
  set -f
  # shellcheck disable=SC2086
  set -- $trimmed
  set +f
  if [ "$#" -gt 2 ]; then
    fatal "CODEARTIFACT_ROLE line has $# whitespace-separated fields; expected exactly two
(<endpoint> <role-arn>). A second endpoint/role pair is not a supported
configuration -- exactly one endpoint per repo."
  fi
  if [ "$#" -ne 2 ]; then
    fatal "CODEARTIFACT_ROLE must be '<endpoint> <role-arn>' but has $# field(s): '$trimmed'"
  fi

  endpoint="$1"
  role_arn="$2"

  # The scheme is optional -- accept the form `aws codeartifact login`
  # prints (no scheme) as well as a fully qualified URL.
  endpoint="${endpoint#https://}"
  endpoint="${endpoint#http://}"

  case "$endpoint" in
    */*) ;;
    *)
      fatal "CodeArtifact endpoint '$endpoint' has no path. It must include the repository
path, e.g. my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/releases/"
      ;;
  esac

  host="${endpoint%%/*}"
  path="/${endpoint#*/}"
  case "$path" in
    */) ;;
    *) path="$path/" ;;
  esac

  # The host encodes domain, domain-owner account, and region. The
  # leading group is greedy so a domain containing hyphens (e.g.
  # `my-domain-111122223333`) still splits at the ACCOUNT, not at the
  # first hyphen.
  if [[ ! "$host" =~ ^(.+)-([0-9]{12})\.d\.codeartifact\.([a-z0-9-]+)\.amazonaws\.com$ ]]; then
    fatal "CodeArtifact endpoint host '$host' is not of the form
<domain>-<owner-account>.d.codeartifact.<region>.amazonaws.com"
  fi
  local domain="${BASH_REMATCH[1]}"
  local domain_owner="${BASH_REMATCH[2]}"
  local region="${BASH_REMATCH[3]}"

  if [[ ! "$role_arn" =~ ^arn:aws[a-zA-Z0-9-]*:iam::[0-9]{12}:role/.+$ ]]; then
    fatal "'$role_arn' is not an IAM role ARN (expected arn:aws:iam::<account>:role/<name>)"
  fi

  echo "CodeArtifact endpoint: https://${host}${path}"
  echo "  domain=${domain} domain-owner=${domain_owner} region=${region}"
  echo "  role=${role_arn}"

  emit enabled true
  emit host "$host"
  emit path "$path"
  emit registry "https://${host}${path}"
  emit domain "$domain"
  emit domain_owner "$domain_owner"
  emit region "$region"
  emit role_arn "$role_arn"
}

# ---------------------------------------------------------------------
# configure
# ---------------------------------------------------------------------

# npm and pnpm are configured through a JOB-SCOPED npm USER config file
# in $RUNNER_TEMP, pointed at by NPM_CONFIG_USERCONFIG exported through
# $GITHUB_ENV. Nothing is written into the working tree.
#
# The user config is read regardless of the installer's working
# directory, which the repo-root project `.npmrc` is not: npm resolves a
# project `.npmrc` relative to the nearest package directory and never
# walks up to the git root, and pnpm only walks up to a covering
# `pnpm-workspace.yaml`. `dependency-install-gate.sh` installs from each
# discovered lockfile's OWN directory, so a repo-root file would miss
# every manifest that is not at the repo root. Verified against npm
# 11.6.2 and pnpm 11.15.0: with NPM_CONFIG_USERCONFIG set, both resolve
# the configured registry and its auth line from a nested manifest
# directory; with it unset, both fall back to registry.npmjs.org.
#
# The file's own path is left as `$RUNNER_TEMP/.npmrc` -- the same path
# `actions/setup-node` uses for its `registry-url` output -- so the two
# converge on one file rather than each pointing NPM_CONFIG_USERCONFIG
# at a different one and silently winning by step order.
#
# Only the lines THIS action owns are replaced: the bare `registry=` line
# and the `//<host><path>:` auth namespace for the configured endpoint.
# The rest of the file survives, including another registry's own
# `//<other-host>/:_authToken=` line -- stripping the whole `//`
# namespace would leave a repo's `@scope:registry=` line pointing at a
# host whose credential had just been deleted, i.e. a silent 401. Two
# runs in one job therefore replace the credential instead of stacking
# duplicates.
write_npmrc() {
  local host="$1" path="$2" registry="$3" token="$4"
  local npmrc="$RUNNER_TEMP/.npmrc" tmp
  # The scratch copy holds the token too, so it is built inside the same
  # job-scoped directory (mktemp gives it mode 600) rather than in a
  # shared TMPDIR -- which also makes the `mv` a same-filesystem rename.
  tmp="$(mktemp "$RUNNER_TEMP/.npmrc.XXXXXX")"
  if [ -f "$npmrc" ]; then
    # `index($0, prefix) == 1` is a literal prefix test, so neither the
    # host nor the path needs regex escaping.
    awk -v prefix="//${host}${path}:" '
      /^registry=/ { next }
      index($0, prefix) == 1 { next }
      { print }
    ' "$npmrc" > "$tmp" || true
  fi
  {
    printf 'registry=%s\n' "$registry"
    printf '//%s%s:_authToken=%s\n' "$host" "$path" "$token"
  } >> "$tmp"
  mv "$tmp" "$npmrc"
  chmod 600 "$npmrc"
  printf 'NPM_CONFIG_USERCONFIG=%s\n' "$npmrc" >> "$GITHUB_ENV"
  echo "Wrote CodeArtifact registry + auth token to $npmrc (mode 600) and"
  echo "exported NPM_CONFIG_USERCONFIG, so npm and pnpm read it from any"
  echo "working directory. Nothing was written into the working tree."
}

# yarn Berry accepts a YARN_ env override for most settings, so nothing is
# written to a file and nothing depends on runner directory layout. (The
# per-registry `npmRegistries` / `npmScopes` settings are OBJECTS, which
# env vars cannot express -- but with exactly one endpoint they are not
# needed.) A file was rejected on all three available paths: the project
# .yarnrc.yml is tracked (token-commit risk), a home-level file is not
# repo-local, and YARN_RC_FILENAME overrides the filename rather than the
# path, so a subdirectory is never consulted. The npm/pnpm path above is
# the same shape for the same reason.
write_yarn_env() {
  local registry="$1" token="$2"
  {
    printf 'YARN_NPM_REGISTRY_SERVER=%s\n' "$registry"
    printf 'YARN_NPM_AUTH_TOKEN=%s\n' "$token"
  } >> "$GITHUB_ENV"
  echo "Exported YARN_NPM_REGISTRY_SERVER and YARN_NPM_AUTH_TOKEN for yarn Berry."
}

cmd_configure() {
  local host="${CA_HOST:-}" path="${CA_PATH:-}" registry="${CA_REGISTRY:-}"
  local domain="${CA_DOMAIN:-}" domain_owner="${CA_DOMAIN_OWNER:-}"
  local region="${CA_REGION:-}"

  local missing=""
  [ -n "$host" ] || missing="$missing CA_HOST"
  [ -n "$path" ] || missing="$missing CA_PATH"
  [ -n "$registry" ] || missing="$missing CA_REGISTRY"
  [ -n "$domain" ] || missing="$missing CA_DOMAIN"
  [ -n "$domain_owner" ] || missing="$missing CA_DOMAIN_OWNER"
  [ -n "$region" ] || missing="$missing CA_REGION"
  if [ -n "$missing" ]; then
    fatal "missing required environment:$missing (all are emitted by the 'parse' subcommand)"
  fi

  # Assert BEFORE minting: if the token has nowhere job-scoped to live,
  # do not ask AWS for one. Both variables are set by the runner itself;
  # their absence means this is not running as a GitHub Actions step, and
  # the fallbacks are all worse than failing (the working tree would put
  # a credential where git can pick it up, $HOME would pool every repo's
  # token in one file that any repo's install reads).
  if [ -z "${RUNNER_TEMP:-}" ]; then
    fatal "RUNNER_TEMP is not set; there is no job-scoped directory to write the
npm credential into. This script must run as a GitHub Actions step."
  fi
  if [ ! -d "$RUNNER_TEMP" ]; then
    fatal "RUNNER_TEMP ('$RUNNER_TEMP') is not a directory."
  fi
  if [ -z "${GITHUB_ENV:-}" ]; then
    fatal "GITHUB_ENV is not set; cannot export the npm, pnpm, and yarn Berry
configuration to the steps that install."
  fi

  # The token is DOMAIN-scoped -- it takes no --repository argument -- so
  # per-repository restriction comes from the role's IAM policy, not from
  # the token.
  local token
  token="$(
    aws codeartifact get-authorization-token \
      --domain "$domain" \
      --domain-owner "$domain_owner" \
      --region "$region" \
      --query authorizationToken \
      --output text
  )" || fatal "aws codeartifact get-authorization-token failed for domain '$domain'."

  if [ -z "$token" ] || [ "$token" = "None" ]; then
    fatal "aws codeartifact get-authorization-token returned no token for domain '$domain'."
  fi

  # Mask before the token can reach any later log line.
  echo "::add-mask::$token"

  write_npmrc "$host" "$path" "$registry" "$token"
  write_yarn_env "$registry" "$token"
}

main() {
  [ "$#" -ge 1 ] || usage
  case "$1" in
    parse) cmd_parse ;;
    configure) cmd_configure ;;
    -h | --help) usage ;;
    *) fatal "unknown subcommand '$1' (expected 'parse' or 'configure')" ;;
  esac
}

main "$@"
