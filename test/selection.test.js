import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveManaged,
  normalizeMode,
  normalizeDefaultMode,
} from "../dist/index.js";

// The truth table in docs/repo-selection.md, one test per row group.

test("explicit opt-in is managed regardless of the declared default", () => {
  assert.equal(resolveManaged("opt-in", "opt-in"), true);
  assert.equal(resolveManaged("opt-in", "opt-out"), true);
});

test("explicit opt-out is never managed regardless of the declared default", () => {
  assert.equal(resolveManaged("opt-out", "opt-in"), false);
  assert.equal(resolveManaged("opt-out", "opt-out"), false);
});

test("unset follows the declared default", () => {
  assert.equal(resolveManaged("unset", "opt-in"), true);
  assert.equal(resolveManaged("unset", "opt-out"), false);
});

test("normalizeMode recognizes only opt-in and opt-out", () => {
  assert.equal(normalizeMode("opt-in"), "opt-in");
  assert.equal(normalizeMode("opt-out"), "opt-out");
  assert.equal(normalizeMode("OPT-IN"), "unset"); // case-sensitive
  assert.equal(normalizeMode(""), "unset");
  assert.equal(normalizeMode(undefined), "unset");
  assert.equal(normalizeMode(null), "unset");
  assert.equal(normalizeMode("typo"), "unset");
  // The retired vocabulary is not recognized: a repo still carrying
  // `process` reads as unset and follows the declared default, never as
  // an opt-in.
  assert.equal(normalizeMode("process"), "unset");
  assert.equal(normalizeMode("ignore"), "unset");
});

test("normalizeDefaultMode falls back to opt-out when absent or unknown", () => {
  assert.equal(normalizeDefaultMode("opt-in"), "opt-in");
  assert.equal(normalizeDefaultMode("opt-out"), "opt-out");
  assert.equal(normalizeDefaultMode(undefined), "opt-out");
  assert.equal(normalizeDefaultMode(null), "opt-out");
  assert.equal(normalizeDefaultMode("garbage"), "opt-out");
});

test("an unrecognized repo value under an opt-in default is still managed", () => {
  // Both fail-safe collapses meeting at once: the repo value collapses to
  // `unset`, which then reads through to the declared default rather than
  // to a hardcoded verdict.
  assert.equal(resolveManaged(normalizeMode("process"), "opt-in"), true);
  assert.equal(resolveManaged(normalizeMode("process"), "opt-out"), false);
});
