#!/usr/bin/env bash
#
# dependency-pinned-gate.sh
#
# Installed verbatim (no placeholders) at
# <repo-root>/.github/scripts/dependency-pinned-gate.sh by
# /gh-repo-setup-protection, alongside its workflow at
# <repo-root>/.github/workflows/dependency-pinned-gate.yml.
#
# Strict EXACT-VERSION gate over the repo's dependency manifests,
# discovered at RUNTIME from the tracked git tree (not a hardcoded path
# list -- a list rots when a new package / lambda / workflow is added).
# The sibling dependency-install-gate protects the *lock* relationship
# (manifest <-> lockfile drift); this gate protects how the *manifest
# itself* DECLARES versions. A package.json with "^2.172.0", a
# requirements.txt with ">=1.40", a workflow `uses: actions/checkout@v4`,
# or a `FROM node:22` resolves to a DIFFERENT concrete version over time
# even when the lockfile is perfectly in sync -- the "works on main,
# breaks on rebase" supply-chain drift that slips past a green
# install-gate. This gate fails the PR when any declared dependency is
# not pinned to an exact version.
#
# Rejected (non-exact) specs:
#   - caret `^`, tilde `~`
#   - comparators `>= <= > <`, compatible-release `~=`
#   - hyphen ranges (`1.2 - 1.4`), X-ranges (`1.x` / `1.*` / `*`)
#   - OR-ranges (`||`)
#   - floating action tags (`@v4` / `@main` / `@v1.2.3`)
#   - floating Docker tags (`:latest`, tag-only, untagged)
#   - bare / unpinned names
#
# Categorical exemptions (legitimately not exact-pinnable -- baked into
# the classifier, NOT a maintained allowlist file):
#   - npm `peerDependencies` carets (peer deps are ranges by design)
#   - npm `file:` / `workspace:` / `link:` / `git+` / `http(s):` specs
#     (local-path / protocol deps have no registry version to pin)
#   - npm/pnpm `catalog:` / `catalog:<name>` specs (a REFERENCE into
#     pnpm-workspace.yaml's `catalog:` / `catalogs:` sections, never a
#     version itself). The referenced catalog ENTRY must still be
#     exact -- validated once, at the source, against
#     pnpm-workspace.yaml, not re-flagged at every consumer manifest.
#   - npm `owner/repo#<40-hex-sha>` git-shorthand commit pins (the SHA
#     is immutable -- exact). A BARE `owner/repo` or a `#branch` / `#tag`
#     ref floats to the default-branch HEAD and is NOT exempt; same for
#     the `github:`-prefixed forms.
#   - npm `engines` (node/npm toolchain floors, not deps)
#   - npm `overrides` / `resolutions` -- classified on the override
#     VALUE (exact), never the selector KEY (whose caret is a match
#     pattern, not a declared version)
#   - pip `requires-python` / `python_requires` (a runtime floor)
#   - Docker `tag@sha256:` digests (the tag floats but the digest is
#     immutable, so the resolved image is exact -- the digest is read)
#   - Docker `FROM scratch` (the reserved empty base image -- no digest
#     exists to pin)
#   - the `# vX.Y.Z` trailing comment on a SHA-pinned action (display)
#
# Depth (npm): DIRECT deps + lockfile-present. The human-authored specs
# in package.json must be exact AND a lockfile must exist when deps are
# declared (an exact-pinned manifest with no lockfile still floats
# transitively). Transitive pinning itself stays the install-gate's job.
# The lockfile-present check is workspace-aware: a manifest with no
# sibling lockfile is still accepted when an ancestor directory (up to
# the repo root) has BOTH a lockfile AND a workspace declaration
# (pnpm-workspace.yaml `packages:` globs, or package.json `workspaces`)
# whose globs cover the manifest's directory -- pnpm/npm/yarn workspaces
# keep a single lockfile at the workspace root by design. A stray
# manifest the workspace does not cover still floats and stays a
# violation.
#
# Inputs:
#   $1 -- mode: "npm", "pip", "actions", "docker", "go", or "--present"
#
#   --present emits a JSON array of the ecosystems whose manifest is
#   actually present in the tracked tree (e.g. ["actions","go"]), used by
#   the workflow's `detect` job to build the runtime matrix. It reuses
#   the SAME discovery predicate the run loop uses, so the matrix cannot
#   drift from what the gate checks. `actions` is effectively an
#   always-present floor (the skill always installs workflow files).
#   Emits `[]` (valid JSON, not an empty string) when none are present.
#
# Behavior:
#   - Discovers every relevant manifest via `git ls-files` (tracked
#     files only), excluding generated/vendored trees (node_modules,
#     cdk.out, .build). Runs the per-mode classifier over each.
#   - Runs the classifier for EVERY discovered manifest, even if an
#     earlier one has violations (run-all-then-fail, not fail-fast).
#   - Prints a per-manifest summary; each violation emits an
#     `::error file=...::` annotation.
#   - No manifests found => SUCCESS (exit 0).
#
# Exit codes:
#   0 -- all discovered manifests are strict-pinned (or none found)
#   1 -- at least one manifest has a non-exact declared dependency
#   2 -- usage error
#
# bash 3.2 compatible (no `mapfile`) so the script and its self-test run
# on macOS too. Parsing uses stdlib tools (python3 + json/tomllib).
#
# Used by .github/workflows/dependency-pinned-gate.yml.

set -uo pipefail

MODE="${1:-}"

# The full armed set of ecosystems this gate supports, in a stable
# order. Used by --present to build the workflow's runtime matrix.
ALL_MODES="npm pip actions docker go"

case "$MODE" in
  npm|pip|actions|docker|go|--present) ;;
  *)
    echo "usage: $0 <npm|pip|actions|docker|go|--present>" >&2
    exit 2
    ;;
esac

EXCLUDE_RE='(^|/)(node_modules|cdk\.out|\.build)/'

# Discover tracked manifests for the mode, excluding generated/vendored
# trees. `git ls-files` lists only tracked files, so gitignored
# generated manifests never appear; the grep is belt-and-suspenders in
# case any such path is ever force-added.
discover() {
  case "$MODE" in
    npm)
      git ls-files '*package.json' | grep -vE "$EXCLUDE_RE" || true
      ;;
    pip)
      git ls-files '*requirements*.txt' '*pyproject.toml' \
        | grep -vE "$EXCLUDE_RE" || true
      ;;
    actions)
      git ls-files '.github/workflows/*.yml' '.github/workflows/*.yaml' \
        | grep -vE "$EXCLUDE_RE" || true
      ;;
    docker)
      git ls-files '*Dockerfile' '*Dockerfile.*' '*.dockerfile' \
        | grep -vE "$EXCLUDE_RE" || true
      ;;
    go)
      git ls-files '*go.mod' | grep -vE "$EXCLUDE_RE" || true
      ;;
  esac
}

# present_mode <mode> -> exit 0 when the mode has at least one manifest
# in the tracked tree. Reuses the SAME discover() predicate the run loop
# uses, so the runtime matrix (which jobs to spawn) cannot drift from
# what the gate actually checks.
present_mode() {
  MODE="$1"
  [ -n "$(discover | head -n 1)" ]
}

# --present: emit a JSON array of the ecosystems actually present in the
# tracked tree, for the CodeQL-style runtime matrix in
# dependency-pinned-gate.yml. Emits `[]` (valid JSON, NOT an empty
# string) when none are present, so the workflow's fromJSON spawns zero
# legs cleanly and the aggregator passes (fail-open). An ecosystem whose
# manifest lands after setup lights its leg up on the next PR with no
# skill re-run.
if [ "$MODE" = "--present" ]; then
  entries=""
  for m in $ALL_MODES; do
    if present_mode "$m"; then
      if [ -z "$entries" ]; then
        entries="\"$m\""
      else
        entries="$entries,\"$m\""
      fi
    fi
  done
  json="[$entries]"
  echo "$json"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "ecosystems=$json" >> "$GITHUB_OUTPUT"
  fi
  exit 0
fi

# ---------------------------------------------------------------------
# Per-mode classifiers. Each prints one `VIOLATION: <detail>` line per
# non-exact declared dependency and exits non-zero when any are found;
# a clean manifest prints nothing and exits 0.
# ---------------------------------------------------------------------

classify_npm() {
  local manifest="$1" dir
  dir="$(dirname "$manifest")"
  python3 - "$manifest" "$dir" <<'PY'
import fnmatch, json, os, re, sys

manifest, dirpath = sys.argv[1], sys.argv[2]
with open(manifest) as f:
    data = json.load(f)

violations = []

# An exact npm version is a bare x.y.z (optionally with a prerelease /
# build suffix). Anything carrying a range operator, X-range, OR, or
# whitespace comparator is non-exact.
EXACT = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.\-]+)?$')

# A 40-hex commit SHA -- the only git-ish ref that is immutable.
COMMIT_SHA = re.compile(r'^[0-9a-fA-F]{40}$')

# A bare GitHub `owner/repo` git-shorthand (optionally `github:`-prefixed)
# floats to the repo's default-branch HEAD, so it is NOT exempt -- UNLESS
# it carries an immutable commit pin `owner/repo#<40-hex-sha>`, which is
# exact and stays exempt. A `#branch` / `#tag` ref (anything that is not a
# 40-hex SHA) still floats. Returns True only for the commit-pinned form.
def is_pinned_git_shorthand(spec):
    s = spec.strip()
    if s.startswith("github:"):
        s = s[len("github:"):]
    # `owner/repo` with exactly one slash and no registry `@version`.
    before_hash = s.split("#", 1)[0]
    if before_hash.count("/") != 1 or "@" in before_hash:
        return False
    if "#" not in s:
        return False  # bare owner/repo -- floats to HEAD
    ref = s.split("#", 1)[1]
    return bool(COMMIT_SHA.match(ref))

# Specs that have no registry version to pin -- local-path / protocol
# deps. These are exempt by category. A bare `owner/repo` (or
# `github:owner/repo`) git-shorthand is NOT exempt here: it floats to the
# default-branch HEAD unless commit-pinned, and is_exact() handles the
# commit-pinned exemption separately.
def is_protocol_spec(spec):
    s = spec.strip()
    return (
        s.startswith("file:")
        or s.startswith("link:")
        or s.startswith("workspace:")
        or s.startswith("git+")
        or s.startswith("git:")
        or s.startswith("http:")
        or s.startswith("https:")
        # pnpm `catalog:` / named `catalog:<name>` -- the member
        # manifest's spec is a REFERENCE into pnpm-workspace.yaml's
        # catalog(s), not a version itself; it is never exact-pinnable
        # by design. The determinism question moves to the catalog
        # DEFINITION, validated separately by check_pnpm_catalogs().
        or s == "catalog:"
        or s.startswith("catalog:")
        # A commit-pinned `owner/repo#<40-hex>` (or `github:`-prefixed)
        # is immutable -- exempt. A bare or branch/tag-ref shorthand
        # floats and is intentionally NOT exempt here.
        or is_pinned_git_shorthand(spec)
    )

def is_exact(spec):
    s = spec.strip()
    # `npm:<pkg>@<version>` alias form -- classify on the version after @
    if s.startswith("npm:"):
        rest = s[len("npm:"):]
        at = rest.rfind("@")
        if at <= 0:
            return False
        s = rest[at + 1:]
    return bool(EXACT.match(s))

def check_block(block, label, exempt_protocol=True):
    for name, spec in (block or {}).items():
        if not isinstance(spec, str):
            continue
        if exempt_protocol and is_protocol_spec(spec):
            continue
        if not is_exact(spec):
            violations.append(f"{label}: {name} = \"{spec}\" (not an exact x.y.z)")

# Direct dependency blocks: must be exact.
check_block(data.get("dependencies"), "dependencies")
check_block(data.get("devDependencies"), "devDependencies")
check_block(data.get("optionalDependencies"), "optionalDependencies")

# peerDependencies are ranges BY DESIGN -- exempt entirely.

# overrides / resolutions: classify on the override VALUE, never the
# selector key (a caret in the key is a match pattern, not a version).
def check_override_value(node):
    # An overrides node maps a selector to either a version string or a
    # nested object. Classify only the leaf string VALUES.
    if isinstance(node, str):
        if not is_protocol_spec(node) and not is_exact(node):
            violations.append(f"overrides value \"{node}\" (not an exact x.y.z)")
    elif isinstance(node, dict):
        for k, v in node.items():
            # "." carries the version for the keyed package in npm
            # overrides; nested keys are further selectors.
            check_override_value(v)

if "overrides" in data:
    check_override_value(data["overrides"])
if "resolutions" in data:
    # yarn resolutions: flat map selector -> version. Classify values.
    res = data["resolutions"]
    if isinstance(res, dict):
        for k, v in res.items():
            if isinstance(v, str) and not is_protocol_spec(v) and not is_exact(v):
                violations.append(f"resolutions \"{k}\" -> \"{v}\" (not an exact x.y.z)")

# engines (node/npm) are toolchain floors, not deps -- ignored.

# Lockfile-present check: if ANY direct deps are declared, a lockfile
# must sit beside the manifest OR the manifest must be a member of a
# workspace whose root carries the lockfile (pnpm/npm/yarn workspaces
# keep a SINGLE lockfile at the workspace root by design -- per-member
# lockfiles never exist). An exact-pinned manifest with no lockfile
# anywhere it can claim still floats transitively.
LOCKFILES = ("package-lock.json", "pnpm-lock.yaml", "yarn.lock")

def has_lockfile(d):
    return any(os.path.exists(os.path.join(d, lf)) for lf in LOCKFILES)

# Minimal `packages:` list parser for pnpm-workspace.yaml. Does not
# assume PyYAML is installed -- the runner may not have it. Handles
# the two shapes the field is ever written in:
#   packages:
#     - 'src'
#     - 'packages/*'
# or the flow form `packages: ['src', 'packages/*']`.
def parse_pnpm_workspace_globs(path):
    globs = []
    try:
        with open(path) as f:
            text = f.read()
    except OSError:
        return globs
    lines = text.splitlines()
    in_packages = False
    for line in lines:
        stripped = line.strip()
        if not in_packages:
            m = re.match(r'^packages:\s*(\[.*\])?\s*$', stripped)
            if m:
                inline = m.group(1)
                if inline:
                    # Flow form: packages: ['src', 'packages/*']
                    for item in re.findall(r'[\'"]([^\'"]+)[\'"]', inline):
                        globs.append(item)
                else:
                    in_packages = True
            continue
        # Block form: consume `- 'glob'` lines until dedent / non-list line.
        m = re.match(r'^-\s*[\'"]?([^\'"]+?)[\'"]?\s*$', stripped)
        if m and stripped.startswith("-"):
            globs.append(m.group(1))
        elif stripped == "" or stripped.startswith("#"):
            continue
        else:
            in_packages = False
    return globs

# Minimal parser for the `catalog:` / `catalogs:` sections of
# pnpm-workspace.yaml. Returns a dict of {catalog-label: {pkg: spec}},
# where the default (unnamed) catalog's label is "catalog" and each
# named catalog's label is "catalogs.<name>" (used only for violation
# messages). Does not assume PyYAML -- same minimal-indent-tracking
# approach as parse_pnpm_workspace_globs. Handles:
#   catalog:
#     pkg-a: 1.2.3
#     pkg-b: 4.5.6
#   catalogs:
#     react18:
#       react: 18.3.1
#     react19:
#       react: 19.0.0
def parse_pnpm_workspace_catalogs(path):
    catalogs = {}
    try:
        with open(path) as f:
            text = f.read()
    except OSError:
        return catalogs
    lines = text.splitlines()

    def indent_of(line):
        return len(line) - len(line.lstrip(" "))

    def strip_quotes(s):
        s = s.strip()
        if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
            return s[1:-1]
        return s

    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        stripped = raw.strip()
        if stripped == "" or stripped.startswith("#"):
            i += 1
            continue
        top_indent = indent_of(raw)
        if top_indent == 0 and re.match(r'^catalog:\s*$', stripped):
            # Default catalog: a flat map of pkg: spec at the next
            # indent level.
            entries = {}
            i += 1
            while i < n:
                line = lines[i]
                if line.strip() == "" or line.strip().startswith("#"):
                    i += 1
                    continue
                if indent_of(line) <= top_indent:
                    break
                entry_stripped = re.split(r'\s+#', line.strip(), maxsplit=1)[0].strip()
                m = re.match(r'^([^:]+):\s*(.+?)\s*$', entry_stripped)
                if m:
                    entries[strip_quotes(m.group(1))] = strip_quotes(m.group(2))
                i += 1
            catalogs["catalog"] = entries
            continue
        if top_indent == 0 and re.match(r'^catalogs:\s*$', stripped):
            catalogs_indent = top_indent
            i += 1
            while i < n:
                line = lines[i]
                if line.strip() == "" or line.strip().startswith("#"):
                    i += 1
                    continue
                cur_indent = indent_of(line)
                if cur_indent <= catalogs_indent:
                    break
                name_m = re.match(r'^([^:]+):\s*$', line.strip())
                if not name_m:
                    i += 1
                    continue
                name = strip_quotes(name_m.group(1))
                name_indent = cur_indent
                entries = {}
                i += 1
                while i < n:
                    entry_line = lines[i]
                    if entry_line.strip() == "" or entry_line.strip().startswith("#"):
                        i += 1
                        continue
                    if indent_of(entry_line) <= name_indent:
                        break
                    entry_stripped = re.split(r'\s+#', entry_line.strip(), maxsplit=1)[0].strip()
                    m = re.match(r'^([^:]+):\s*(.+?)\s*$', entry_stripped)
                    if m:
                        entries[strip_quotes(m.group(1))] = strip_quotes(m.group(2))
                    i += 1
                catalogs[f"catalogs.{name}"] = entries
            continue
        i += 1
    return catalogs

# `workspaces` field in package.json -- either a flat array or an
# object with a `packages` key (the Yarn "nohoist"-style shape).
def parse_npm_workspace_globs(root_manifest_path):
    try:
        with open(root_manifest_path) as f:
            root_data = json.load(f)
    except (OSError, ValueError):
        return []
    ws = root_data.get("workspaces")
    if ws is None:
        return []
    if isinstance(ws, list):
        return [g for g in ws if isinstance(g, str)]
    if isinstance(ws, dict):
        pkgs = ws.get("packages")
        if isinstance(pkgs, list):
            return [g for g in pkgs if isinstance(g, str)]
    return []

# Does `relpath` (the manifest's directory, relative to the workspace
# root, using forward slashes, "" meaning the root itself) match any of
# the workspace globs? Negated globs (`!pattern`) exclude, regardless of
# where they appear in the list -- matching pnpm's (fast-glob's)
# order-independent ignore semantics, where a path matched by any
# negative pattern is excluded even if a positive pattern follows it.
# `packages/*` matches only a DIRECT child -- fnmatch's `*` has no
# path-segment awareness and would otherwise wrongly cross `/` and match
# a deeper nested path too, so a single-star pattern is only trusted
# when the segment counts match. `packages/**` (or any pattern
# containing a literal `**` component) matches any depth under its
# prefix; fnmatch has no native `**`, so that case is handled directly
# via a prefix check instead.
def glob_matches(relpath, pattern):
    pattern = pattern.rstrip("/")
    if pattern == relpath:
        return True
    if "**" not in pattern:
        if len(pattern.split("/")) == len(relpath.split("/")) and fnmatch.fnmatch(relpath, pattern):
            return True
    if "**" in pattern:
        prefix = pattern.split("**", 1)[0].rstrip("/")
        if prefix == "" or relpath == prefix or relpath.startswith(prefix + "/"):
            return True
    return False

def workspace_covers(relpath, globs):
    matched = False
    for g in globs:
        if g.startswith("!"):
            if glob_matches(relpath, g[1:]):
                return False
        elif glob_matches(relpath, g):
            matched = True
    return matched

# Walk up from the manifest's directory toward the repo root (the git
# top-level, discovered via `git rev-parse --show-toplevel` at the
# gate's call site through cwd -- classify_one() is always invoked with
# cwd at the repo root per the run loop below), looking for an ancestor
# that has BOTH a lockfile AND a workspace declaration covering the
# manifest's directory.
def find_workspace_root_lockfile(dirpath):
    repo_root = os.getcwd()
    abs_dir = os.path.abspath(dirpath)
    abs_root = os.path.abspath(repo_root)
    # Manifest must be inside the repo root for a relative path to make
    # sense; if not, there's nothing to walk.
    try:
        rel_to_root = os.path.relpath(abs_dir, abs_root)
    except ValueError:
        return False
    cur = abs_dir
    while True:
        parent = os.path.dirname(cur)
        if parent == cur:
            break  # filesystem root, stop
        cur = parent
        if has_lockfile(cur):
            rel = os.path.relpath(abs_dir, cur)
            rel = "" if rel == "." else rel.replace(os.sep, "/")
            globs = []
            pnpm_ws = os.path.join(cur, "pnpm-workspace.yaml")
            if os.path.exists(pnpm_ws):
                globs.extend(parse_pnpm_workspace_globs(pnpm_ws))
            root_pkg = os.path.join(cur, "package.json")
            if os.path.exists(root_pkg):
                globs.extend(parse_npm_workspace_globs(root_pkg))
            if globs and workspace_covers(rel, globs):
                return True
        if cur == abs_root:
            break  # do not walk above the repo root
    return False

declares_deps = any(
    data.get(b) for b in ("dependencies", "devDependencies", "optionalDependencies")
)
if declares_deps:
    if not has_lockfile(dirpath) and not find_workspace_root_lockfile(dirpath):
        violations.append(
            "no lockfile beside a deps-declaring package.json, and no "
            "workspace-root lockfile covers it "
            "(package-lock.json / pnpm-lock.yaml / yarn.lock) -- "
            "exact specs still float transitively without a lockfile"
        )

# Catalog-definition exactness: a member manifest's `catalog:` /
# `catalog:<name>` spec is exempt above (it's a REFERENCE, not a
# version), but the referenced catalog ENTRY must still be exact. Check
# this ONCE, at the source -- only when THIS manifest sits beside the
# pnpm-workspace.yaml that defines the catalogs (i.e. this manifest IS
# the workspace root) -- so a caret in the catalog is reported once
# instead of once per consumer manifest.
pnpm_ws_here = os.path.join(dirpath, "pnpm-workspace.yaml")
if os.path.exists(pnpm_ws_here):
    catalogs = parse_pnpm_workspace_catalogs(pnpm_ws_here)
    for label, entries in catalogs.items():
        for pkg, spec in entries.items():
            if not is_exact(spec):
                violations.append(
                    f"pnpm-workspace.yaml {label}: {pkg} = \"{spec}\" (not an exact x.y.z)"
                )

for v in violations:
    print(f"VIOLATION: {v}")
sys.exit(1 if violations else 0)
PY
}

classify_pip() {
  local manifest="$1"
  local base
  base="${manifest##*/}"
  if [ "$base" = "pyproject.toml" ]; then
    python3 - "$manifest" <<'PY'
import re, sys, tomllib

manifest = sys.argv[1]
with open(manifest, "rb") as f:
    data = tomllib.load(f)

violations = []

# PEP 508 requirement: an exact pin uses == or === as its only specifier.
# Anything with ~= >= <= > < , a bare name, or * is non-exact.
EXACT_OP = re.compile(r'^(===|==)\s*[^,\s]+$')

def check_req(req, label):
    s = req.strip()
    if not s:
        return
    # Strip extras: name[extra1,extra2]<spec>
    # Strip environment markers: <req> ; python_version < "3.9"
    s_nomarker = s.split(";", 1)[0].strip()
    # Drop a URL form (name @ url) -- a direct reference, classify as
    # non-exact unless it carries an immutable ref; conservatively flag.
    if "@" in s_nomarker and "==" not in s_nomarker:
        violations.append(f"{label}: \"{s}\" (URL/direct reference, not an exact ==)")
        return
    m = re.match(r'^([A-Za-z0-9._\-]+)\s*(\[[^\]]*\])?\s*(.*)$', s_nomarker)
    if not m:
        violations.append(f"{label}: \"{s}\" (unparseable requirement)")
        return
    spec = m.group(3).strip()
    if spec == "":
        violations.append(f"{label}: \"{s}\" (bare name, not pinned)")
        return
    if not EXACT_OP.match(spec):
        violations.append(f"{label}: \"{s}\" (not an exact == / ===)")

project = data.get("project", {})
# [project].dependencies
for req in project.get("dependencies", []) or []:
    check_req(req, "project.dependencies")
# [project.optional-dependencies]
for group, reqs in (project.get("optional-dependencies", {}) or {}).items():
    for req in reqs or []:
        check_req(req, f"project.optional-dependencies.{group}")
# requires-python is a runtime floor -- EXEMPT (not checked).

# [tool.poetry.dependencies] -- maps name -> spec; "python" is the
# runtime floor and is exempt.
poetry = data.get("tool", {}).get("poetry", {})
for name, spec in (poetry.get("dependencies", {}) or {}).items():
    if name.lower() == "python":
        continue  # runtime floor, exempt
    if isinstance(spec, str):
        s = spec.strip()
        # poetry uses bare "1.2.3" to mean caret; "==1.2.3" is exact.
        if not re.match(r'^(===|==)\s*[^,\s]+$', s):
            violations.append(
                f"tool.poetry.dependencies.{name}: \"{spec}\" (not an exact ==)"
            )
    elif isinstance(spec, dict):
        # {version = "...", ...} or {path=...} / {git=...}
        if "path" in spec or "git" in spec or "url" in spec:
            continue  # local/protocol dep, no registry version
        ver = spec.get("version")
        if ver is None:
            violations.append(
                f"tool.poetry.dependencies.{name}: no version (not pinned)"
            )
        elif not re.match(r'^(===|==)\s*[^,\s]+$', str(ver).strip()):
            violations.append(
                f"tool.poetry.dependencies.{name}: \"{ver}\" (not an exact ==)"
            )

for v in violations:
    print(f"VIOLATION: {v}")
sys.exit(1 if violations else 0)
PY
  else
    # requirements*.txt -- line-oriented.
    python3 - "$manifest" <<'PY'
import re, sys

manifest = sys.argv[1]
violations = []

# Exact: name[extras]==X or name[extras]===X (optionally with markers /
# --hash). A `-r`/`-c` include, a comment, a blank line, or an option
# line (--hash on its own / --index-url / etc.) is fine.
EXACT_OP = re.compile(r'^(===|==)\s*[^,\s]+')

with open(manifest) as f:
    lineno = 0
    for raw in f:
        lineno += 1
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # Strip an inline comment.
        line = re.split(r'\s+#', line, maxsplit=1)[0].strip()
        if not line:
            continue
        # Includes and option lines are not version specs.
        if line.startswith("-r") or line.startswith("--requirement"):
            continue
        if line.startswith("-c") or line.startswith("--constraint"):
            continue
        if line.startswith("-"):
            continue  # --hash=..., --index-url=..., -e (editable) etc.
        # Drop a trailing `--hash=...` continuation marker if on-line.
        spec_part = re.split(r'\s+--hash', line, maxsplit=1)[0].strip()
        # Strip environment markers.
        spec_part = spec_part.split(";", 1)[0].strip()
        # Direct URL reference (name @ url) is not an exact pin.
        if "@" in spec_part and "==" not in spec_part:
            violations.append(f"line {lineno}: \"{line}\" (URL/direct reference, not ==)")
            continue
        m = re.match(r'^([A-Za-z0-9._\-]+)\s*(\[[^\]]*\])?\s*(.*)$', spec_part)
        if not m:
            violations.append(f"line {lineno}: \"{line}\" (unparseable)")
            continue
        spec = m.group(3).strip()
        if spec == "":
            violations.append(f"line {lineno}: \"{line}\" (bare name, not pinned)")
            continue
        if not EXACT_OP.match(spec):
            violations.append(f"line {lineno}: \"{line}\" (not an exact == / ===)")

for v in violations:
    print(f"VIOLATION: {v}")
sys.exit(1 if violations else 0)
PY
  fi
}

classify_actions() {
  local manifest="$1"
  python3 - "$manifest" <<'PY'
import re, sys

manifest = sys.argv[1]
violations = []

# A `uses:` value must be either a local ref (./path) or a 40-hex SHA
# pin (owner/repo@<40-hex>). A floating @vN / @main / @vN.M.K tag is a
# violation. A trailing `# vX.Y.Z` comment is display-only and ignored.
USES_RE = re.compile(r'^\s*-?\s*uses:\s*(\S+)')
SHA_RE = re.compile(r'^[0-9a-fA-F]{40}$')

with open(manifest) as f:
    lineno = 0
    for raw in f:
        lineno += 1
        m = USES_RE.match(raw)
        if not m:
            continue
        value = m.group(1)
        # Strip quotes.
        value = value.strip('\'"')
        # Local action ref -- no version to pin.
        if value.startswith("./") or value.startswith("../"):
            continue
        # Docker action ref `docker://image@sha256:...` -- out of scope
        # for the actions classifier (docker mode covers FROM lines).
        if value.startswith("docker://"):
            continue
        if "@" not in value:
            violations.append(f"line {lineno}: uses: {value} (no @ref -- not SHA-pinned)")
            continue
        ref = value.rsplit("@", 1)[1]
        if not SHA_RE.match(ref):
            violations.append(
                f"line {lineno}: uses: {value} (floating @{ref} tag -- not a 40-hex SHA)"
            )

for v in violations:
    print(f"VIOLATION: {v}")
sys.exit(1 if violations else 0)
PY
}

classify_docker() {
  local manifest="$1"
  python3 - "$manifest" <<'PY'
import re, sys

manifest = sys.argv[1]
violations = []

# Every FROM must carry an immutable @sha256:<digest>. A bare tag
# (:latest, :22, or no tag at all) floats. `tag@sha256:...` PASSES (the
# tag floats but the digest is immutable, so the resolved image is
# exact). `FROM <stage>` referencing an earlier build stage by name is
# not an image reference and is exempt.
FROM_RE = re.compile(r'^\s*FROM\s+(.+?)\s*$', re.IGNORECASE)
DIGEST_RE = re.compile(r'@sha256:[0-9a-fA-F]{64}$')

# Collect named build stages (`FROM x AS name`) so a later
# `FROM name` is recognized as a stage reference, not an image.
stages = set()

with open(manifest) as f:
    lines = f.readlines()

# First pass: collect stage names. Skip any leading `--flag` tokens
# (e.g. `FROM --platform=$BUILDPLATFORM img AS name`) before reading the
# image token and the `AS <name>` clause, mirroring the second pass's
# flag-skipping logic so the two passes agree on token positions.
for raw in lines:
    m = FROM_RE.match(raw)
    if not m:
        continue
    parts = m.group(1).split()
    idx = 0
    while idx < len(parts) and parts[idx].startswith("--"):
        idx += 1
    # parts[idx] is the image; parts[idx+1] is the `AS` keyword; parts
    # [idx+2] is the stage name.
    if len(parts) >= idx + 3 and parts[idx + 1].lower() == "as":
        stages.add(parts[idx + 2])

# Second pass: classify each FROM image reference.
lineno = 0
for raw in lines:
    lineno += 1
    m = FROM_RE.match(raw)
    if not m:
        continue
    parts = m.group(1).split()
    # `FROM --platform=... image` -- skip a leading --flag.
    idx = 0
    while idx < len(parts) and parts[idx].startswith("--"):
        idx += 1
    if idx >= len(parts):
        continue
    image = parts[idx]
    # `FROM scratch` -- Docker's reserved empty base image. It has no
    # digest and cannot be pinned; it is a special-cased reserved name,
    # neither a violation nor a stage reference. Exempt it.
    if image.lower() == "scratch":
        continue
    # Build-stage reference -- not an image.
    if image in stages:
        continue
    # Build-arg-templated image (FROM ${BASE}) -- cannot classify
    # statically; treat as a violation since it can float.
    if image.startswith("$"):
        violations.append(
            f"line {lineno}: FROM {image} (build-arg image -- cannot verify a digest pin)"
        )
        continue
    if not DIGEST_RE.search(image):
        violations.append(
            f"line {lineno}: FROM {image} (no @sha256: digest -- tag floats)"
        )

for v in violations:
    print(f"VIOLATION: {v}")
sys.exit(1 if violations else 0)
PY
}

classify_go() {
  local manifest="$1"
  python3 - "$manifest" <<'PY'
import re, sys

manifest = sys.argv[1]
violations = []

# `require` lines in go.mod are toolchain-pinned (the Go module system
# rewrites a floating spec to an exact vX.Y.Z or a pseudo-version on
# `go get`/`go mod tidy`, and go.sum locks the hash). The real failure
# mode is a `replace` directive pointing at a FLOATING ref or a
# bare/`latest` version. Exact vX.Y.Z and pseudo-versions
# (v0.0.0-YYYYMMDDhhmmss-abcdef) pass; a `latest` / branch / missing
# version fails. A replace pointing at a local path (=> ./foo or
# => ../bar) has no version and is exempt.
EXACT_VER = re.compile(r'^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.\-]+)?(\+[0-9A-Za-z.\-]+)?$')

def is_local_path(target):
    return target.startswith("./") or target.startswith("../") or target.startswith("/")

with open(manifest) as f:
    lines = f.readlines()

in_replace_block = False
lineno = 0
for raw in lines:
    lineno += 1
    line = raw.strip()
    # Strip a comment.
    line = re.split(r'\s*//', line, maxsplit=1)[0].strip()
    if not line:
        continue

    if line.startswith("replace") and "(" in line:
        in_replace_block = True
        # Could be `replace (` only, or `replace ( old => new` inline.
        line = line[len("replace"):].strip().lstrip("(").strip()
        if not line:
            continue
    elif line == ")" and in_replace_block:
        in_replace_block = False
        continue
    elif line.startswith("replace"):
        line = line[len("replace"):].strip()
    elif not in_replace_block:
        continue  # not a replace directive

    # Now `line` is `old [oldver] => new [newver]`.
    if "=>" not in line:
        continue
    rhs = line.split("=>", 1)[1].strip()
    parts = rhs.split()
    if not parts:
        continue
    target = parts[0]
    if is_local_path(target):
        continue  # local replacement, no version to pin
    if len(parts) < 2:
        violations.append(
            f"line {lineno}: replace => {rhs} (no version on a module target -- floats)"
        )
        continue
    newver = parts[1]
    if newver == "latest" or not EXACT_VER.match(newver):
        violations.append(
            f"line {lineno}: replace => {rhs} (\"{newver}\" is not an exact version/pseudo-version)"
        )

for v in violations:
    print(f"VIOLATION: {v}")
sys.exit(1 if violations else 0)
PY
}

classify_one() {
  case "$MODE" in
    npm)     classify_npm "$1" ;;
    pip)     classify_pip "$1" ;;
    actions) classify_actions "$1" ;;
    docker)  classify_docker "$1" ;;
    go)      classify_go "$1" ;;
  esac
}

# Read discovered manifests into an array. Avoid `mapfile` (bash 4+) so
# the script and its self-test also run under macOS bash 3.2.
MANIFESTS=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  MANIFESTS+=("$line")
done < <(discover)

if [ "${#MANIFESTS[@]}" -eq 0 ]; then
  echo "No $MODE manifests discovered. Nothing to gate -- success."
  exit 0
fi

echo "Discovered ${#MANIFESTS[@]} $MODE manifest(s):"
printf '  %s\n' "${MANIFESTS[@]}"
echo

failures=()
for manifest in "${MANIFESTS[@]}"; do
  echo "::group::$MODE pin check: $manifest"
  out="$(classify_one "$manifest")"
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "OK: $manifest (all declared dependencies exact-pinned)"
  else
    if [ -n "$out" ]; then
      echo "$out"
    fi
    echo "::error file=$manifest::Non-exact dependency declaration(s) in $manifest"
    failures+=("$manifest")
  fi
  echo "::endgroup::"
done

echo
if [ "${#failures[@]}" -eq 0 ]; then
  echo "All ${#MANIFESTS[@]} $MODE manifest(s) are strict-pinned."
  exit 0
fi

echo "FAILED: ${#failures[@]} of ${#MANIFESTS[@]} $MODE manifest(s) have non-exact declarations:"
printf '  %s\n' "${failures[@]}"
exit 1
