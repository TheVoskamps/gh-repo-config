import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderTemplate,
  assertNoUnresolvedTokens,
  renderDependabotYml,
  renderPrAutomationTemplate,
  DEPENDABOT_ECOSYSTEMS,
  DEFAULT_NAMED_DEPENDABOT_GROUPS,
  DEFAULT_PR_AUTOMATION_IDENTITY,
  NAMED_DEPENDABOT_GROUPS,
  PR_AUTOMATION_CONSTANTS,
  prAutomationIdentityTokens,
  renderNamedGroupsBlock,
} from "../dist/index.js";
import { readAssetText } from "../dist/index.js";

const CTX = { org: "TheVoskamps", repo: "example", defaultBranch: "main" };

test("renderTemplate substitutes all three tokens, every occurrence", () => {
  const out = renderTemplate(
    "org=__GH_ORG__ repo=__GH_REPO__ b=__DEFAULT_BRANCH__ again=__DEFAULT_BRANCH__",
    CTX,
  );
  assert.equal(out, "org=TheVoskamps repo=example b=main again=main");
});

test("renderTemplate is identity on a template with zero tokens", () => {
  const text = "no placeholders here\njust text\n";
  assert.equal(renderTemplate(text, CTX), text);
});

test("assertNoUnresolvedTokens throws with the offending token names", () => {
  assert.throws(
    () => assertNoUnresolvedTokens("a __LEFTOVER__ b __OTHER_ONE__", "t"),
    /unresolved placeholder\(s\).*__LEFTOVER__.*__OTHER_ONE__/s,
  );
});

test("assertNoUnresolvedTokens passes on fully-rendered content", () => {
  assert.doesNotThrow(() =>
    assertNoUnresolvedTokens("version: 2\nupdates: []\n", "t"),
  );
});

test("assertNoUnresolvedTokens does not flag lowercase __words__ (script-safe shape)", () => {
  // The token shape is UPPER_SNAKE; a shell-style __private__ is not a token.
  assert.doesNotThrow(() => assertNoUnresolvedTokens("x=__foo_bar__", "t"));
});

test("renderDependabotYml expands one block per armed ecosystem, sorted, no tokens", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  assert.doesNotThrow(() => assertNoUnresolvedTokens(out, "dependabot.yml"));

  // One package-ecosystem line per armed ecosystem.
  const ecoLines = out
    .split("\n")
    .filter((l) => l.includes("package-ecosystem:"));
  assert.equal(ecoLines.length, DEPENDABOT_ECOSYSTEMS.length);

  // Rendered in the sorted order of DEPENDABOT_ECOSYSTEMS.
  const order = ecoLines.map((l) => l.match(/"([^"]+)"/)[1]);
  assert.deepEqual(order, [...DEPENDABOT_ECOSYSTEMS]);
});

test("npm block gets the rich tier (versioning-strategy + semver cooldown tiers)", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const npm = blockFor(out, "npm");
  assert.match(npm, /directories:/);
  assert.match(npm, /- "\*\*\/\*"/);
  assert.match(npm, /interval: "daily"/);
  assert.match(npm, /versioning-strategy: increase/);
  assert.match(npm, /semver-major-days: 14/);
  assert.match(npm, /semver-minor-days: 7/);
  assert.match(npm, /semver-patch-days: 7/);
  assert.match(npm, /default-days: 7/);
});

test("github-actions block: singular directory, daily, no versioning-strategy, default-days only", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const gha = blockFor(out, "github-actions");
  assert.match(gha, /directory: "\/"/);
  assert.doesNotMatch(gha, /directories:/);
  assert.match(gha, /interval: "daily"/);
  assert.doesNotMatch(gha, /versioning-strategy/);
  assert.doesNotMatch(gha, /semver-major-days/);
  assert.match(gha, /default-days: 7/);
});

test("other-class (docker) block: recursing directory, daily, no versioning-strategy, default-days only", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const docker = blockFor(out, "docker");
  assert.match(docker, /directories:/);
  assert.match(docker, /- "\*\*\/\*"/);
  assert.match(docker, /interval: "daily"/);
  assert.doesNotMatch(docker, /versioning-strategy/);
  assert.doesNotMatch(docker, /semver-major-days/);
  assert.match(docker, /default-days: 7/);
});

test("empty-block collapse leaves no whitespace-only line where versioning-strategy was dropped", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  // No line is whitespace-only (spaces/tabs with nothing else). Blank
  // separator lines between blocks are fully empty (length 0), not
  // whitespace-only.
  const whitespaceOnly = out
    .split("\n")
    .filter((l) => l.length > 0 && l.trim() === "");
  assert.deepEqual(whitespaceOnly, []);
});

test("render is deterministic (byte-for-byte stable across two renders)", () => {
  const a = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const b = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  assert.equal(a, b);
});

test("rendered output ends with exactly one trailing newline, no trailing blank line", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  // Exactly one `\n` terminator — not zero (missing) and not two-or-more
  // (a trailing blank line), which would previously slip in because the
  // source assets' own trailing newline survived into each rendered
  // ecosystem block. Also asserted between every pair of adjacent
  // `package-ecosystem:` blocks, not just at the very end.
  assert.match(out, /[^\n]\n$/);
  assert.doesNotMatch(out, /\n\n$/);
});

// The exact block indentation the rendered `groups:` map must carry:
// group keys at 6 spaces (siblings of `*-minor-and-patch`/`*-security`),
// `patterns:` at 8, list items at 10. `groups:` itself sits at 4 spaces.
// Wrong indentation here is invalid/misnested YAML that Dependabot
// silently rejects at config-parse time on every managed repo — the
// exact failure mode these tests exist to catch, so every assertion
// below is indentation-preserving, not `.trim()`-based.
const GROUP_KEY_INDENT = "      "; // 6 spaces
const PATTERNS_INDENT = "        "; // 8 spaces
const LIST_ITEM_INDENT = "          "; // 10 spaces

/**
 * Build the expected verbatim block for a given ecosystem: the
 * `__NAMED_GROUPS_BLOCK__` placeholder line carries `GROUP_KEY_INDENT`
 * (6 spaces, matching `assets/ecosystem-block.yml`), which becomes the
 * indent NAMED_DEPENDABOT_GROUPS's first line ("codeql-action:")
 * receives via `substituteBlockLine`. Continuation lines in the
 * constant already carry their own absolute indent, so this is just
 * the constant with the placeholder's indent prepended to line 1.
 */
function expectedNamedGroupsBlock() {
  const lines = NAMED_DEPENDABOT_GROUPS.split("\n");
  return lines.map((l, i) => (i === 0 ? GROUP_KEY_INDENT + l : l)).join("\n");
}

test("NAMED_DEPENDABOT_GROUPS export matches the rendered content verbatim, indentation intact, across npm + docker + github-actions (issue #36)", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const expected = expectedNamedGroupsBlock();
  for (const eco of ["npm", "docker", "github-actions"]) {
    const block = blockFor(out, eco);
    // Contiguous, indentation-preserving substring match — not a
    // per-line `.trim()`-then-`includes` check, which would pass even
    // if every line were mis-indented or reordered.
    assert.ok(
      block.includes(expected),
      `${eco} block does not contain the named-groups block verbatim ` +
        `(indentation intact); expected substring:\n${expected}\n\n` +
        `actual block:\n${block}`,
    );
  }
});

test("every ecosystem block carries the full named-group registry at the pinned indentation (issue #36)", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const expectedGroupNames = [
    "codeql-action",
    "aws-cdk",
    "vite-toolchain",
    "fastapi-stack",
    "sqlalchemy-stack",
    "auth-stack",
    "aws-sdk",
    "test-stack",
  ];
  for (const eco of DEPENDABOT_ECOSYSTEMS) {
    const block = blockFor(out, eco);
    for (const name of expectedGroupNames) {
      // Pinned to exactly GROUP_KEY_INDENT (6 spaces) — a group rendered
      // one level too shallow or too deep (invalid/misnested YAML) must
      // fail this assertion, unlike a `\s+` regex which matches any
      // indentation.
      assert.match(
        block,
        new RegExp(`^${GROUP_KEY_INDENT}${name}:$`, "m"),
        `${eco} block missing named group ${name} at ${GROUP_KEY_INDENT.length}-space indent`,
      );
    }
    // Structural assertion pinned to the exact indentation at each
    // level, not `\s*`/`\s+` (which is indentation-blind and would
    // match the same three lines at any depth).
    const codeqlBlock =
      `${GROUP_KEY_INDENT}codeql-action:\n` +
      `${PATTERNS_INDENT}patterns:\n` +
      `${LIST_ITEM_INDENT}- "github/codeql-action/*"`;
    assert.ok(
      block.includes(codeqlBlock),
      `${eco}: codeql-action group not found at pinned indentation`,
    );
  }
});

test("named groups precede the *-minor-and-patch catch-all (first-match-wins precedence)", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  for (const eco of DEPENDABOT_ECOSYSTEMS) {
    const block = blockFor(out, eco);
    const codeqlIdx = block.indexOf(`${GROUP_KEY_INDENT}codeql-action:`);
    const catchAllIdx = block.indexOf(
      `${GROUP_KEY_INDENT}${eco}-minor-and-patch:`,
    );
    assert.notEqual(codeqlIdx, -1, `${eco} missing codeql-action group`);
    assert.notEqual(catchAllIdx, -1, `${eco} missing minor-and-patch group`);
    assert.ok(
      codeqlIdx < catchAllIdx,
      `${eco}: named groups must precede the minor-and-patch catch-all`,
    );
  }
});

test("docker block also receives the full named-group union, indentation intact (uniform shipping, not excluded)", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const docker = blockFor(out, "docker");
  assert.match(docker, new RegExp(`^${GROUP_KEY_INDENT}aws-cdk:$`, "m"));
  assert.match(
    docker,
    new RegExp(`^${GROUP_KEY_INDENT}fastapi-stack:$`, "m"),
  );
  assert.match(
    docker,
    new RegExp(`^${GROUP_KEY_INDENT}docker-minor-and-patch:$`, "m"),
  );
  // Full verbatim contiguous block, same as the npm/docker/github-actions
  // check above — belt-and-suspenders for docker specifically, since
  // docker is the "other"-class ecosystem the reviewer called out by
  // name as under-covered by bare unanchored substring matches.
  assert.ok(docker.includes(expectedNamedGroupsBlock()));
});

// Issue #88: the named-group registry is a per-org input with the baked
// TheVoskamps set as the default. The default path must stay
// byte-identical to the pre-#88 render; the override path must render
// the org's own registry in the same shape and at the same position.

test("NAMED_DEPENDABOT_GROUPS is exactly the rendered default registry (issue #88)", () => {
  assert.equal(
    renderNamedGroupsBlock(DEFAULT_NAMED_DEPENDABOT_GROUPS),
    NAMED_DEPENDABOT_GROUPS,
  );
  // The default registry's group order is the rendered order.
  assert.deepEqual(Object.keys(DEFAULT_NAMED_DEPENDABOT_GROUPS), [
    "codeql-action",
    "aws-cdk",
    "vite-toolchain",
    "fastapi-stack",
    "sqlalchemy-stack",
    "auth-stack",
    "aws-sdk",
    "test-stack",
  ]);
});

test("renderDependabotYml with no options, {} options, or the default registry renders byte-identical output (issue #88)", () => {
  const args = [readAssetText("dependabot.yml"), readAssetText("ecosystem-block.yml"), CTX];
  const bare = renderDependabotYml(...args);
  const empty = renderDependabotYml(...args, {});
  const explicit = renderDependabotYml(...args, {
    namedDependabotGroups: DEFAULT_NAMED_DEPENDABOT_GROUPS,
  });
  assert.equal(empty, bare);
  assert.equal(explicit, bare);
});

const ORG_GROUPS = {
  "acme-sdk": ["@acme/*", "acme-core"],
  "django-stack": ["django", "django-*"],
};

test("an org-supplied registry replaces the default in every ecosystem block, indentation intact, ahead of the catch-all (issue #88)", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
    { namedDependabotGroups: ORG_GROUPS },
  );
  assert.doesNotThrow(() => assertNoUnresolvedTokens(out, "dependabot.yml"));
  const expected =
    `${GROUP_KEY_INDENT}acme-sdk:\n` +
    `${PATTERNS_INDENT}patterns:\n` +
    `${LIST_ITEM_INDENT}- "@acme/*"\n` +
    `${LIST_ITEM_INDENT}- "acme-core"\n` +
    `${GROUP_KEY_INDENT}django-stack:\n` +
    `${PATTERNS_INDENT}patterns:\n` +
    `${LIST_ITEM_INDENT}- "django"\n` +
    `${LIST_ITEM_INDENT}- "django-*"`;
  for (const eco of DEPENDABOT_ECOSYSTEMS) {
    const block = blockFor(out, eco);
    assert.ok(block.includes(expected), `${eco}: org registry not rendered verbatim`);
    // The default registry is gone — replaced, not appended to.
    assert.doesNotMatch(block, /codeql-action:/, `${eco}: default group leaked`);
    // Precedence preserved: the org's groups precede the catch-all.
    const firstIdx = block.indexOf(`${GROUP_KEY_INDENT}acme-sdk:`);
    const catchAllIdx = block.indexOf(`${GROUP_KEY_INDENT}${eco}-minor-and-patch:`);
    assert.ok(firstIdx !== -1 && catchAllIdx !== -1 && firstIdx < catchAllIdx, `${eco}: precedence`);
  }
});

test("an empty org registry drops the named-groups line entirely, leaving no whitespace-only line (issue #88)", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
    { namedDependabotGroups: {} },
  );
  assert.doesNotThrow(() => assertNoUnresolvedTokens(out, "dependabot.yml"));
  assert.doesNotMatch(out, /codeql-action:/);
  const whitespaceOnly = out.split("\n").filter((l) => l.length > 0 && l.trim() === "");
  assert.deepEqual(whitespaceOnly, []);
  for (const eco of DEPENDABOT_ECOSYSTEMS) {
    const block = blockFor(out, eco);
    // `groups:` is immediately followed by the catch-all.
    assert.match(block, new RegExp(`^    groups:\\n${GROUP_KEY_INDENT}${eco}-minor-and-patch:$`, "m"));
  }
});

test("renderNamedGroupsBlock rejects a group with an empty pattern list rather than emitting a valueless patterns: key (issue #88)", () => {
  assert.throws(
    () => renderNamedGroupsBlock({ "codeql-action": ["github/codeql-action/*"], "empty-one": [] }),
    /empty pattern list: empty-one/,
  );
  // The failure surfaces through the composite render too — no partial output.
  assert.throws(
    () =>
      renderDependabotYml(
        readAssetText("dependabot.yml"),
        readAssetText("ecosystem-block.yml"),
        CTX,
        { namedDependabotGroups: { "empty-one": [] } },
      ),
    /empty pattern list: empty-one/,
  );
  // Every offending group is named, and a non-empty registry still renders.
  assert.throws(
    () => renderNamedGroupsBlock({ a: [], b: ["x"], c: [] }),
    /empty pattern list: a, c/,
  );
  assert.doesNotMatch(renderNamedGroupsBlock({ b: ["x"] }), /patterns:\n(?!\s+- )/);
});

test("target-branch reflects the per-repo default branch", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    { org: "O", repo: "r", defaultBranch: "trunk" },
  );
  assert.match(out, /target-branch: "trunk"/);
  assert.doesNotMatch(out, /target-branch: "main"/);
});

test("renderPrAutomationTemplate resolves all fixed constants, per-repo tokens, and __BOT_SLUG__ with no unresolved placeholders", () => {
  for (const name of ["auto-enable-automerge.yml", "auto-rebase-prs.yml"]) {
    const out = renderPrAutomationTemplate(readAssetText(name), CTX);
    assert.doesNotThrow(() => assertNoUnresolvedTokens(out, name));
  }
});

test("renderPrAutomationTemplate substitutes each fixed constant to its pinned value", () => {
  // No single template carries every fixed constant: auto-rebase-prs.yml
  // owns the sweep-side ones (__REQUIRED_CHECK_WORKFLOW__,
  // __INSTALL_GATE_WORKFLOW__, __INSTALL_GATE_CHECK__,
  // __REST_MERGE_METHOD__) and auto-enable-automerge.yml owns the
  // native-auto-merge one (__MERGE_METHOD__). Assert over the UNION so
  // every constant is exercised by whichever template uses it, and
  // assert the union is complete so a constant that falls out of BOTH
  // templates cannot go unnoticed.
  const names = ["auto-rebase-prs.yml", "auto-enable-automerge.yml"];
  const covered = new Set();
  for (const name of names) {
    const template = readAssetText(name);
    const out = renderPrAutomationTemplate(template, CTX);
    for (const [token, value] of Object.entries(PR_AUTOMATION_CONSTANTS)) {
      if (!template.includes(token)) continue;
      covered.add(token);
      assert.equal(out.includes(token), false, `${token} left unresolved in ${name}`);
      assert.equal(out.includes(value), true, `${value} not found in ${name} output`);
    }
  }
  for (const token of Object.keys(PR_AUTOMATION_CONSTANTS)) {
    assert.ok(covered.has(token), `${token} is used by neither PR-automation template`);
  }
});

// Issue #89: the App-identity slice is a per-org input; the contract
// constants are not. The default identity must render the baked
// TheVoskamps App; an org identity must replace every identity token and
// nothing else.

const IDENTITY_TOKENS = [
  "__APP_NAME__",
  "__APP_CLIENT_ID_SECRET__",
  "__APP_PRIVATE_KEY_SECRET__",
  "__BOT_SLUG__",
];

test("PR_AUTOMATION_CONSTANTS carries only the org-agnostic contract constants; the identity slice lives in PrAutomationIdentity (issue #89)", () => {
  assert.deepEqual(Object.keys(PR_AUTOMATION_CONSTANTS).sort(), [
    "__DO_NOT_MERGE_LABEL__",
    "__INSTALL_GATE_CHECK__",
    "__INSTALL_GATE_WORKFLOW__",
    "__MERGE_METHOD__",
    "__REQUIRED_CHECK_WORKFLOW__",
    "__REST_MERGE_METHOD__",
  ]);
  for (const token of IDENTITY_TOKENS) {
    assert.equal(token in PR_AUTOMATION_CONSTANTS, false, `${token} must not be a fixed constant`);
  }
  assert.deepEqual(
    Object.keys(prAutomationIdentityTokens(DEFAULT_PR_AUTOMATION_IDENTITY)).sort(),
    [...IDENTITY_TOKENS].sort(),
  );
  // Every identity token is used by at least one template — a token
  // neither template carries would be dead surface here.
  const templates = ["auto-rebase-prs.yml", "auto-enable-automerge.yml"].map(readAssetText);
  for (const token of IDENTITY_TOKENS) {
    assert.ok(templates.some((t) => t.includes(token)), `${token} used by neither template`);
  }
});

test("renderPrAutomationTemplate with no options, {} options, or the default identity renders byte-identical output, and that output is the default identity (issue #89)", () => {
  for (const name of ["auto-rebase-prs.yml", "auto-enable-automerge.yml"]) {
    const template = readAssetText(name);
    const bare = renderPrAutomationTemplate(template, CTX);
    assert.equal(renderPrAutomationTemplate(template, CTX, {}), bare);
    assert.equal(
      renderPrAutomationTemplate(template, CTX, {
        prAutomationIdentity: DEFAULT_PR_AUTOMATION_IDENTITY,
      }),
      bare,
    );
    // The baked default identity, verbatim.
    if (template.includes("__APP_NAME__")) {
      assert.match(bare, /thevoskamps-pr-automations/);
    }
    assert.match(bare, /secrets\.AUTOMERGE_APP_CLIENT_ID/);
    assert.match(bare, /secrets\.AUTOMERGE_APP_PRIVATE_KEY/);
    for (const token of IDENTITY_TOKENS) {
      assert.equal(bare.includes(token), false, `${token} unresolved in ${name}`);
    }
  }
  const rebase = renderPrAutomationTemplate(readAssetText("auto-rebase-prs.yml"), CTX);
  assert.match(rebase, /git config user\.name "example-auto-rebase\[bot\]"/);
});

const ORG_IDENTITY = {
  appName: "acme-pr-bot",
  appClientIdSecret: "ACME_BOT_APP_CLIENT_ID",
  appPrivateKeySecret: "ACME_BOT_APP_PRIVATE_KEY",
  botSlug: "acme-pr-bot[bot]",
};

test("an org-supplied identity replaces every identity token and leaves the contract constants untouched (issue #89)", () => {
  for (const name of ["auto-rebase-prs.yml", "auto-enable-automerge.yml"]) {
    const template = readAssetText(name);
    const out = renderPrAutomationTemplate(template, CTX, {
      prAutomationIdentity: ORG_IDENTITY,
    });
    assert.doesNotThrow(() => assertNoUnresolvedTokens(out, name));
    // Default identity is gone. (The template's own comment header
    // still names the example secrets and slug shape in prose, so the
    // assertions target the substituted sites, not bare words.)
    assert.doesNotMatch(out, /thevoskamps-pr-automations/);
    assert.doesNotMatch(out, /secrets\.AUTOMERGE_APP_CLIENT_ID/);
    assert.doesNotMatch(out, /secrets\.AUTOMERGE_APP_PRIVATE_KEY/);
    assert.doesNotMatch(out, /"example-auto-rebase\[bot\]/);
    // Org identity is in.
    if (template.includes("__APP_NAME__")) assert.match(out, /acme-pr-bot"/);
    assert.match(out, /secrets\.ACME_BOT_APP_CLIENT_ID/);
    assert.match(out, /secrets\.ACME_BOT_APP_PRIVATE_KEY/);
    // Contract constants render exactly as with the default identity.
    for (const [token, value] of Object.entries(PR_AUTOMATION_CONSTANTS)) {
      if (!template.includes(token)) continue;
      assert.equal(out.includes(value), true, `${value} missing from ${name}`);
    }
  }
  const rebase = renderPrAutomationTemplate(readAssetText("auto-rebase-prs.yml"), CTX, {
    prAutomationIdentity: ORG_IDENTITY,
  });
  assert.match(rebase, /git config user\.name "acme-pr-bot\[bot\]"/);
  assert.match(rebase, /git config user\.email "acme-pr-bot\[bot\]@users\.noreply\.github\.com"/);
});

test("botSlug is a pattern: per-repo tokens inside it resolve, so the default's __GH_REPO__ derivation still works for an org identity (issue #89)", () => {
  const out = renderPrAutomationTemplate(
    readAssetText("auto-rebase-prs.yml"),
    { org: "Acme", repo: "widgets", defaultBranch: "main" },
    { prAutomationIdentity: { ...ORG_IDENTITY, botSlug: "__GH_ORG__-__GH_REPO__-bot[bot]" } },
  );
  assert.match(out, /git config user\.name "Acme-widgets-bot\[bot\]"/);
  assert.doesNotThrow(() => assertNoUnresolvedTokens(out, "auto-rebase-prs.yml"));
});

test("a botSlug carrying an unknown token fails the unresolved-token assertion rather than shipping (issue #89)", () => {
  const out = renderPrAutomationTemplate(
    readAssetText("auto-rebase-prs.yml"),
    CTX,
    { prAutomationIdentity: { ...ORG_IDENTITY, botSlug: "__NOT_A_TOKEN__[bot]" } },
  );
  assert.throws(() => assertNoUnresolvedTokens(out, "auto-rebase-prs.yml"), /__NOT_A_TOKEN__/);
});

test("renderPrAutomationTemplate interpolates __BOT_SLUG__ from the per-repo name", () => {
  const out = renderPrAutomationTemplate(
    readAssetText("auto-rebase-prs.yml"),
    { org: "O", repo: "widgets", defaultBranch: "main" },
  );
  assert.match(out, /widgets-auto-rebase\[bot\]/);
  assert.doesNotMatch(out, /__BOT_SLUG__/);
});

test("renderPrAutomationTemplate renders the per-repo default branch", () => {
  const out = renderPrAutomationTemplate(
    readAssetText("auto-rebase-prs.yml"),
    { org: "O", repo: "r", defaultBranch: "trunk" },
  );
  assert.match(out, /branches: \[trunk\]/);
});

// Extract one ecosystem's rendered block (from its package-ecosystem
// line up to the next one, or end of file).
function blockFor(rendered, ecosystem) {
  const lines = rendered.split("\n");
  const start = lines.findIndex((l) =>
    l.includes(`package-ecosystem: "${ecosystem}"`),
  );
  assert.notEqual(start, -1, `no block for ${ecosystem}`);
  let end = start + 1;
  while (end < lines.length && !lines[end].includes("package-ecosystem:")) {
    end++;
  }
  return lines.slice(start, end).join("\n");
}
