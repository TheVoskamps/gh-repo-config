import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDesiredFiles,
  assertNoUnresolvedTokens,
  renderNamedGroupsBlock,
  NAMED_DEPENDABOT_GROUPS,
  COMMUNITY_FILE_PATHS,
} from "../dist/index.js";
import { readAssetText } from "../dist/index.js";

const CTX = { org: "TheVoskamps", repo: "example", defaultBranch: "main" };

/**
 * The job ids of a workflow, in file order.
 *
 * Counting jobs by "keys indented two spaces" does NOT work: `on:`'s own
 * keys sit at the same indent, so such a regex reports `push:` and
 * `schedule:` as jobs. It has to be scoped to the top-level `jobs:`
 * mapping first, which is what the slice below does — everything after
 * the `jobs:` line up to the next column-0 key.
 *
 * Within that slice, only lines matching GitHub's own job-id syntax
 * (start with a letter or `_`, then alphanumerics / `-` / `_`) count. The
 * character class is load-bearing rather than cosmetic: a `#` comment is
 * excluded by it, and `assets/codeql.yml`'s jobs block opens with a
 * two-space-indented comment line that happens to END IN A COLON, so a
 * looser pattern reports the comment as a job.
 *
 * Deliberately hand-rolled instead of parsed with `js-yaml`, per the
 * "tests import nothing this repo does not declare" convention in
 * CLAUDE.md. `package.json` does not declare js-yaml; it reaches the tree
 * only as a dev-time transitive dependency of `markdownlint-cli2`, which
 * `package-lock.json` records as its sole dependent. Since `npm test`
 * backs the `ci-required` check, importing it would let a
 * markdownlint-cli2 bump that drops js-yaml — or moves it to a major with
 * a different export shape — redden that check for a reason unrelated to
 * the change under test. The export-shape half is not hypothetical: the
 * pinned 5.2.2 exposes no default export from its ESM entry, so
 * `import yaml from "js-yaml"` throws against it while
 * `import { load } from "js-yaml"` works. Reaching for a real parser
 * means declaring the dependency first, not importing this one.
 */
const workflowJobIds = (content) => {
  const lines = content.split("\n");
  const start = lines.indexOf("jobs:");
  assert.ok(start >= 0, "workflow has a top-level jobs: mapping");
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level key closes the mapping
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(#.*)?$/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
};

// The org's community-file seed content, as `readOrgCommunityFiles`
// would return it (issue #90). Passed explicitly here: `buildDesiredFiles`
// is pure and takes the content as an input rather than reading it.
const COMMUNITY_CONTENT = {
  CONTRIBUTORS: "Ada Lovelace <ada@example.org>\n",
  LICENSE: "MIT License\n\nCopyright (c) Example Org\n",
  PATENTS: "No patent grant.\n",
  "PRIOR_ART.md": "# Prior art\n\nNone recorded.\n",
};

test("buildDesiredFiles emits dependabot + codeql + pr-automation workflow/config + gate/guard workflows + the codeartifact-auth action + scripts + community files", () => {
  const files = buildDesiredFiles(CTX, { communityFiles: COMMUNITY_CONTENT });
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

test("buildDesiredFiles with no options renders the default named groups; an org registry replaces them in dependabot.yml only (issue #88)", () => {
  const dependabotOf = (files) =>
    files.find((f) => f.path === ".github/dependabot.yml").content;
  const bare = buildDesiredFiles(CTX);
  const empty = buildDesiredFiles(CTX, {});
  assert.deepEqual(empty, bare);
  assert.ok(dependabotOf(bare).includes(NAMED_DEPENDABOT_GROUPS));

  const orgGroups = { "acme-sdk": ["@acme/*"] };
  const overridden = buildDesiredFiles(CTX, { namedDependabotGroups: orgGroups });
  const dep = dependabotOf(overridden);
  assert.ok(dep.includes(renderNamedGroupsBlock(orgGroups)));
  assert.doesNotMatch(dep, /codeql-action:/);
  // Every other payload is untouched by the registry.
  const others = (files) => files.filter((f) => f.path !== ".github/dependabot.yml");
  assert.deepEqual(others(overridden), others(bare));
});

test("an org-supplied PR-automation identity reaches both PR-automation workflows and nothing else (issue #89)", () => {
  const bare = buildDesiredFiles(CTX);
  const identity = {
    appName: "acme-pr-bot",
    appClientIdSecret: "ACME_BOT_APP_CLIENT_ID",
    appPrivateKeySecret: "ACME_BOT_APP_PRIVATE_KEY",
    botSlug: "acme-pr-bot[bot]",
  };
  const overridden = buildDesiredFiles(CTX, { prAutomationIdentity: identity });
  const PR_AUTOMATION = [
    ".github/workflows/auto-enable-automerge.yml",
    ".github/workflows/auto-rebase-prs.yml",
  ];
  for (const path of PR_AUTOMATION) {
    const f = overridden.find((x) => x.path === path);
    assert.match(f.content, /secrets\.ACME_BOT_APP_CLIENT_ID/, path);
    // The template's own comment header still mentions the example
    // secret names in prose, so assert on the `secrets.` reference.
    assert.doesNotMatch(f.content, /secrets\.AUTOMERGE_APP_CLIENT_ID/, path);
    assert.doesNotThrow(() => assertNoUnresolvedTokens(f.content, path));
  }
  const others = (files) => files.filter((f) => !PR_AUTOMATION.includes(f.path));
  assert.deepEqual(others(overridden), others(bare));
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
    assert.match(f.content, /client-id: \${{ secrets\.AUTOMERGE_APP_CLIENT_ID }}/);
    assert.match(f.content, /secrets\.AUTOMERGE_APP_PRIVATE_KEY/);
    // actions/create-github-app-token deprecated `app-id` in favour of
    // `client-id`; the deprecated input must not ship org-wide again.
    // Anchored to a `with:`-block key so the headers, which name the
    // deprecated input in prose, do not read as shipping it.
    assert.doesNotMatch(f.content, /^ *app-id:/m);
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

// Every fanned-out workflow's exact job set. Job count is a first-class
// constraint on this payload: GitHub bills a whole minute per JOB, rounded
// up, so a wrapper job doing three seconds of work costs a full minute
// while a check NAME costs nothing. Issue #77 collapsed the shapes that
// paid jobs for names, and this table is what stops a re-split.
//
// The expected lists are the POST-collapse shapes. Against `main` before
// #77 the payload rendered 13 jobs across these six workflows; it now
// renders 7. Per workflow, what changed:
//   - dependency-install-gate: detect + gate + aggregator -> one job that
//     is also the required check.
//   - dependency-pinned-gate:  the same three -> one, likewise.
//   - codeql: detect + matrixed analyze + aggregator -> one ubuntu job
//     named `codeql-required` (the action takes a comma-separated language
//     list) plus `analyze-swift`, which runs on whatever non-ubuntu runner
//     the detect step resolved and so cannot fold into the ubuntu job.
//     Two is the floor here, not a leftover.
//   - auto-enable-automerge: lost `dependabot-rest-merge`, which fired on
//     the same workflow_run event as auto-rebase-prs' sweep and so cost a
//     second billable job for one logical sweep; it is now a step inside
//     auto-rebase-prs' existing job.
//   - no-back-merging-guard and auto-rebase-prs were already single-job
//     and are unchanged; they are listed so the table covers the whole
//     payload rather than only the workflows #77 edited.
const EXPECTED_JOBS = {
  ".github/workflows/dependency-install-gate.yml": ["install-gate-required"],
  ".github/workflows/dependency-pinned-gate.yml": ["pinned-gate-required"],
  ".github/workflows/no-back-merging-guard.yml": ["no-back-merging-guard"],
  ".github/workflows/codeql.yml": ["codeql-required", "analyze-swift"],
  ".github/workflows/auto-enable-automerge.yml": ["enable-automerge"],
  ".github/workflows/auto-rebase-prs.yml": ["rebase"],
};

test("every fanned-out workflow renders exactly the jobs the collapse left it", () => {
  const workflows = buildDesiredFiles(CTX).filter((f) =>
    f.path.startsWith(".github/workflows/"),
  );
  // A new workflow must not be able to escape the job-count constraint by
  // simply not appearing in the table above.
  assert.deepEqual(
    workflows.map((f) => f.path).sort(),
    Object.keys(EXPECTED_JOBS).sort(),
    "every rendered workflow has an entry in EXPECTED_JOBS",
  );
  for (const wf of workflows) {
    assert.deepEqual(
      workflowJobIds(wf.content),
      EXPECTED_JOBS[wf.path],
      `${wf.path} job set`,
    );
  }
});

test("workflowJobIds counts jobs, not same-indent trigger or comment keys", () => {
  // Guards the helper itself against both ways an indent-only pattern
  // misreads a key as a job: `on:`'s own keys share the job indent (the
  // defect in the original "count two-space-indented keys" assertion this
  // replaced), and a jobs-block comment line can end in a colon.
  const sample = [
    "on:",
    "  push:",
    "    branches: [main]",
    "  schedule:",
    "    - cron: 0 0 * * *",
    "jobs:",
    "  # A COMMENT THAT ENDS IN A COLON:",
    "  real-job:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: true",
    "  second_job: # trailing comment",
    "    runs-on: ubuntu-latest",
    "permissions:",
    "  contents: read",
  ].join("\n");
  assert.deepEqual(workflowJobIds(sample), ["real-job", "second_job"]);
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
  assert.deepEqual(
    workflowJobIds(gate.content),
    ["install-gate-required"],
    "the grant's job is the workflow's only job",
  );
  assert.ok(at("\n  install-gate-required:") < grantAt);
  assert.ok(grantAt < at("\n    steps:"), "grant is inside the job's permissions block");

  // The latent-grant rationale must travel with the grant: an auditor
  // seeing `id-token: write` on a repo with no CodeArtifact needs to
  // find the explanation in the file itself.
  assert.match(gate.content, /LATENT/);
  assert.match(gate.content, /no IAM role's trust policy/);
});

const COMMUNITY_PATHS = ["CONTRIBUTORS", "LICENSE", "PATENTS", "PRIOR_ART.md"];

test("COMMUNITY_FILE_PATHS names exactly the community files, in payload order (issue #90)", () => {
  assert.deepEqual([...COMMUNITY_FILE_PATHS], COMMUNITY_PATHS);
});

test("community files ship the org's own content byte-for-byte at repo root, non-executable, seed-if-absent (issue #90)", () => {
  const files = buildDesiredFiles(CTX, { communityFiles: COMMUNITY_CONTENT });
  const community = files.filter((f) => COMMUNITY_PATHS.includes(f.path));
  assert.equal(community.length, COMMUNITY_PATHS.length);
  for (const f of community) {
    assert.equal(f.content, COMMUNITY_CONTENT[f.path], `${f.path} must be the org's content verbatim`);
    assert.equal(f.executable, false, `${f.path} should not be executable`);
    assert.ok(
      Array.isArray(f.honoredLocations) && f.honoredLocations.length > 0,
      `${f.path} must carry honoredLocations`,
    );
  }
});

test("a community file the org does not carry produces no payload entry — no error, no empty file (issue #90)", () => {
  const { LICENSE, ...withoutLicense } = COMMUNITY_CONTENT;
  const files = buildDesiredFiles(CTX, { communityFiles: withoutLicense });
  const paths = files.map((f) => f.path);
  assert.equal(paths.includes("LICENSE"), false);
  for (const path of ["CONTRIBUTORS", "PATENTS", "PRIOR_ART.md"]) {
    assert.ok(paths.includes(path), `${path} still seeded`);
  }
  assert.equal(files.some((f) => f.content === ""), false, "no empty file emitted");
});

test("no community content (org without a .github repo) or no options at all: no community payload, everything else unchanged (issue #90)", () => {
  const withAll = buildDesiredFiles(CTX, { communityFiles: COMMUNITY_CONTENT });
  const nonCommunity = (files) => files.filter((f) => !COMMUNITY_PATHS.includes(f.path));
  for (const files of [
    buildDesiredFiles(CTX, { communityFiles: {} }),
    buildDesiredFiles(CTX, {}),
    buildDesiredFiles(CTX),
  ]) {
    assert.equal(files.some((f) => COMMUNITY_PATHS.includes(f.path)), false);
    assert.deepEqual(files, nonCommunity(withAll));
  }
});

test("only the known community paths are consulted; extra keys in the org's map are ignored (issue #90)", () => {
  const files = buildDesiredFiles(CTX, {
    communityFiles: { ...COMMUNITY_CONTENT, "SECURITY.md": "# Security\n" },
  });
  assert.equal(files.some((f) => f.path === "SECURITY.md"), false);
});

test("community files honor .github/ and docs/ as alternate locations", () => {
  const files = buildDesiredFiles(CTX, { communityFiles: COMMUNITY_CONTENT });
  for (const path of COMMUNITY_PATHS) {
    const f = files.find((x) => x.path === path);
    assert.deepEqual(f.honoredLocations, [`.github/${path}`, `docs/${path}`]);
  }
});

test("every other (non-community) DesiredFile carries no honoredLocations", () => {
  const files = buildDesiredFiles(CTX, { communityFiles: COMMUNITY_CONTENT });
  for (const f of files) {
    if (COMMUNITY_PATHS.includes(f.path)) continue;
    assert.equal(
      f.honoredLocations,
      undefined,
      `${f.path} should not be seed-if-absent`,
    );
  }
});
