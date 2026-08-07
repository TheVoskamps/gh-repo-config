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

// Anchored on purpose: a prerelease or build-metadata version
// (`0.3.0-rc.1`, `0.3.0+build5`) must fail here rather than ship.
// `src/version-compare.ts` compares only the `MAJOR.MINOR.PATCH` core,
// so `0.3.0-rc.1` and `0.3.0` are indistinguishable to `isBehind` — a
// repo stamped with the prerelease would be judged current and never
// converge to the release. That module's docstring cites this
// assertion as the guarantee making its core-only parse safe, so the
// anchor is load-bearing: an unanchored `/^\d+\.\d+\.\d+/` matches the
// leading core of `0.3.0-rc.1` and would accept it.
test("CURRENT_VERSION is a plain X.Y.Z version, with no prerelease or build metadata", () => {
  assert.match(CURRENT_VERSION, /^\d+\.\d+\.\d+$/);
});
