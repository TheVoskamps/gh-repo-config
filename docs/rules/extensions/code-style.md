# Code Style: gh-repo-config extension

## For Authors

### Committed code imports only what `package.json` declares

No import the diff adds under `src/`, `test/`, or `assets/` names a
package the root `package.json` does not declare. `npm test` backs the
`ci-required` check, so an undeclared transitive import couples that
check to another package's dependency graph. The live case is
`js-yaml`, which resolves only as a dependency of `markdownlint-cli2`:
tests inspect rendered YAML with hand-rolled string helpers instead.
Scratch under `.claude/tmp/<task slug>/` may import it, and a real
parse there is the oracle a hand-rolled helper is cross-checked
against.

### A `js-yaml` import uses the namespace form

Every `js-yaml` import is `import * as yaml from "js-yaml"`: the
version `package-lock.json` hoists has named exports only, so a default
import throws.

### A test fixture never coincides with the runtime value it stands in for

Every fixture the diff adds for a real runtime value is chosen so no
future change can make the two equal — `9.9.9` for a version that only
moves up.

### A change that makes a fixture equal its runtime value fixes every such fixture

A diff that makes an existing fixture equal the runtime value it stands
in for changes, in the same PR, every test that uses the same constant
so none coincides with it. Replacing the literal with the symbolic
constant beats editing two literals.

### A canonical-source-driven loop has no hardcoded selector above it

When the diff replaces a hardcoded enumeration with a loop over a
canonical asset, no string literal naming a member of that asset
remains in the enclosing function, including in whatever selects the
things being looped over.

### Prose about a canonical-source-driven loop is rewritten at both levels

When the diff replaces a hardcoded enumeration with a loop over a
canonical asset, the prose describing the mechanism is rewritten for
both the loop and whatever selects the things it loops over.

### A replacement for a passes-by-coincidence assertion is seen to fail

A diff answering a finding that an assertion passes by coincidence
comes with the replacement having been run against the input it exists
to reject — the pre-change shape from `git show origin/main:<path>`,
fed from a scratch `.mjs` under `.claude/tmp/<task slug>/` or by editing
the gitignored `dist/` — and having failed there.

### A replacement for a passes-by-coincidence assertion asserts a value

A diff answering a finding that an assertion passes by coincidence
asserts the exact expected value rather than a count, so a leaked entry
names itself in the failure.

## For Authors and Checkers

### A TSDoc comment on an exported symbol states its contract and why

Every doc comment the diff adds to an exported symbol states the
contract and the reason behind it, never what the signature already
shows.

### A third-party action is pinned by commit SHA

Every `uses:` the diff adds under `.github/workflows/` or `assets/`
that names a third-party action pins a 40-hex commit SHA with a version
comment, never a tag or branch.
