# Documentation Style: gh-repo-config extension

## For Authors

### A duration or date range is settled against `git log`

Every claim the diff adds about how long something lasted or when it
started is checked with `git log --diff-filter=A -- <file that
introduced the behaviour>` and any dated record.

### A duration is written as a dated fact

Every claim the diff adds about how long something lasted or when it
started is written as the dated fact a reader can re-check rather than
as a span.

### "Also pushes to" is settled against the pass's candidate selection

Every claim the diff adds that a workflow pass also pushes to, rebases,
or merges a given branch or PR is checked against that pass's
candidate filter and the target PR's author, not against the presence
of a push in its body. Two passes sharing one job, identity, and push
can select disjoint PR sets.

### A named guarantee is run before it is cited as a safety argument

Every sentence the diff adds naming a test, lint rule, ruleset, or CI
gate as the reason a narrower implementation is safe is checked by
running that guarantee against the value the narrow implementation
mishandles. Where it does not hold, strengthening it is the fix.

### A cited guarantee is stated as a rejection

Every sentence the diff adds naming a test, lint rule, ruleset, or CI
gate as the reason a narrower implementation is safe states the
rejection positively ("a prerelease fails `npm test`") rather than a
shape passively ("is pinned to `X.Y.Z`").

### "Identical across all arms" is settled at the consuming call site

Every claim the diff adds that a discriminated union's arms behave
alike is checked against the code that reads the union. Where one arm
carries a payload and the rest collapse to a fallback, the sentence
states the narrower truth: the discriminant never decides on its own.

### A package claim is verified after `npm ci`

Every claim the diff adds about a package's presence, dependents,
version, or export shape is verified after `npm ci`, since a fresh
worktree has no `node_modules` and `npm ls <pkg>` then answers
`(empty)` for a package that is present.

### An export-shape claim is settled by importing the package

Every claim the diff adds about a package's export shape is settled by
running `node --input-type=module -e "import …"` against it.

### A downgraded hedge is propagated repo-wide

When a commit on the branch downgrades a claim about external behaviour
to unsettled or unverified, the repo is grepped for the unhedged form
of the same term and every earlier assertion of it is corrected,
including earlier paragraphs of the same file. The newest statement is
the researched one.

## For Authors and Checkers

### A test title still describes its fixture

When the diff renames a vocabulary or inverts a meaning, every test
title in the changed test files is checked against the fixture in its
own body, by grepping for the retired token and the old sense. A
flipped fixture under an unflipped title passes every suite.

### A package claim cites `package-lock.json`

Every claim the diff adds about a package's presence, dependents,
version, or export shape cites `package-lock.json` and the pinned
version, which hold whatever the install state.

### A GitHub API fact found by experiment ships with its probe

Every claim the diff adds about GitHub API behaviour that GitHub's
documentation does not state carries the experiment beside it: the
exact `gh api` calls with real values inlined, the org and date they
ran on, and what each returned.

### A `docs/` file carrying a status marker is not edited to match the code

No diff edits a `docs/` file whose first lines carry a `Status:` line
to describe as-built behaviour. Such a file records
intent, and code diverging from it is information it keeps.
