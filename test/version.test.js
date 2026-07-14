import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CURRENT_VERSION, PACKAGE_NAME } from "../dist/index.js";

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
);

test("CURRENT_VERSION matches package.json version", () => {
  assert.equal(CURRENT_VERSION, pkg.version);
});

test("PACKAGE_NAME matches package.json name", () => {
  assert.equal(PACKAGE_NAME, pkg.name);
});

test("CURRENT_VERSION is a non-empty semver-shaped string", () => {
  assert.match(CURRENT_VERSION, /^\d+\.\d+\.\d+/);
});
