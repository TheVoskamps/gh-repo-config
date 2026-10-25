# Claude Code Markdown Instructions Style: gh-repo-config extension

## For Authors

## For Authors and Checkers

### Markdown passes `npm run lint:md`, run with no arguments

Every Markdown file the diff touches passes `npm run lint:md`, run from
the worktree root with no arguments: `.markdownlint-cli2.jsonc` owns
the linted set, so a caller passing its own globs lints a different set
than CI does. A linter absent from `PATH` is a stop-and-report, never
an install, and the report gives the PR's `gh pr checks <N>` state,
since CI runs this linter.
