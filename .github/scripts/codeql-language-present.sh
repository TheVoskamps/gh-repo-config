#!/usr/bin/env bash
#
# codeql-language-present.sh
#
# Installed verbatim (no placeholders) at
# <repo-root>/.github/scripts/codeql-language-present.sh by
# /gh-repo-setup-protection, alongside the CodeQL workflow at
# <repo-root>/.github/workflows/codeql.yml.
#
# Runtime language-presence detection for the CodeQL dynamic matrix. The
# workflow's `detect` job calls this script in `--matrix` mode to build
# the analyze job's `strategy.matrix.include` array at RUNTIME (per PR),
# so a CodeQL leg exists for a language IFF that language's source is in
# the tracked tree at that moment. A language that lands AFTER setup
# lights its leg up on the next PR with no skill re-run; an absent
# language produces no leg (fails OPEN — no phantom check, issues
# #91/#230).
#
# Detection is the SAME `git ls-files` predicate the matrix is built
# from — defined once here — so "what detect thinks is present" cannot
# drift from what the analyze job runs.
#
# Modes:
#   --matrix          Emit a single-line JSON array of matrix entries for
#                     every PRESENT language, e.g.
#                     [{"language":"python","runner":"ubuntu-latest"},
#                      {"language":"actions","runner":"ubuntu-latest"}]
#                     The empty case emits `[]` (valid JSON — NOT an empty
#                     string), so `fromJSON` in the workflow spawns zero
#                     legs cleanly. `actions` is an unconditional floor.
#                     `swift`, when present, carries runner=macos-latest;
#                     every other language carries runner=ubuntu-latest.
#   --list            Emit the present languages one per line (for humans
#                     / the self-test). Same detection as --matrix.
#   <language>        Emit `present` / `absent` for one language and exit
#                     0 (present) / 1 (absent). Used by the self-test to
#                     exercise each predicate independently. `actions`
#                     is always `present`.
#
# Supported languages (CodeQL 2.26+, all GA — verify against the CodeQL
# supported-languages docs):
#   javascript-typescript, python, go, java-kotlin, csharp, c-cpp,
#   ruby, rust, swift, actions
#
# Presence heuristics via `git ls-files` (tracked files only, so
# gitignored generated/vendored trees never count; the grep excludes
# vendored trees force-added by mistake). Swift is detected cheaply on
# Ubuntu here (a `git ls-files` for `*.swift`); ONLY when present does
# --matrix add its macos-latest entry, so a Swift-less repo never
# provisions macOS.
#
# Exit codes:
#   0 -- success (--matrix / --list always; <language> when present)
#   1 -- <language> mode: the language is absent
#   2 -- usage error
#
# bash 3.2 compatible (no `mapfile`, no associative arrays) so the
# script and its self-test run on macOS too.
#
# Used by .github/workflows/codeql.yml.

set -uo pipefail

MODE="${1:-}"

if [ -z "$MODE" ]; then
  echo "usage: $0 <--matrix|--list|LANGUAGE>" >&2
  exit 2
fi

EXCLUDE_RE='(^|/)(node_modules|vendor|cdk\.out|\.build)/'

# The full armed set, in a stable order. `actions` last so it reads as
# the floor.
ALL_LANGUAGES="javascript-typescript python go java-kotlin csharp c-cpp ruby rust swift actions"

# ls_present <glob>...  -> exit 0 if any tracked, non-vendored file
# matches at least one glob; exit 1 otherwise. Never prints.
ls_present() {
  local hit
  hit="$(git ls-files "$@" 2>/dev/null | grep -vE "$EXCLUDE_RE" | head -n 1)"
  [ -n "$hit" ]
}

# present <language> -> exit 0 when the language's source is in the tree.
# `actions` is the unconditional floor (the skill always installs
# workflows). Keep these predicates in sync with the SKILL.md heuristics.
present() {
  case "$1" in
    javascript-typescript)
      ls_present '*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.cjs' '*.vue'
      ;;
    python)
      ls_present '*.py'
      ;;
    go)
      ls_present '*.go'
      ;;
    java-kotlin)
      ls_present '*.java' '*.kt' '*.kts'
      ;;
    csharp)
      ls_present '*.cs'
      ;;
    c-cpp)
      ls_present '*.c' '*.h' '*.cpp' '*.cc' '*.cxx' '*.hpp' '*.hh'
      ;;
    ruby)
      ls_present '*.rb' '*Gemfile' '*Rakefile'
      ;;
    rust)
      ls_present '*.rs' '*Cargo.toml'
      ;;
    swift)
      ls_present '*.swift'
      ;;
    actions)
      return 0 # always present (floor) — needs no source
      ;;
    *)
      echo "unknown CodeQL language: $1" >&2
      exit 2
      ;;
  esac
}

# runner_for <language> -> the runs-on value for that language's leg.
# Swift analysis requires macOS; everything else runs on Ubuntu.
runner_for() {
  case "$1" in
    swift) echo "macos-latest" ;;
    *)     echo "ubuntu-latest" ;;
  esac
}

case "$MODE" in
  --matrix)
    # Build a JSON array of {language,runner} objects for present
    # languages. Emit `[]` (never an empty string) in the no-match case
    # so the workflow's fromJSON produces a clean empty matrix.
    entries=""
    for lang in $ALL_LANGUAGES; do
      if present "$lang"; then
        entry="{\"language\":\"$lang\",\"runner\":\"$(runner_for "$lang")\"}"
        if [ -z "$entries" ]; then
          entries="$entry"
        else
          entries="$entries,$entry"
        fi
      fi
    done
    json="[$entries]"
    echo "$json"
    # Also surface it as a GitHub Actions job output when running in CI.
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
      echo "languages=$json" >> "$GITHUB_OUTPUT"
    fi
    exit 0
    ;;
  --list)
    for lang in $ALL_LANGUAGES; do
      if present "$lang"; then
        echo "$lang"
      fi
    done
    exit 0
    ;;
  *)
    # Single-language query.
    if present "$MODE"; then
      echo "present"
      exit 0
    else
      echo "absent"
      exit 1
    fi
    ;;
esac
