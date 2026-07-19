#!/usr/bin/env bash
#
# test-dependency-pinned-gate.sh
#
# Self-test for .github/scripts/dependency-pinned-gate.sh. Builds
# throwaway per-ecosystem fixtures under a temp git repo and asserts the
# classifier's verdicts:
#
#   - A clean (strict-pinned) fixture per mode  -> exit 0 (green).
#   - A poisoned fixture per mode               -> exit 1 (red):
#       npm caret, pip `>=`, action `@v4`, docker `:latest`, go floating
#       `replace`.
#   - The categorical-exempt cases stay GREEN: npm peerDependencies
#     caret, pip `requires-python` range, docker `tag@sha256:` digest,
#     npm override-VALUE-exact-with-caret-KEY, docker `FROM scratch`,
#     docker `--platform`-flagged stage reference, npm
#     `owner/repo#<40-hex>` commit pin.
#   - The git-shorthand FLOATS go RED: a bare npm `owner/repo` and a
#     `owner/repo#<branch>` ref (neither is an immutable commit pin).
#   - The lockfile-present check goes RED: a deps-declaring package.json
#     with no lockfile beside it.
#
# The gate discovers manifests via `git ls-files`, so each fixture lives
# in its own throwaway git repo with the relevant files committed.
#
# Exit codes:
#   0 -- all cases pass
#   1 -- any case fails
#
# bash 3.2 compatible (runs on macOS).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/dependency-pinned-gate.sh"

if [ ! -f "$GATE" ]; then
  echo "FAIL: gate script not found at $GATE" >&2
  exit 1
fi

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t dependency-pinned-gate)
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

# run_case <name> <expected_exit> <repo-dir> <mode>
run_case() {
  local name="$1" expected="$2" repo="$3" mode="$4"
  local out actual
  out=$(cd "$repo" && bash "$GATE" "$mode" 2>&1)
  actual=$?
  if [ "$actual" = "$expected" ]; then
    pass=$((pass + 1))
    echo "PASS [$name] (exit $actual)"
  else
    fail=$((fail + 1))
    echo "FAIL [$name] expected exit $expected, got $actual"
    echo "----- gate output -----"
    echo "$out"
    echo "-----------------------"
  fi
}

writef() {
  # writef <path> -- read content from stdin.
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

# =====================================================================
# npm
# =====================================================================

# Clean: exact deps + a lockfile beside the manifest.
R="$TMP/npm-clean"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "clean",
  "dependencies": { "left-pad": "1.3.0" },
  "devDependencies": { "jest": "29.7.0" }
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "clean", "lockfileVersion": 3 }
JSON
commit_all "$R"
run_case "npm: clean exact + lockfile" 0 "$R" npm

# Poisoned: a caret spec.
R="$TMP/npm-caret"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "caret",
  "dependencies": { "aws-cdk-lib": "^2.172.0" }
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "caret", "lockfileVersion": 3 }
JSON
commit_all "$R"
run_case "npm: caret dep (poisoned)" 1 "$R" npm

# Exempt: peerDependencies caret is legitimate (ranges by design).
R="$TMP/npm-peer"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "peer",
  "peerDependencies": { "aws-cdk-lib": "^2.172.0" }
}
JSON
commit_all "$R"
run_case "npm: peerDependencies caret (exempt)" 0 "$R" npm

# Exempt: overrides classify on the VALUE (exact) not the KEY (caret).
R="$TMP/npm-override"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "override",
  "dependencies": { "vite": "6.4.2" },
  "overrides": { "vite@^6.0.0": "6.4.2" }
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "override", "lockfileVersion": 3 }
JSON
commit_all "$R"
run_case "npm: override key caret / value exact (exempt)" 0 "$R" npm

# Exempt: file:/workspace:/git+ protocol specs have no registry version.
R="$TMP/npm-protocol"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "protocol",
  "dependencies": { "local-lib": "file:../local-lib", "shared": "workspace:*" }
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "protocol", "lockfileVersion": 3 }
JSON
commit_all "$R"
run_case "npm: file:/workspace: protocol specs (exempt)" 0 "$R" npm

# Red: a bare `owner/repo` git-shorthand floats to the default-branch
# HEAD -- it has no immutable pin, so it must be flagged.
R="$TMP/npm-shorthand-bare"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "shorthand-bare",
  "dependencies": { "left-pad": "user/repo" }
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "shorthand-bare", "lockfileVersion": 3 }
JSON
commit_all "$R"
run_case "npm: bare owner/repo shorthand floats (red)" 1 "$R" npm

# Exempt: a `owner/repo#<40-hex-sha>` git-shorthand is commit-pinned and
# therefore immutable -- it stays green.
R="$TMP/npm-shorthand-sha"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "shorthand-sha",
  "dependencies": { "left-pad": "user/repo#0123456789abcdef0123456789abcdef01234567" }
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "shorthand-sha", "lockfileVersion": 3 }
JSON
commit_all "$R"
run_case "npm: owner/repo#<40-hex> commit pin (exempt)" 0 "$R" npm

# Red: a `owner/repo#<branch>` ref still floats (a branch/tag is not an
# immutable commit SHA).
R="$TMP/npm-shorthand-branch"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "shorthand-branch",
  "dependencies": { "left-pad": "user/repo#main" }
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "shorthand-branch", "lockfileVersion": 3 }
JSON
commit_all "$R"
run_case "npm: owner/repo#main branch ref floats (red)" 1 "$R" npm

# Red: deps declared but NO lockfile beside the manifest.
R="$TMP/npm-nolock"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "nolock",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
commit_all "$R"
run_case "npm: exact deps but no lockfile (red)" 1 "$R" npm

# Green: pnpm workspace member with only a root pnpm-lock.yaml (no
# sibling lockfile) -- the false-positive case from issue #170.
R="$TMP/npm-pnpm-workspace"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "root",
  "private": true
}
JSON
writef "$R/pnpm-workspace.yaml" <<'YAML'
packages:
  - 'src'
  - 'packages/*'
YAML
writef "$R/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'
YAML
writef "$R/packages/contracts/package.json" <<'JSON'
{
  "name": "contracts",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
writef "$R/src/package.json" <<'JSON'
{
  "name": "src-pkg",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
commit_all "$R"
run_case "npm: pnpm workspace member, root lockfile only (green)" 0 "$R" npm

# Green: npm/yarn `workspaces` field member with only a root lockfile.
R="$TMP/npm-workspaces-field"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "root",
  "private": true,
  "workspaces": ["packages/*"]
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "root", "lockfileVersion": 3 }
JSON
writef "$R/packages/foo/package.json" <<'JSON'
{
  "name": "foo",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
commit_all "$R"
run_case "npm: workspaces-field member, root lockfile only (green)" 0 "$R" npm

# Red (regression guard): a nested manifest with deps and NO lockfile
# anywhere in its ancestry, and NOT covered by any workspace glob --
# the true positive the check exists for must still fail.
R="$TMP/npm-stray-nested"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "root",
  "private": true,
  "workspaces": ["packages/*"]
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "root", "lockfileVersion": 3 }
JSON
writef "$R/apps/standalone/package.json" <<'JSON'
{
  "name": "standalone",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
commit_all "$R"
run_case "npm: stray nested manifest outside workspace globs (red)" 1 "$R" npm

# Red (regression guard): `packages/*` is a single-star glob and must
# match only a DIRECT child -- a manifest nested one level deeper than
# the glob allows is NOT covered and must still fail.
R="$TMP/npm-single-star-too-deep"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "root",
  "private": true,
  "workspaces": ["packages/*"]
}
JSON
writef "$R/package-lock.json" <<'JSON'
{ "name": "root", "lockfileVersion": 3 }
JSON
writef "$R/packages/deep/nested/package.json" <<'JSON'
{
  "name": "deep-nested",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
commit_all "$R"
run_case "npm: packages/* single-star doesn't cross depth (red)" 1 "$R" npm

# Green: `packages/**` double-star DOES cover arbitrary depth.
R="$TMP/npm-double-star-deep"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "root",
  "private": true
}
JSON
writef "$R/pnpm-workspace.yaml" <<'YAML'
packages:
  - 'packages/**'
YAML
writef "$R/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'
YAML
writef "$R/packages/deep/nested/package.json" <<'JSON'
{
  "name": "deep-nested",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
commit_all "$R"
run_case "npm: packages/** double-star covers any depth (green)" 0 "$R" npm

# Red (regression guard): a negated glob excludes regardless of where it
# appears in the list (pnpm/fast-glob ignore semantics are
# order-independent). With the negation listed BEFORE the positive glob,
# the excluded manifest must NOT count as workspace-covered -- it floats
# with no lockfile anywhere it can claim, so the gate must fail. A
# last-match-wins matcher would wrongly pass this green.
R="$TMP/npm-negation-first"; git_init_repo "$R"
writef "$R/package.json" <<'JSON'
{
  "name": "root",
  "private": true
}
JSON
writef "$R/pnpm-workspace.yaml" <<'YAML'
packages:
  - '!packages/excluded'
  - 'packages/*'
YAML
writef "$R/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'
YAML
writef "$R/packages/excluded/package.json" <<'JSON'
{
  "name": "excluded",
  "dependencies": { "left-pad": "1.3.0" }
}
JSON
commit_all "$R"
run_case "npm: negation before positive glob still excludes (red)" 1 "$R" npm

# =====================================================================
# pip
# =====================================================================

# Clean: requirements with == and a pyproject with == deps + a
# requires-python floor (exempt).
R="$TMP/pip-clean"; git_init_repo "$R"
writef "$R/requirements.txt" <<'TXT'
# a comment
boto3==1.40.0
requests==2.32.3
-r other.txt
TXT
writef "$R/other.txt" <<'TXT'
urllib3==2.2.2
TXT
writef "$R/pyproject.toml" <<'TOML'
[project]
name = "clean"
requires-python = ">=3.11"
dependencies = ["click==8.1.7"]
TOML
commit_all "$R"
run_case "pip: clean == + requires-python floor (exempt)" 0 "$R" pip

# Poisoned: a >= comparator in requirements.
R="$TMP/pip-ge"; git_init_repo "$R"
writef "$R/requirements.txt" <<'TXT'
boto3>=1.40
TXT
commit_all "$R"
run_case "pip: >= comparator (poisoned)" 1 "$R" pip

# Poisoned: a non-exact dep in pyproject.
R="$TMP/pip-pyproject"; git_init_repo "$R"
writef "$R/pyproject.toml" <<'TOML'
[project]
name = "loose"
requires-python = ">=3.11"
dependencies = ["click>=8.0"]
TOML
commit_all "$R"
run_case "pip: pyproject >= dep (poisoned)" 1 "$R" pip

# =====================================================================
# actions
# =====================================================================

# Clean: SHA-pinned with a trailing # vX.Y.Z comment + a local ref.
R="$TMP/actions-clean"; git_init_repo "$R"
writef "$R/.github/workflows/ci.yml" <<'YML'
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: ./.github/actions/local-thing
YML
commit_all "$R"
run_case "actions: SHA-pinned + local ref (clean)" 0 "$R" actions

# Poisoned: a floating @v4 tag.
R="$TMP/actions-float"; git_init_repo "$R"
writef "$R/.github/workflows/ci.yml" <<'YML'
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
YML
commit_all "$R"
run_case "actions: floating @v4 (poisoned)" 1 "$R" actions

# =====================================================================
# docker
# =====================================================================

# Clean: tag@sha256: digest (the tag floats but the digest is exact).
R="$TMP/docker-clean"; git_init_repo "$R"
writef "$R/Dockerfile" <<'DOCKER'
FROM node:22@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS build
RUN echo hi
FROM build
RUN echo bye
DOCKER
commit_all "$R"
run_case "docker: tag@sha256 digest + stage ref (clean)" 0 "$R" docker

# Exempt: `FROM scratch` -- the reserved empty base image cannot be
# digest-pinned and is special-cased green.
R="$TMP/docker-scratch"; git_init_repo "$R"
writef "$R/Dockerfile" <<'DOCKER'
FROM scratch
COPY hello /hello
DOCKER
commit_all "$R"
run_case "docker: FROM scratch reserved base (exempt)" 0 "$R" docker

# Exempt: a `--platform`-flagged FROM names a stage, so a later
# `FROM <stage>` is a stage reference, not a floating image. Regression
# guard: the first (stage-collection) pass must skip the leading --flag
# to record the `AS builder` stage name.
R="$TMP/docker-platform-stage"; git_init_repo "$R"
writef "$R/Dockerfile" <<'DOCKER'
FROM --platform=$BUILDPLATFORM node:22@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS builder
RUN echo build
FROM builder
RUN echo final
DOCKER
commit_all "$R"
run_case "docker: --platform stage + later FROM stage (clean)" 0 "$R" docker

# Poisoned: a :latest tag with no digest.
R="$TMP/docker-latest"; git_init_repo "$R"
writef "$R/Dockerfile" <<'DOCKER'
FROM node:latest
DOCKER
commit_all "$R"
run_case "docker: :latest tag (poisoned)" 1 "$R" docker

# Poisoned: tag-only, no digest.
R="$TMP/docker-tagonly"; git_init_repo "$R"
writef "$R/Dockerfile" <<'DOCKER'
FROM python:3.11
DOCKER
commit_all "$R"
run_case "docker: tag-only no digest (poisoned)" 1 "$R" docker

# =====================================================================
# go
# =====================================================================

# Clean: exact require versions, no floating replace.
R="$TMP/go-clean"; git_init_repo "$R"
writef "$R/go.mod" <<'GOMOD'
module example.com/clean

go 1.26.3

require mvdan.cc/sh/v3 v3.13.1

replace example.com/old => example.com/new v1.2.3
GOMOD
commit_all "$R"
run_case "go: exact require + exact replace (clean)" 0 "$R" go

# Clean: a local-path replace has no version (exempt).
R="$TMP/go-localreplace"; git_init_repo "$R"
writef "$R/go.mod" <<'GOMOD'
module example.com/local

go 1.26.3

require mvdan.cc/sh/v3 v3.13.1

replace example.com/old => ../local-fork
GOMOD
commit_all "$R"
run_case "go: local-path replace (exempt)" 0 "$R" go

# Poisoned: a floating `replace ... => ... latest`.
R="$TMP/go-float"; git_init_repo "$R"
writef "$R/go.mod" <<'GOMOD'
module example.com/float

go 1.26.3

require mvdan.cc/sh/v3 v3.13.1

replace example.com/old => example.com/new latest
GOMOD
commit_all "$R"
run_case "go: floating replace => latest (poisoned)" 1 "$R" go

# =====================================================================
# no-manifests-green per mode
# =====================================================================
R="$TMP/empty"; git_init_repo "$R"
writef "$R/README.md" <<'MD'
# empty
MD
commit_all "$R"
run_case "npm: no manifests (green)" 0 "$R" npm
run_case "pip: no manifests (green)" 0 "$R" pip
run_case "actions: no manifests (green)" 0 "$R" actions
run_case "docker: no manifests (green)" 0 "$R" docker
run_case "go: no manifests (green)" 0 "$R" go

# =====================================================================
# Summary
# =====================================================================
echo ""
echo "Results: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
