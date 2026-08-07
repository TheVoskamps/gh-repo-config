---
name: renamed-constant-falsifies-distant-prose
description: When a PR renames a placeholder AND changes what it means, grep the origin/main copy for the OLD semantic word — the new file's own text gives the reviewer nothing to grep for, so sites far from the rename survive every sweep.
metadata:
  type: reference
---

# A meaning-changing rename falsifies prose the rename never touched

The hard case is not a pure rename. It is a rename that also changes
**what the thing is** — as when `__INSTALL_GATE_NPM_CHECK__` (the npm
matrix leg's CheckRun) becomes `__INSTALL_GATE_CHECK__` (the whole
gate's single aggregate check). Every occurrence of the token itself
gets updated, and so do the file's placeholder-doc header and the
pass's rationale header. What survives are inline comments a few
hundred lines down that never mention the token at all — "the **npm**
check", "the dependency-install-gate **npm** CheckRun", "a typical
dependency-install-gate **npm** job". Those were true before the
rename and the rename falsifies them.

Why every ordinary sweep misses them: the fixer greps the new name, the
reviewer greps the new name, and these sites contain neither name. There
is nothing in the branch's own text that marks them as suspicious.

The check that finds them, and it has to run against the OLD file:

```bash
git show origin/main:<file> | grep -niE "<old-semantic-word>"
grep -niE "<old-semantic-word>" <file>
```

Any line in the second result that is not explicitly historical ("the
three-job shape gave each PM its own check NAME, so a red
`Install gate (pnpm)` named…") is a live claim about a thing that no
longer exists. Comparing the two lists tells you which sites the sweep
reached and which it skipped.

Pick the semantic word, not the identifier — in the case above, `npm`
appearing next to `check` / `job` / `CheckRun`. The same move applies to
any constant whose *scope* widens or narrows: a per-leg name becoming an
aggregate one, a per-repo value becoming an org constant.

Grade it **Low** when the file's own header already carries the corrected
semantics (a reader who reads the rationale is not misled) and no
acceptance criterion depends on it — but do report it, because these
comments ship verbatim to every managed repo and are the only
documentation a target-repo maintainer ever sees.

Related: [[reference-job-shape-changes-orphan-script-outputs]] — same
"the sweep structurally could not reach this member" shape, one class over.
