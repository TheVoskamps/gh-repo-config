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
#   3. copies gh-repo-config.example.json to gh-repo-config.json and
#      commits it with `git add -f`, since the template's .gitignore
#      ignores that name. Once tracked, the ignore rule no longer applies
#      to it, and because the template never tracks it, no template merge
#      touches the org's copy;
#   4. pushes the default branch to `origin`, leaving a clean tree on the
#      default branch for bootstrap.sh.
#
# It registers no GitHub App, sets no secret, and does not run
# bootstrap.sh. Every step calls the network, so this script has no
# offline self-test.
#
# Usage:
#   bash consumer-init.sh [-n repo-name] [-o owner]
#
#   -n  the GitHub repo name, which is also the local directory it is
#       cloned into (default: gh-repo-config-sweeper)
#   -o  the repo owner (default: the authenticated `gh` user)
set -euo pipefail

readonly TEMPLATE_REPO="TheVoskamps/gh-repo-config-sweeper-template"
readonly UPSTREAM_URL="https://github.com/${TEMPLATE_REPO}.git"
readonly CONFIG_FILE="gh-repo-config.json"
readonly EXAMPLE_FILE="gh-repo-config.example.json"

die() {
  echo "consumer-init.sh: $*" >&2
  exit 1
}

usage() {
  echo "usage: consumer-init.sh [-n repo-name] [-o owner]" >&2
  exit 2
}

name="gh-repo-config-sweeper"
owner=""
while getopts ":n:o:" opt; do
  case "$opt" in
    n) name="$OPTARG" ;;
    o) owner="$OPTARG" ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ "$#" -eq 0 ] || usage
[ -n "$name" ] || usage

# Checked before anything else, so a refusal leaves no repo behind.
if [ -e "$name" ]; then
  die "./${name} already exists; nothing was created"
fi

for tool in git gh; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: ${tool}"
done

if [ -z "$owner" ]; then
  owner="$(gh api user --jq .login)"
fi

gh repo create "${owner}/${name}" --template "$TEMPLATE_REPO" --private --clone
cd "$name"

default_branch="$(git branch --show-current)"
[ -n "$default_branch" ] || die "the clone of ${owner}/${name} has no branch checked out"

git remote add upstream "$UPSTREAM_URL"
git fetch upstream
git merge --no-edit --allow-unrelated-histories upstream/main

[ -f "$EXAMPLE_FILE" ] || die "${EXAMPLE_FILE} is missing from the template"
cp "$EXAMPLE_FILE" "$CONFIG_FILE"
git add -f "$CONFIG_FILE"
git commit -m "Add ${CONFIG_FILE} from ${EXAMPLE_FILE}"

git push origin "$default_branch"

echo "Created ${owner}/${name} in ./${name}. Edit and commit ${CONFIG_FILE} there as needed, then run ./bootstrap.sh."
