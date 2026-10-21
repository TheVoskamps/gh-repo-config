#!/usr/bin/env bash
#
# sync-upstream.sh
#
# Merges the sweeper template's changes into this sweeper repo: fetches
# the `upstream` remote that consumer-init.sh added and merges
# `upstream/main` into the default branch, then stops. Pushing the merge
# is your next step. The template never tracks gh-repo-config.json, so a
# template merge leaves the org's copy alone.
#
# It refuses, changing nothing, unless refs/remotes/origin/HEAD is set,
# an `upstream` remote exists, tracked files carry no uncommitted change,
# and the default branch is checked out. After the fetch it refuses to
# merge when the default branch shares no history with upstream/main.
#
# The fetch calls the network, so this script has no offline self-test.
#
# Usage:
#   ./scripts/sync-upstream.sh
set -euo pipefail

die() {
  echo "sync-upstream.sh: $*" >&2
  exit 1
}

[ "$#" -eq 0 ] || die "takes no arguments"

command -v git >/dev/null 2>&1 || die "required tool not found: git"

cd "$(git rev-parse --show-toplevel)"

if ! origin_head="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD)"; then
  die "refs/remotes/origin/HEAD is unset; run 'git remote set-head origin -a' and retry"
fi
default_branch="${origin_head#origin/}"

if ! git remote get-url upstream >/dev/null 2>&1; then
  die "this clone has no 'upstream' remote; consumer-init.sh sets a sweeper repo up with one"
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "tracked files have uncommitted changes; commit or stash them first"
fi

current_branch="$(git branch --show-current)"
if [ "$current_branch" != "$default_branch" ]; then
  die "check out the default branch '${default_branch}' first (on '${current_branch:-detached HEAD}')"
fi

git fetch upstream
if ! git merge-base HEAD upstream/main >/dev/null; then
  die "${default_branch} shares no history with upstream/main; consumer-init.sh makes the one merge that gives it a merge base"
fi
if ! git merge --no-edit upstream/main; then
  die "the merge stopped; resolve the conflicts and commit, or run 'git merge --abort'"
fi

echo "Merged upstream/main into ${default_branch}. Review it, then run: git push origin ${default_branch}"
