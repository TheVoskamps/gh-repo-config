import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderTemplate,
  assertNoUnresolvedTokens,
  renderDependabotYml,
  DEPENDABOT_ECOSYSTEMS,
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

test("target-branch reflects the per-repo default branch", () => {
  const out = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    { org: "O", repo: "r", defaultBranch: "trunk" },
  );
  assert.match(out, /target-branch: "trunk"/);
  assert.doesNotMatch(out, /target-branch: "main"/);
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
