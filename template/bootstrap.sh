#!/usr/bin/env bash
#
# bootstrap.sh
#
# Places the gh-repo-config sweeper workflow at .github/workflows/sweep.yml
# so the org's first sweep tick has something to run, and does nothing
# else: it registers no GitHub App and sets no secret. Run it once, from
# a local clone of the org's sweeper repo, under your own `gh`
# authentication. From the first tick on, the converger owns the file.
#
# The file is copied verbatim from the release's assets/sweeper-sweep.yml.
# The converger renders that asset to the same path through its plain
# token substitution, and the asset carries no placeholder, so the copy
# is byte-identical to what the first sweep would write and that sweep
# opens no PR restating it. The placeholder guard below turns a future
# placeholder in the asset into a failure here instead of a silent
# mismatch.
#
# The release download and its attestation verify both need the network,
# so this script has no offline self-test.
#
# Usage:
#   ./bootstrap.sh
set -euo pipefail

readonly SOURCE_REPO="TheVoskamps/gh-repo-config"
readonly CONFIG_FILE="gh-repo-config.json"
readonly ASSET_PATH="assets/sweeper-sweep.yml"
readonly TARGET_PATH=".github/workflows/sweep.yml"

die() {
  echo "bootstrap.sh: $*" >&2
  exit 1
}

for tool in git gh jq tar; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: ${tool}"
done

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  die "the working tree is not clean; commit or stash your changes first"
fi

default_branch="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
current_branch="$(git branch --show-current)"
if [ "$current_branch" != "$default_branch" ]; then
  die "check out the default branch '${default_branch}' first (on '${current_branch:-detached HEAD}')"
fi

[ -f "$CONFIG_FILE" ] || die "${CONFIG_FILE} is missing from the repo root"

# `// empty` reads an absent or null pin as an empty string, which means
# the latest release.
tag="$(jq -r '."version-pin" // empty' "$CONFIG_FILE")"
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
  git checkout HEAD -- "$TARGET_PATH" 2>/dev/null || rm -f "$TARGET_PATH"
  die "${ASSET_PATH} in ${tag} carries a placeholder token; a verbatim copy would not match what the converger renders"
fi

git add "$TARGET_PATH"
if git diff --cached --quiet; then
  echo "${TARGET_PATH} already matches ${tag}; nothing to commit."
  exit 0
fi
git commit -m "Add the gh-repo-config sweeper workflow from ${tag}"
# A fresh template copy carries no ruleset, so a direct push to the
# default branch is accepted.
git push origin "$default_branch"
