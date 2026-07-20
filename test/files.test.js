import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesiredFiles, assertNoUnresolvedTokens } from "../dist/index.js";
import { readAssetText } from "../dist/index.js";

const CTX = { org: "TheVoskamps", repo: "example", defaultBranch: "main" };

test("buildDesiredFiles emits dependabot + codeql + pr-automation workflow/config + gate/guard workflows + scripts", () => {
  const files = buildDesiredFiles(CTX);
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, [
    ".github/dependabot.yml",
    ".github/workflows/dependency-install-gate.yml",
    ".github/workflows/dependency-pinned-gate.yml",
    ".github/workflows/no-back-merging-guard.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/auto-enable-automerge.yml",
    ".github/workflows/auto-rebase-prs.yml",
    ".github/codeql/codeql-config.yml",
    ".github/scripts/dependency-install-gate.sh",
    ".github/scripts/dependency-pinned-gate.sh",
    ".github/scripts/test-dependency-pinned-gate.sh",
    ".github/scripts/no-back-merging-guard.sh",
    ".github/scripts/test-no-back-merging-guard.sh",
    ".github/scripts/codeql-language-present.sh",
    ".github/scripts/test-codeql-language-present.sh",
    ".github/scripts/auto-rebase-lockfile-regen.sh",
    ".github/scripts/test-auto-rebase-lockfile-regen.sh",
  ]);
});

test("the CodeQL config lands at the exact path the workflow's config-file: line references", () => {
  const files = buildDesiredFiles(CTX);
  const workflow = files.find((f) => f.path === ".github/workflows/codeql.yml");
  const config = files.find((f) => f.path === ".github/codeql/codeql-config.yml");
  assert.ok(workflow, "codeql workflow present");
  assert.ok(config, "codeql config present");
  // The workflow references the config via a leading-`./` relative path;
  // the two must stay consistent (issue #16).
  assert.match(workflow.content, /config-file:\s*\.\/\.github\/codeql\/codeql-config\.yml/);
});

test("the CodeQL workflow renders the per-repo default branch", () => {
  const files = buildDesiredFiles({ org: "O", repo: "r", defaultBranch: "trunk" });
  const workflow = files.find((f) => f.path === ".github/workflows/codeql.yml");
  assert.match(workflow.content, /branches: \[trunk\]/);
});

test("scripts are marked executable; yaml/config is not", () => {
  const files = buildDesiredFiles(CTX);
  for (const f of files) {
    if (f.path.endsWith(".sh")) {
      assert.equal(f.executable, true, `${f.path} should be executable`);
    } else {
      assert.equal(f.executable, false, `${f.path} should not be executable`);
    }
  }
});

test("scripts ship byte-for-byte verbatim (no token substitution applied)", () => {
  const files = buildDesiredFiles(CTX);
  for (const f of files) {
    if (!f.path.endsWith(".sh")) continue;
    const name = f.path.split("/").pop();
    assert.equal(f.content, readAssetText(name), `${name} must be verbatim`);
  }
});

test("every rendered .yml file has zero unresolved tokens", () => {
  const files = buildDesiredFiles(CTX);
  for (const f of files) {
    if (f.path.endsWith(".yml")) {
      assert.doesNotThrow(() => assertNoUnresolvedTokens(f.content, f.path));
    }
  }
});

test("PR-automation workflows reference the AUTOMERGE secrets, no-back-merging-guard, and the REST-merge job", () => {
  const files = buildDesiredFiles(CTX);
  const automerge = files.find(
    (f) => f.path === ".github/workflows/auto-enable-automerge.yml",
  );
  const rebase = files.find(
    (f) => f.path === ".github/workflows/auto-rebase-prs.yml",
  );
  assert.ok(automerge, "auto-enable-automerge.yml present");
  assert.ok(rebase, "auto-rebase-prs.yml present");

  for (const f of [automerge, rebase]) {
    assert.match(f.content, /secrets\.AUTOMERGE_APP_ID/);
    assert.match(f.content, /secrets\.AUTOMERGE_APP_PRIVATE_KEY/);
    assert.match(f.content, /workflows: \[no-back-merging-guard\]/);
  }
  assert.match(automerge.content, /dependabot-rest-merge:/);
});

test("gate/guard workflows carry the per-repo default branch", () => {
  const files = buildDesiredFiles({ org: "O", repo: "r", defaultBranch: "trunk" });
  const workflows = files.filter((f) =>
    f.path.startsWith(".github/workflows/"),
  );
  for (const wf of workflows) {
    assert.match(wf.content, /branches: \[trunk\]/, `${wf.path}`);
  }
});
