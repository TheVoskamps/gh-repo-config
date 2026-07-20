import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderTemplate,
  assertNoUnresolvedTokens,
  renderDependabotYml,
  renderPrAutomationTemplate,
  DEPENDABOT_ECOSYSTEMS,
  PR_AUTOMATION_CONSTANTS,
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

test("github-actions block: singular directory, weekly, no versioning-strategy, default-days only", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    CTX,
  );
  const gha = blockFor(out, "github-actions");
  assert.match(gha, /directory: "\/"/);
  assert.doesNotMatch(gha, /directories:/);
  assert.match(gha, /interval: "weekly"/);
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
  // auto-rebase-prs.yml carries every one of the 9 fixed constants (it is
  // the only template with __INSTALL_GATE_WORKFLOW__ /
  // __INSTALL_GATE_NPM_CHECK__); auto-enable-automerge.yml carries a
  // subset. Assert against the template that carries the full set.
  const template = readAssetText("auto-rebase-prs.yml");
  const out = renderPrAutomationTemplate(template, CTX);
  for (const [token, value] of Object.entries(PR_AUTOMATION_CONSTANTS)) {
    if (!template.includes(token)) continue;
    assert.equal(out.includes(token), false, `${token} left unresolved`);
    assert.equal(out.includes(value), true, `${value} not found in output`);
  }
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
