import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesiredFiles, assertNoUnresolvedTokens } from "../dist/index.js";
import { readAssetText } from "../dist/index.js";

const CTX = { org: "TheVoskamps", repo: "example", defaultBranch: "main" };

test("buildDesiredFiles emits dependabot + codeql + pr-automation workflow/config + gate/guard workflows + the codeartifact-auth action + scripts + community files", () => {
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
    ".github/actions/codeartifact-auth/action.yml",
    ".github/scripts/dependency-install-gate.sh",
    ".github/scripts/dependency-pinned-gate.sh",
    ".github/scripts/test-dependency-pinned-gate.sh",
    ".github/scripts/no-back-merging-guard.sh",
    ".github/scripts/test-no-back-merging-guard.sh",
    ".github/scripts/codeql-language-present.sh",
    ".github/scripts/test-codeql-language-present.sh",
    ".github/scripts/auto-rebase-lockfile-regen.sh",
    ".github/scripts/test-auto-rebase-lockfile-regen.sh",
    ".github/scripts/codeartifact-auth.sh",
    ".github/scripts/test-codeartifact-auth.sh",
    "CONTRIBUTORS",
    "LICENSE",
    "PATENTS",
    "PRIOR_ART.md",
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

test("PR-automation workflows reference the AUTOMERGE secrets, and the REST-merge pass sits on the workflow_run side", () => {
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
  }

  // Issue #77 moved the Dependabot REST-merge sweep out of
  // auto-enable-automerge.yml (where it was a second job firing on the
  // same workflow_run event as the rebase sweep, so one logical sweep
  // cost two billable jobs) and into auto-rebase-prs.yml's single job.
  // auto-enable-automerge.yml is now pull_request-only, which is why it
  // no longer carries the workflow_run trigger.
  assert.match(rebase.content, /workflows: \[no-back-merging-guard\]/);
  assert.doesNotMatch(automerge.content, /workflow_run:/);
  assert.doesNotMatch(automerge.content, /^ {2}dependabot-rest-merge:$/m);
  assert.match(rebase.content, /- name: REST-merge green Dependabot PRs/);
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

const CODEARTIFACT_ACTION_PATH = ".github/actions/codeartifact-auth/action.yml";

test("the codeartifact-auth action ships verbatim, non-executable, at the path its callers reference", () => {
  const files = buildDesiredFiles(CTX);
  const action = files.find((f) => f.path === CODEARTIFACT_ACTION_PATH);
  assert.ok(action, "codeartifact-auth action.yml present");
  // Verbatim: the action carries nothing per-repo, so it must be a
  // byte-for-byte copy of the asset (issue #39).
  assert.equal(action.content, readAssetText("codeartifact-auth-action.yml"));
  assert.equal(action.executable, false);
  assert.equal(action.honoredLocations, undefined);
  assert.match(action.content, /using: composite/);
});

test("the codeartifact-auth action carries no per-repo tokens to render", () => {
  const a = buildDesiredFiles({ org: "O", repo: "r", defaultBranch: "trunk" });
  const b = buildDesiredFiles({ org: "P", repo: "s", defaultBranch: "main" });
  const pick = (files) =>
    files.find((f) => f.path === CODEARTIFACT_ACTION_PATH).content;
  assert.equal(pick(a), pick(b));
});

test("the install gate calls the codeartifact-auth action at the path it ships to", () => {
  const files = buildDesiredFiles(CTX);
  const gate = files.find(
    (f) => f.path === ".github/workflows/dependency-install-gate.yml",
  );
  assert.ok(gate, "dependency-install-gate.yml present");
  // The `uses:` path and the action's own target path must stay
  // consistent — a local composite action resolves by directory.
  assert.match(gate.content, /uses: \.\/\.github\/actions\/codeartifact-auth/);
  assert.equal(
    CODEARTIFACT_ACTION_PATH,
    ".github/actions/codeartifact-auth/action.yml",
  );
  assert.ok(files.some((f) => f.path === CODEARTIFACT_ACTION_PATH));
  // The variable name is static because a composite action cannot read
  // the `vars` context; the value must therefore be passed in.
  assert.match(gate.content, /role: \$\{\{ vars\.CODEARTIFACT_ROLE \}\}/);
  // The auth step is skipped when no Node package manager is present.
  // Issue #77 collapsed the per-PM matrix into one job, so the guard is
  // no longer `matrix.pm != 'pip'` but a step-level condition off the
  // detect step's output. The guard itself is load-bearing either way:
  // the action configures npm/pnpm/yarn only, and without it a pip-only
  // repo would still perform a real role assumption and a real token
  // mint, so an AWS-side failure would redden a REQUIRED check on a repo
  // with no CodeArtifact dependency at all.
  assert.match(
    gate.content,
    /- name: Authenticate against CodeArtifact\n\s+if: \$\{\{ steps\.detect\.outputs\.node == 'true' \}\}\n/,
  );
  // And it must still run BEFORE the installs that consume the
  // credential it writes.
  const authAt = gate.content.indexOf("- name: Authenticate against CodeArtifact");
  const installAt = gate.content.indexOf(
    "- name: Strict install over every present package manager",
  );
  assert.ok(authAt > 0 && installAt > 0);
  assert.ok(authAt < installAt, "codeartifact-auth must precede the install loop");
});

test("the install gate grants id-token: write on its single job only", () => {
  const files = buildDesiredFiles(CTX);
  const gate = files.find(
    (f) => f.path === ".github/workflows/dependency-install-gate.yml",
  );
  const idTokenGrants = gate.content.match(/^\s*id-token: write$/gm) ?? [];
  assert.equal(idTokenGrants.length, 1, "exactly one id-token: write grant");

  // Issue #77 collapsed detect/gate/aggregator into the one
  // `install-gate-required` job, so the grant now sits on the job that
  // is also the required check. It must still be a JOB-level grant on
  // that job — never the workflow-level `permissions:` block, which
  // would extend it to any job added later.
  const at = (needle) => gate.content.indexOf(needle);
  const grantAt = gate.content.search(/^\s*id-token: write$/m);
  assert.equal(gate.content.match(/^ {2}[a-z][a-z0-9-]*:$/gm)?.length, 1,
    "exactly one job");
  assert.ok(at("\n  install-gate-required:") < grantAt);
  assert.ok(grantAt < at("\n    steps:"), "grant is inside the job's permissions block");

  // The latent-grant rationale must travel with the grant: an auditor
  // seeing `id-token: write` on a repo with no CodeArtifact needs to
  // find the explanation in the file itself.
  assert.match(gate.content, /LATENT/);
  assert.match(gate.content, /no IAM role's trust policy/);
});

const COMMUNITY_PATHS = ["CONTRIBUTORS", "LICENSE", "PATENTS", "PRIOR_ART.md"];

test("community files ship byte-for-byte verbatim at repo root, non-executable, seed-if-absent", () => {
  const files = buildDesiredFiles(CTX);
  const community = files.filter((f) => COMMUNITY_PATHS.includes(f.path));
  assert.equal(community.length, COMMUNITY_PATHS.length);
  for (const f of community) {
    assert.equal(f.content, readAssetText(f.path), `${f.path} must be verbatim`);
    assert.equal(f.executable, false, `${f.path} should not be executable`);
    assert.ok(
      Array.isArray(f.honoredLocations) && f.honoredLocations.length > 0,
      `${f.path} must carry honoredLocations`,
    );
  }
});

test("community files honor .github/ and docs/ as alternate locations", () => {
  const files = buildDesiredFiles(CTX);
  for (const path of COMMUNITY_PATHS) {
    const f = files.find((x) => x.path === path);
    assert.deepEqual(f.honoredLocations, [`.github/${path}`, `docs/${path}`]);
  }
});

test("every other (non-community) DesiredFile carries no honoredLocations", () => {
  const files = buildDesiredFiles(CTX);
  for (const f of files) {
    if (COMMUNITY_PATHS.includes(f.path)) continue;
    assert.equal(
      f.honoredLocations,
      undefined,
      `${f.path} should not be seed-if-absent`,
    );
  }
});
