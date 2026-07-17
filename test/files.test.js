import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesiredFiles, assertNoUnresolvedTokens } from "../dist/index.js";
import { readAssetText } from "../dist/index.js";

const CTX = { org: "TheVoskamps", repo: "example", defaultBranch: "main" };

test("buildDesiredFiles emits dependabot + 3 workflows + 5 scripts", () => {
  const files = buildDesiredFiles(CTX);
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, [
    ".github/dependabot.yml",
    ".github/workflows/dependency-install-gate.yml",
    ".github/workflows/dependency-pinned-gate.yml",
    ".github/workflows/no-back-merging-guard.yml",
    ".github/scripts/dependency-install-gate.sh",
    ".github/scripts/dependency-pinned-gate.sh",
    ".github/scripts/test-dependency-pinned-gate.sh",
    ".github/scripts/no-back-merging-guard.sh",
    ".github/scripts/test-no-back-merging-guard.sh",
  ]);
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

test("gate/guard workflows carry the per-repo default branch", () => {
  const files = buildDesiredFiles({ org: "O", repo: "r", defaultBranch: "trunk" });
  const workflows = files.filter((f) =>
    f.path.startsWith(".github/workflows/"),
  );
  for (const wf of workflows) {
    assert.match(wf.content, /branches: \[trunk\]/, `${wf.path}`);
  }
});
