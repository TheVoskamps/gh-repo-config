import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveManaged,
  normalizeMode,
  normalizeOrgDefault,
} from "../dist/index.js";

test("explicit process is managed regardless of org default", () => {
  assert.equal(resolveManaged("process", "opt-in"), true);
  assert.equal(resolveManaged("process", "opt-out"), true);
});

test("explicit ignore is never managed (fail safe)", () => {
  assert.equal(resolveManaged("ignore", "opt-in"), false);
  assert.equal(resolveManaged("ignore", "opt-out"), false);
});

test("unset follows org default", () => {
  assert.equal(resolveManaged("unset", "opt-in"), false);
  assert.equal(resolveManaged("unset", "opt-out"), true);
});

test("normalizeMode recognizes only process and ignore", () => {
  assert.equal(normalizeMode("process"), "process");
  assert.equal(normalizeMode("ignore"), "ignore");
  assert.equal(normalizeMode("PROCESS"), "unset"); // case-sensitive
  assert.equal(normalizeMode(""), "unset");
  assert.equal(normalizeMode(undefined), "unset");
  assert.equal(normalizeMode(null), "unset");
  assert.equal(normalizeMode("typo"), "unset");
});

test("normalizeOrgDefault falls back to opt-in when absent or unknown", () => {
  assert.equal(normalizeOrgDefault("opt-out"), "opt-out");
  assert.equal(normalizeOrgDefault("opt-in"), "opt-in");
  assert.equal(normalizeOrgDefault(undefined), "opt-in");
  assert.equal(normalizeOrgDefault(null), "opt-in");
  assert.equal(normalizeOrgDefault("garbage"), "opt-in");
});
