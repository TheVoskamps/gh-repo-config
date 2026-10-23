#!/usr/bin/env bash
#
# consumer-init.sh
#
# Creates an org's private sweeper repo from the public sweeper template
# and initializes it, in one run, under your own `gh` authentication:
#
#   1. creates <owner>/<name> from the template, private, and clones it
#      into ./<name>;
#   2. adds the template as the `upstream` remote and merges
#      `upstream/main` with --allow-unrelated-histories. A repo created
#      from a template shares no history with it, and this one merge
#      gives every later template merge (scripts/sync-upstream.sh) a
#      merge base. Both trees are identical here, so it cannot conflict;
#   3. copies gh-repo-config.example.json to gh-repo-config.json, writes
#      the -p tag into it as `version-pin` when one was given, and commits
#      it with `git add -f`, since the template's .gitignore ignores that
#      name. Once tracked, the ignore rule no longer applies to it, and
#      because the template never tracks it, no template merge touches
#      the org's copy;
#   4. pushes the default branch to `origin`;
#   5. places the sweep workflow: downloads the converger release (the -p
#      tag, else the latest release of TheVoskamps/gh-repo-config),
#      verifies its attestation before unpacking anything, copies the
#      release's assets/sweeper-sweep.yml to .github/workflows/sweep.yml,
#      commits it and pushes the default branch. The converger renders
#      that asset to the same path through its plain token substitution,
#      and the asset carries no placeholder, so the copy is byte-identical
#      to what the first sweep would write and that sweep opens no PR
#      restating it. The placeholder guard turns a future placeholder in
#      the asset into a failure here instead of a silent mismatch. From
#      the first tick on, the converger owns the file;
#   6. disables the sweep workflow, so no tick runs before the Apps,
#      secrets and custom properties it needs are in place.
#
# It registers no GitHub App and sets no secret. Every step but 3 calls
# the network, and step 3 runs in the clone step 1 makes, so this script
# has no offline self-test.
#
# Usage:
#   bash consumer-init.sh [-n repo-name] [-o owner] [-p tag]
#
#   -n  the GitHub repo name, which is also the local directory it is
#       cloned into (default: gh-repo-config-sweeper)
#   -o  the repo owner (default: the authenticated `gh` user)
#   -p  the converger release tag to pin, of the form vX.Y.Z (default:
#       no pin; the sweep workflow is taken from the latest release)
set -euo pipefail

readonly TEMPLATE_REPO="TheVoskamps/gh-repo-config-sweeper-template"
readonly UPSTREAM_URL="https://github.com/${TEMPLATE_REPO}.git"
readonly SOURCE_REPO="TheVoskamps/gh-repo-config"
readonly CONFIG_FILE="gh-repo-config.json"
readonly EXAMPLE_FILE="gh-repo-config.example.json"
readonly ASSET_PATH="assets/sweeper-sweep.yml"
readonly WORKFLOW="sweep.yml"
readonly TARGET_PATH=".github/workflows/${WORKFLOW}"
readonly LIST_TIMEOUT=60

die() {
  echo "consumer-init.sh: $*" >&2
  exit 1
}

usage() {
  echo "usage: consumer-init.sh [-n repo-name] [-o owner] [-p tag]" >&2
  exit 2
}

name="gh-repo-config-sweeper"
owner=""
pin=""
while getopts ":n:o:p:" opt; do
  case "$opt" in
    n) name="$OPTARG" ;;
    o) owner="$OPTARG" ;;
    p) pin="$OPTARG" ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ "$#" -eq 0 ] || usage
[ -n "$name" ] || usage

# Checked before anything else, so a refusal leaves no repo behind.
if [ -n "$pin" ] && ! [[ "$pin" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "-p takes a release tag of the form vX.Y.Z, got '${pin}'; nothing was created"
fi

if [ -e "$name" ]; then
  die "./${name} already exists; nothing was created"
fi

for tool in git gh jq tar; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: ${tool}"
done

if [ -z "$owner" ]; then
  owner="$(gh api user --jq .login)"
fi
repo="${owner}/${name}"

gh repo create "$repo" --template "$TEMPLATE_REPO" --private --clone
cd "$name"

default_branch="$(git branch --show-current)"
[ -n "$default_branch" ] || die "the clone of ${repo} has no branch checked out"

git remote add upstream "$UPSTREAM_URL"
git fetch upstream
git merge --no-edit --allow-unrelated-histories upstream/main

[ -f "$EXAMPLE_FILE" ] || die "${EXAMPLE_FILE} is missing from the template"
if [ -n "$pin" ]; then
  jq --arg pin "$pin" '."version-pin" = $pin' "$EXAMPLE_FILE" >"$CONFIG_FILE"
else
  cp "$EXAMPLE_FILE" "$CONFIG_FILE"
fi
git add -f "$CONFIG_FILE"
git commit -m "Add ${CONFIG_FILE} from ${EXAMPLE_FILE}"

git push origin "$default_branch"

tag="$pin"
if [ -z "$tag" ]; then
  tag="$(gh release view --repo "$SOURCE_REPO" --json tagName --jq .tagName)"
fi
echo "Converger release: ${tag}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

gh release download "$tag" --repo "$SOURCE_REPO" \
  --pattern 'gh-repo-config-*.tgz' --dir "$work"
# Exactly one tarball must match: with two, which one is verified and
# which one unpacked would be ambiguous.
shopt -s nullglob
tarballs=("$work"/gh-repo-config-*.tgz)
shopt -u nullglob
if [ "${#tarballs[@]}" -ne 1 ]; then
  die "expected exactly 1 release tarball in ${tag}, found ${#tarballs[@]}"
fi
tarball="${tarballs[0]}"

# Nothing from the tarball is unpacked before this verify passes.
gh attestation verify "$tarball" --repo "$SOURCE_REPO"

mkdir -p "$work/unpacked"
tar -xzf "$tarball" -C "$work/unpacked"
[ -f "$work/unpacked/$ASSET_PATH" ] || die "${ASSET_PATH} is missing from ${tag}"

mkdir -p "$(dirname "$TARGET_PATH")"
cp "$work/unpacked/$ASSET_PATH" "$TARGET_PATH"

# The converger's unresolved-placeholder pattern. A match means the
# converger would render this path differently from the verbatim copy.
if grep -Eq '__[A-Z0-9_]+__' "$TARGET_PATH"; then
  rm -f "$TARGET_PATH"
  die "${ASSET_PATH} in ${tag} carries a placeholder token; a verbatim copy would not match what the converger renders"
fi

git add "$TARGET_PATH"
git commit -m "Add the gh-repo-config sweeper workflow from ${tag}"
# A fresh template copy carries no ruleset, so a direct push to the
# default branch is accepted.
git push origin "$default_branch"

# GitHub lists a newly pushed workflow only after a delay, and
# `gh workflow disable` fails on a workflow it does not list yet.
deadline=$((SECONDS + LIST_TIMEOUT))
until gh workflow view "$WORKFLOW" --repo "$repo" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    die "GitHub did not list ${TARGET_PATH} within ${LIST_TIMEOUT} seconds; disable it by hand: gh workflow disable ${WORKFLOW} --repo ${repo}"
  fi
  sleep 5
done
gh workflow disable "$WORKFLOW" --repo "$repo" ||
  die "disabling ${WORKFLOW} failed; disable it by hand: gh workflow disable ${WORKFLOW} --repo ${repo}"

echo "Created ${repo} in ./${name} with ${TARGET_PATH} from ${tag}, disabled."
echo "Set up the Apps, secrets and custom properties, then run: gh workflow enable ${WORKFLOW} --repo ${repo}"
