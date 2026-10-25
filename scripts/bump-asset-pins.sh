#!/usr/bin/env bash
#
# bump-asset-pins.sh
#
# REPO-OWN script (issue #60) installed at <repo-root>/scripts/, NOT
# .github/scripts/ -- .github/scripts/ is sweep-rendered payload
# territory (the converger overwrites it from assets/ on every tick), so
# a repo-own script placed there would be destroyed on the next sweep.
#
# Keeps every `uses: <owner>/<repo>[/<path>]@<sha>[ # v<ver>]` pin in
# assets/*.yml current under the policy below. Its security, soak, and
# semver-major rules are the ones the rendered `github-actions`
# Dependabot ecosystem applies on every managed repo (see
# renderEcosystemBlock in src/converge/render.ts, which renders
# assets/ecosystem-block.yml once per ecosystem); its rules for pins
# without a full version comment are this script's own:
#
#   - A release that fixes a security advisory affecting the current pin
#     -- the pin's version is inside the advisory's vulnerable range --
#     is taken IMMEDIATELY, bypassing the soak (Dependabot's own cooldown
#     applies to version updates only; security updates bypass it).
#   - Every other release must be at least 7 days old
#     (cooldown: default-days: 7 on the github-actions block).
#   - A semver-MAJOR release is a candidate for every action, under the
#     same two rules: the rendered github-actions block carries no
#     semver-major `ignore:` entry, since an action's major is mostly a
#     runtime move (Node.js 20 to 24) and skipping it leaves the pin on a
#     deprecated runtime.
#   - A pin whose trailing comment is not a full `# vX.Y.Z` (none, or
#     `# v4`) has no current version, so no advisory can be shown to
#     affect it and the security bypass does not apply. It moves to the
#     latest release at least 7 days old whose action.yml declares, in
#     `runs.using`, node24 or later or a runtime that is not `node*`,
#     and gains that release's `# vX.Y.Z` comment. A release whose
#     `runs.using` cannot be read is never selected.
#   - A bare occurrence of a SHA that another occurrence pins with a
#     `# vX.Y.Z` comment follows that versioned pin: it moves with it
#     when a release is selected, and otherwise keeps its SHA and gains
#     the versioned pin's comment.
#
# WHY assets/*.yml AND NOT .github/workflows/*.yml: Dependabot's
# `github-actions` ecosystem can only scan `.github/workflows/` (plus a
# root `action.yml`), so it has no way to reach these templates -- see
# the "Problem" section of issue #60. This script is what keeps the
# TEMPLATES current; Dependabot (via the rendered dependabot.yml) keeps
# every managed repo's rendered COPIES current.
#
# WHAT THIS SCRIPT DOES: discovers pins, resolves each owner/repo's
# eligible upstream release via the GitHub API (through `gh api`, all
# READ-ONLY calls -- repos/*/releases, advisories, contents,
# git/ref/tags, git/tags), and rewrites the SHA and the trailing
# `# vX.Y.Z` comment in place, adding the comment where the pin had
# none, everywhere that pin occurs across assets/*.yml. It does NOT
# create a branch, commit, push, or open a PR -- that git/PR plumbing
# lives in the calling workflow (.github/workflows/assets-pin-bump.yml),
# which only proceeds to commit when this script actually changed
# something (`git status --porcelain` is non-empty). No SHA to move and
# no comment to add -> no changed files -> no branch, no PR.
#
# Because every call this script makes is read-only, the CALLER can run
# it with nothing more than the ambient github.token (contents: read).
# A write-capable App token is still required, but only by the
# workflow's later commit/push/PR step -- a PR opened with the default
# GITHUB_TOKEN does not trigger `pull_request` workflows, so ci.yml and
# pin-shape.yml would never run on the bumper's own PRs. See
# assets-pin-bump.yml's own Auth block for the full rationale and why
# that token is deliberately kept out of this script's invocation.
#
# Usage:
#   bump-asset-pins.sh [assets-dir]
#
# assets-dir defaults to <repo-root>/assets (the script's own parent's
# sibling); overridable so the self-test can point at a throwaway
# fixture directory instead of mutating the real assets/ tree.
#
# Requires: gh (authenticated via GITHUB_TOKEN / GH_TOKEN), python3, jq.
#
# Exit codes:
#   0 -- every pin resolved (with or without any pin rewritten)
#   1 -- usage / environment error
#   2 -- reading the pins, or resolving or rewriting at least one pin,
#        failed; every other pin is still resolved and rewritten
#
# bash 3.2 compatible (no `mapfile`) so the script and its self-test run
# on macOS too.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="${1:-${SCRIPT_DIR}/../assets}"

if [ ! -d "$ASSETS_DIR" ]; then
  echo "bump-asset-pins: no such directory: ${ASSETS_DIR}" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "bump-asset-pins: 'gh' CLI not found on PATH." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "bump-asset-pins: 'python3' not found on PATH." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "bump-asset-pins: 'jq' not found on PATH." >&2
  exit 1
fi

# is_workflow_or_action_shaped <file> -> exit 0 when the file has a
# top-level `on:` key (workflow) or a top-level `runs:` key (composite
# action). Mirrors check-pin-shape.sh's exclusion of
# assets/codeql-config.yml, whose `queries: - uses: security-extended`
# is a CodeQL query-suite name, not an action pin. The optional quotes
# in the pattern accept the common `"on":` spelling (used to sidestep
# YAML 1.1's `on` -> `true` boolean coercion) as well as the bare form
# -- a file using that spelling would otherwise be silently skipped,
# leaving its pins entirely unbumped.
is_workflow_or_action_shaped() {
  grep -qE '^"?(on|runs)"?:' "$1"
}

shopt -s nullglob
manifests=("$ASSETS_DIR"/*.yml "$ASSETS_DIR"/*.yaml)
shopt -u nullglob

scan_targets=()
for m in "${manifests[@]}"; do
  if is_workflow_or_action_shaped "$m"; then
    scan_targets+=("$m")
  fi
done

if [ "${#scan_targets[@]}" -eq 0 ]; then
  echo "bump-asset-pins: no workflow/action-shaped files found under ${ASSETS_DIR} -- nothing to do."
  exit 0
fi

# The Python regex a pin's trailing comment must match to give the pin a
# current version, passed on argv to discover_pins and to the rewrite in
# the main loop. Only a full vX.Y.Z matches: a partial one (`# v4`,
# `# v4.1`) leaves the pin unversioned, so it takes the unversioned path,
# runtime check included, and gains a full comment.
FULL_VERSION_RE='#\s*(v[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.\-]*)\s*$'

# ---------------------------------------------------------------------
# Step 1: discover every distinct `owner/repo[/subpath]@<40-hex-sha>`
# pin across the scan targets, deduped by owner/repo/subpath/sha. Prints
# one `owner<TAB>repo<TAB>subpath-or-empty<TAB>sha<TAB>version<TAB>bare`
# line per distinct pin. `version` is the first `# vX.Y.Z` comment any
# occurrence of the pin carries, so a versioned occurrence seeds the
# comparison wherever it sits in the scan order; `bare` is `1` when some
# occurrence carries no such comment. Every occurrence of the same
# owner/repo/subpath/sha is rewritten together in the main loop
# regardless of which file it came from.
# ---------------------------------------------------------------------
discover_pins() {
  python3 - "$FULL_VERSION_RE" "${scan_targets[@]}" <<'PY'
import re, sys

USES_RE = re.compile(r'^\s*-?\s*uses:\s*(\S+)')
SHA_RE = re.compile(r'^[0-9a-fA-F]{40}$')
VER_RE = re.compile(sys.argv[1])

seen = {}
for path in sys.argv[2:]:
    with open(path) as f:
        for raw in f:
            m = USES_RE.match(raw)
            if not m:
                continue
            value = m.group(1).strip('\'"')
            if value.startswith("./") or value.startswith("../") or value.startswith("docker://"):
                continue
            if "@" not in value:
                continue
            ref_part, sha = value.rsplit("@", 1)
            if not SHA_RE.match(sha):
                continue
            parts = ref_part.split("/", 2)
            if len(parts) < 2:
                continue
            owner, repo = parts[0], parts[1]
            subpath = parts[2] if len(parts) > 2 else ""
            vm = VER_RE.search(raw)
            version = vm.group(1) if vm else ""
            key = (owner, repo, subpath, sha)
            seen_version, bare = seen.get(key, ("", False))
            seen[key] = (seen_version or version, bare or not version)

for (owner, repo, subpath, sha), (version, bare) in seen.items():
    # Empty fields are rendered as a literal "-" sentinel, not an empty
    # string: bash's `read` collapses a run of consecutive IFS
    # whitespace characters (tab is whitespace-class) into a single
    # delimiter even with a single-character IFS, which would otherwise
    # silently swallow an empty subpath/version/bare field and shift every
    # later column left by one.
    subpath_out = subpath if subpath else "-"
    version_out = version if version else "-"
    bare_out = "1" if bare else "-"
    print(f"{owner}\t{repo}\t{subpath_out}\t{sha}\t{version_out}\t{bare_out}")
PY
}

# ---------------------------------------------------------------------
# Step 2: for one owner/repo/current-version, resolve the eligible
# upstream releases per policy. With a current version, emits the one
# best eligible tag on stdout. With none (an unversioned pin), emits
# every release at least 7 days old, newest first, one tag per line, for
# the main loop to check each one's runtime in turn. Emits nothing when
# the current pin is already current or no eligible release exists, and
# returns non-zero when a lookup fails, so a failure is never read as
# "no eligible release". Every network call in this script goes through `gh api`, so the
# self-test can stub `gh` on PATH and exercise the pure decision logic
# underneath.
# ---------------------------------------------------------------------
resolve_bump() {
  local owner="$1" repo="$2" subpath="$3" current_version="$4"

  # Write gh api's output STRAIGHT TO DISK (redirect, never captured
  # into a shell variable and re-interpolated) -- a large action like
  # github/codeql-action can have enough --paginate'd release history
  # that passing it as a jq CLI argument (--argjson) overflows
  # ARG_MAX ("Argument list too long"), so the payloads are combined
  # via --slurpfile below instead, which reads each file's own content
  # directly.
  local releases_file advisories_file
  releases_file="$(mktemp)" || return 1
  advisories_file="$(mktemp)" || { rm -f "$releases_file"; return 1; }

  if ! gh api "repos/${owner}/${repo}/releases" --paginate >"$releases_file"; then
    echo "  error: could not list releases for ${owner}/${repo}" >&2
    rm -f "$releases_file" "$advisories_file"
    return 1
  fi

  # An action with no advisory gets an empty list, not an error, so a
  # failed lookup is never read as "no advisory": that would put a
  # vulnerable pin's fix behind the soak.
  if ! gh api "advisories?ecosystem=actions&affects=${owner}/${repo}" --paginate >"$advisories_file"; then
    echo "  error: could not list advisories for ${owner}/${repo}" >&2
    rm -f "$releases_file" "$advisories_file"
    return 1
  fi

  # Untrusted input: `releases` and `advisories` are attacker-controlled
  # upstream JSON (release names/bodies/tags, advisory text). NEVER
  # interpolate them into Python source -- a release body containing
  # the host language's own string delimiters would terminate the
  # literal early and the remainder would execute as code. Feed both
  # payloads to the Python process via a TEMP FILE PATH on argv instead
  # (the combined JSON is written to disk by jq --slurpfile, itself a
  # pure data operation reading each file's own bytes, never by shell
  # string interpolation or a CLI argument), so they are always inert
  # data, never program text. `current_version` is our own trusted
  # value and still arrives via argv directly. The Python source itself
  # is a quoted heredoc (<<'PY'), so no shell expansion happens inside
  # it at all.
  #
  # `--paginate` writes one JSON array per page, one after another, and
  # --slurpfile reads them as an array of those pages, so each list is
  # every page's entries concatenated, never the first page alone.
  local combined_json_file
  combined_json_file="$(mktemp)" || { rm -f "$releases_file" "$advisories_file"; return 1; }
  if ! jq -n --slurpfile releases "$releases_file" --slurpfile advisories "$advisories_file" \
    '{releases: [$releases[][]], advisories: [$advisories[][]]}' > "$combined_json_file"; then
    echo "  error: could not read the releases or advisories of ${owner}/${repo}" >&2
    rm -f "$releases_file" "$advisories_file" "$combined_json_file"
    return 1
  fi
  rm -f "$releases_file" "$advisories_file"

  python3 - "$current_version" "$combined_json_file" <<'PY'
import json, re, sys
from datetime import datetime, timezone, timedelta

current_version = sys.argv[1]
payload_path = sys.argv[2]

with open(payload_path) as f:
    payload = json.load(f)
releases = payload["releases"]
advisories = payload["advisories"]

SEMVER_RE = re.compile(r'^v?(\d+)\.(\d+)\.(\d+)')

def parse(v):
    m = SEMVER_RE.match(v)
    if not m:
        return None
    return tuple(int(x) for x in m.groups())

current = parse(current_version) if current_version else None

# Advisory versions may omit the minor or patch (`< 41`, first patched
# `41`); a missing component reads as 0.
ADVISORY_VERSION_RE = re.compile(r'^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\S*$')
RANGE_TERM_RE = re.compile(r'^(>=|<=|>|<|=)?\s*(\S+)$')

def parse_advisory_version(v):
    m = ADVISORY_VERSION_RE.match(v.strip())
    if not m:
        return None
    return tuple(int(x or 0) for x in m.groups())

def in_range(version, spec):
    # A vulnerable_version_range is comma-separated constraints, all of
    # which must hold: `>= 2.0.0, < 2.5.0`, `<= 45.0.7`, `= 1.0.0`.
    for term in spec.split(","):
        m = RANGE_TERM_RE.match(term.strip())
        bound = parse_advisory_version(m.group(2)) if m else None
        if bound is None:
            raise ValueError(spec)
        op = m.group(1) or "="
        holds = {
            ">=": version >= bound,
            "<=": version <= bound,
            ">": version > bound,
            "<": version < bound,
            "=": version == bound,
        }[op]
        if not holds:
            return False
    return True

# Each vulnerability's first patched version, with its vulnerable range.
first_patched = []
for adv in advisories:
    for vuln in adv.get("vulnerabilities", []) or []:
        fp = vuln.get("first_patched_version")
        if isinstance(fp, dict):
            fp = fp.get("identifier")
        if fp:
            pv = parse_advisory_version(fp)
            if pv:
                first_patched.append((pv, vuln.get("vulnerable_version_range") or ""))

# Security-eligibility is relative to the PIN IN HAND: an advisory only
# makes a candidate release security-eligible when the CURRENTLY PINNED
# version is inside that advisory's vulnerable_version_range, or, for an
# advisory that states no range, below its first_patched_version.
# Without this guard, any action that has ever had ANY advisory would
# have every later release treated as a security fix, defeating the
# 7-day soak for that action -- a pin below an advisory's range included.
if current is not None:
    applicable_first_patched = []
    for fp, vulnerable_range in first_patched:
        if vulnerable_range:
            try:
                affected = in_range(current, vulnerable_range)
            except ValueError:
                print(f"  error: cannot read the vulnerable_version_range {vulnerable_range!r}", file=sys.stderr)
                sys.exit(1)
        else:
            affected = current < fp
        if affected:
            applicable_first_patched.append(fp)
else:
    # No version comment to compare against, so no advisory can be shown
    # to affect the pin: every release competes on its 7-day soak alone,
    # whatever its advisories, and none is diverted into the security
    # pool, which an unversioned pin never reads.
    applicable_first_patched = []

now = datetime.now(timezone.utc)
soak_cutoff = now - timedelta(days=7)

# Two disjoint candidate pools, gathered separately; a semver-major
# release is a candidate in either:
#   security_candidates -- newer than current, and its version is >= at
#     least one APPLICABLE advisory's first_patched_version (i.e. the
#     current pin is actually affected by that advisory -- see the guard
#     above). Eligible IMMEDIATELY regardless of age (mirrors
#     Dependabot: security updates bypass cooldown entirely and target
#     the MINIMUM patched version, not necessarily the latest release --
#     so the smallest such candidate wins).
#   soak_candidates -- newer than current, and at least 7 days old. The
#     LARGEST such candidate wins (the most current release that has
#     finished soaking).
# Trying the security pool first means an old, unpatched pin gets
# fixed immediately even if a separate newer-but-still-soaking release
# also exists.
security_candidates = []
soak_candidates = []

for rel in releases:
    if rel.get("draft") or rel.get("prerelease"):
        continue
    tag = rel.get("tag_name") or ""
    cand = parse(tag)
    if cand is None:
        continue
    if current is not None and cand <= current:
        continue

    if any(cand >= fp for fp in applicable_first_patched):
        security_candidates.append((cand, tag))
        continue

    published_raw = rel.get("published_at")
    if not published_raw:
        continue
    published = datetime.fromisoformat(published_raw.replace("Z", "+00:00"))
    if published > soak_cutoff:
        continue
    soak_candidates.append((cand, tag))

if current is None:
    # An unversioned pin: every soaked release, newest first. The main
    # loop takes the first whose runtime is current, which it can only
    # learn by fetching each release's action.yml.
    for _, tag in sorted(soak_candidates, key=lambda t: t[0], reverse=True):
        print(tag)
    sys.exit(0)

if security_candidates:
    # The smallest candidate that is itself >= some applicable
    # first_patched_version -- i.e. the minimum security-eligible fix,
    # not the newest release overall. Selecting the newest would creep
    # straight to head on the first vulnerable pin found, which is more
    # change than the security fix requires.
    best = min(security_candidates, key=lambda t: t[0])
elif soak_candidates:
    best = max(soak_candidates, key=lambda t: t[0])
else:
    best = None

if best is not None:
    print(f"{best[1]}")
PY
  local resolve_status=$?
  rm -f "$combined_json_file"
  return "$resolve_status"
}

# ---------------------------------------------------------------------
# Step 3: resolve the tag's commit SHA. Emits TWO lines: the ref
# object's own sha, then its type (`commit` for a lightweight tag,
# `tag` for an annotated tag object that must be dereferenced one more
# hop). One API call, not two.
# ---------------------------------------------------------------------
resolve_tag_ref() {
  local owner="$1" repo="$2" tag="$3"

  local ref_json
  ref_json="$(gh api "repos/${owner}/${repo}/git/ref/tags/${tag}")" || return 1

  python3 -c "
import json, sys
ref = json.loads(sys.argv[1])
obj = ref.get('object', {})
print(obj.get('sha', ''))
print(obj.get('type', ''))
" "$ref_json"
}

resolve_annotated_tag_commit() {
  local owner="$1" repo="$2" tag_sha="$3"
  local tag_json
  tag_json="$(gh api "repos/${owner}/${repo}/git/tags/${tag_sha}")" || return 1
  python3 -c "
import json, sys
t = json.loads(sys.argv[1])
print(t.get('object', {}).get('sha', ''))
" "$tag_json"
}

# ---------------------------------------------------------------------
# action_runtime_is_current <owner> <repo> <subpath> <tag>: exit 0 when
# the action's action.yml (or action.yaml) at <tag> declares node24 or
# later in `runs.using`, or a runtime that is not `node*` (composite,
# docker). Exit 1 when it declares a `node*` runtime older than node24
# or with no numeric suffix, or when neither file yields a `runs.using`
# value, so a release is never selected on an unknown runtime. Exit 2
# when fetching either file fails for any reason but its absence (HTTP
# 404), since that says nothing about the runtime.
# ---------------------------------------------------------------------
action_runtime_is_current() {
  local owner="$1" repo="$2" subpath="$3" tag="$4"
  local dir="" name using="" contents_file err_file
  [ -n "$subpath" ] && dir="${subpath}/"
  contents_file="$(mktemp)" || return 2
  err_file="$(mktemp)" || { rm -f "$contents_file"; return 2; }
  for name in action.yml action.yaml; do
    if gh api "repos/${owner}/${repo}/contents/${dir}${name}?ref=${tag}" >"$contents_file" 2>"$err_file"; then
      using="$(read_runs_using "$contents_file")"
      [ -n "$using" ] && break
    elif ! grep -q '(HTTP 404)' "$err_file"; then
      cat "$err_file" >&2
      echo "  error: could not fetch ${dir}${name} for ${owner}/${repo}@${tag}" >&2
      rm -f "$contents_file" "$err_file"
      return 2
    fi
  done
  rm -f "$contents_file" "$err_file"

  case "$using" in
    "")
      echo "  warn: could not read runs.using for ${owner}/${repo}@${tag} -- not selecting it" >&2
      return 1
      ;;
    node*)
      if [ "${using#node}" -ge 24 ] 2>/dev/null; then
        return 0
      fi
      echo "  ${tag} runs on ${using}, older than node24 -- not selecting it."
      return 1
      ;;
  esac
  return 0
}

# read_runs_using <contents-json-file>: print the `runs.using` value of
# the action.yml a `repos/*/contents/*` payload carries, or nothing when
# the payload holds no readable file or the file declares no runtime.
# The payload is upstream data: it reaches Python as a file path on
# argv, never as program text (see resolve_bump).
read_runs_using() {
  python3 - "$1" <<'PY'
import base64, json, re, sys

try:
    with open(sys.argv[1]) as f:
        payload = json.load(f)
    text = base64.b64decode(payload["content"]).decode("utf-8")
except (ValueError, KeyError, TypeError):
    sys.exit(0)

in_runs = False
for line in text.splitlines():
    if re.match(r'^runs:\s*(#.*)?$', line):
        in_runs = True
        continue
    if not in_runs:
        continue
    if line and not line[0].isspace() and not line.startswith("#"):
        break
    m = re.match(r'^\s+using:\s*["\']?([^"\'\s#]+)', line)
    if m:
        print(m.group(1))
        break
PY
}

# ---------------------------------------------------------------------
# Main loop.
# ---------------------------------------------------------------------
# bumped counts pins rewritten to a new SHA; annotated counts pins that
# keep their SHA and only gain a `# vX.Y.Z` comment.
bumped=0
annotated=0
pins_seen=0
# failed counts pins whose resolution or rewrite failed. Each failure is
# logged and the loop moves on to the next pin, so one run reports every
# failing pin, and the script exits 2 at the end.
failed=0

if ! pins="$(discover_pins)"; then
  echo "bump-asset-pins: could not read the pins under ${ASSETS_DIR}" >&2
  exit 2
fi

while IFS=$'\t' read -r owner repo subpath sha version bare; do
  [ -z "$owner" ] && continue
  # Undo discover_pins' "-" sentinel for an empty subpath/version/bare
  # (see that function for why: bash `read` collapses consecutive tab
  # delimiters even under a single-character IFS).
  [ "$subpath" = "-" ] && subpath=""
  [ "$version" = "-" ] && version=""
  [ "$bare" = "-" ] && bare=""
  pins_seen=$((pins_seen + 1))
  echo "Checking ${owner}/${repo} (current: ${version:-unknown} @ ${sha})..."

  # A versioned pin gets one candidate. An unversioned pin gets every
  # soaked release, newest first, and takes the first whose runtime is
  # current.
  if ! candidates="$(resolve_bump "$owner" "$repo" "$subpath" "$version")"; then
    echo "  error: could not resolve a release for ${owner}/${repo}" >&2
    failed=$((failed + 1))
    continue
  fi
  bump_tag=""
  runtime_failed=""
  while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue
    if [ -n "$version" ]; then
      bump_tag="$candidate"
      break
    fi
    action_runtime_is_current "$owner" "$repo" "$subpath" "$candidate"
    case $? in
      0) bump_tag="$candidate"; break ;;
      2) runtime_failed=1; break ;;
    esac
  done <<<"$candidates"
  if [ -n "$runtime_failed" ]; then
    failed=$((failed + 1))
    continue
  fi
  # The SHA and tag every occurrence is rewritten to. When no bump is due,
  # a pin with both versioned and bare occurrences still has its bare
  # ones rewritten, keeping its SHA and gaining the versioned ones'
  # comment.
  commit_sha=""
  new_tag=""
  rewrite_kind=""
  if [ -n "$bump_tag" ]; then
    ref_info="$(resolve_tag_ref "$owner" "$repo" "$bump_tag")" || ref_info=""
    ref_sha="$(echo "$ref_info" | sed -n '1p')"
    ref_type="$(echo "$ref_info" | sed -n '2p')"
    if [ -z "$ref_sha" ]; then
      echo "  error: could not resolve commit SHA for ${owner}/${repo}@${bump_tag}" >&2
      failed=$((failed + 1))
      continue
    fi

    commit_sha="$ref_sha"
    # Dereference an annotated tag object to the commit it points at.
    if [ "$ref_type" = "tag" ]; then
      deref_sha="$(resolve_annotated_tag_commit "$owner" "$repo" "$ref_sha")" || deref_sha=""
      if [ -z "$deref_sha" ]; then
        echo "  error: could not dereference tag ${bump_tag} of ${owner}/${repo} to its commit" >&2
        failed=$((failed + 1))
        continue
      fi
      commit_sha="$deref_sha"
    fi

    # An unversioned pin already at the selected release's commit is
    # still rewritten, to gain that release's comment.
    if [ "$commit_sha" = "$sha" ]; then
      if [ -n "$version" ]; then
        echo "  ${bump_tag} resolves to the same SHA already pinned."
        commit_sha=""
      else
        echo "  adding the ${bump_tag} comment to ${owner}/${repo}@${sha}"
        new_tag="$bump_tag"
        rewrite_kind=annotated
      fi
    else
      echo "  bumping ${owner}/${repo} -> ${bump_tag} (${commit_sha})"
      new_tag="$bump_tag"
      rewrite_kind=bumped
    fi
  else
    echo "  up to date (or no eligible release)."
  fi

  if [ -z "$new_tag" ]; then
    if [ -z "$bare" ] || [ -z "$version" ]; then
      continue
    fi
    echo "  adding the ${version} comment to the bare occurrences of ${owner}/${repo}@${sha}"
    commit_sha="$sha"
    new_tag="$version"
    bare_only=1
    rewrite_kind=annotated
  else
    bare_only=""
  fi

  # Rewrite every occurrence of this exact owner/repo/subpath@sha pin,
  # across every *.yml under ASSETS_DIR (not just scan_targets -- a
  # stray occurrence elsewhere should not be missed), updating both the
  # SHA and the trailing version comment together so they never drift
  # out of sync with each other. With bare_only set, an occurrence that
  # already carries a `# vX.Y.Z` comment is left as it is.
  old_ref="${owner}/${repo}"
  if [ -n "$subpath" ]; then
    old_ref="${old_ref}/${subpath}"
  fi

  rewrite_failed=""
  for f in "$ASSETS_DIR"/*.yml "$ASSETS_DIR"/*.yaml; do
    [ -f "$f" ] || continue
    if ! python3 - "$f" "$old_ref" "$sha" "$commit_sha" "$new_tag" "$bare_only" "$FULL_VERSION_RE" <<'PY'
import re, sys

path, old_ref, old_sha, new_sha, new_tag, bare_only, full_version_re = sys.argv[1:8]

USES_RE = re.compile(r'^(\s*-?\s*uses:\s*)' + re.escape(old_ref) + '@' + re.escape(old_sha) + r'\s*(?:#.*)?$')
VER_RE = re.compile(full_version_re)

with open(path) as fh:
    lines = fh.readlines()

changed = False
out = []
for line in lines:
    m = USES_RE.match(line.rstrip("\n"))
    if m and bare_only and VER_RE.search(line):
        m = None
    if m:
        prefix = m.group(1)
        newline = f"{prefix}{old_ref}@{new_sha} # {new_tag}\n"
        out.append(newline)
        changed = True
    else:
        out.append(line)

if changed:
    with open(path, "w") as fh:
        fh.writelines(out)
    print("REWRITTEN")
PY
    then
      rewrite_failed=1
    fi
  done

  if [ -n "$rewrite_failed" ]; then
    echo "  error: could not rewrite every occurrence of ${old_ref}@${sha}" >&2
    failed=$((failed + 1))
  elif [ "$rewrite_kind" = bumped ]; then
    bumped=$((bumped + 1))
  else
    annotated=$((annotated + 1))
  fi
done <<<"$pins"

echo ""
echo "bump-asset-pins: checked ${pins_seen} distinct pin(s), ${bumped} bumped, ${annotated} annotated."
if [ "$failed" -ne 0 ]; then
  echo "bump-asset-pins: ${failed} pin(s) failed to resolve or rewrite; see the errors above." >&2
  exit 2
fi
exit 0
