import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContentsClient,
  convergeRepoFiles,
  buildDesiredFiles,
  CONVERGE_BRANCH,
  FILE_MODE,
} from "../dist/index.js";

// A programmable fake fetch: routes matched by (method, url-substring)
// with an optional predicate; each returns a canned body. Records calls.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    for (const route of routes) {
      const methodMatch = (route.method ?? "GET") === method;
      const urlMatch = url.includes(route.match);
      const predMatch = route.when ? route.when(url, body) : true;
      if (methodMatch && urlMatch && predMatch) {
        const status = route.status ?? 200;
        return {
          ok: status < 400,
          status,
          statusText: route.statusText ?? "OK",
          json: async () => route.body ?? {},
        };
      }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const OWNER = "TheVoskamps";
const REPO = "example";
const CTX = { org: OWNER, repo: REPO, defaultBranch: "main" };

// Build a base64 blob body for a given content string.
function blobBody(content) {
  return { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" };
}

// Routes that make the target repo report a given tree + blob contents.
// `treeEntries` maps path -> { sha, mode }; `blobs` maps sha -> content.
function readRoutes({ treeEntries = {}, blobs = {} }) {
  const tree = Object.entries(treeEntries).map(([path, e]) => ({
    path,
    mode: e.mode,
    type: "blob",
    sha: e.sha,
  }));
  return [
    { match: `/repos/${OWNER}/${REPO}`, when: (u) => u.endsWith(`/${REPO}`), body: { default_branch: "main" } },
    { match: "/git/ref/heads/main", body: { object: { sha: "basecommit" } } },
    { match: "/git/trees/basecommit", body: { tree, truncated: false } },
    ...Object.entries(blobs).map(([sha, content]) => ({
      match: `/git/blobs/${sha}`,
      body: blobBody(content),
    })),
  ];
}

// Write routes: blob/tree/commit creation, ref set, PR list/create.
function writeRoutes({ openPr = [] } = {}) {
  return [
    { match: "/git/blobs", method: "POST", body: { sha: "newblob" } },
    { match: "/git/trees", method: "POST", body: { sha: "newtree" } },
    { match: "/git/commits", method: "POST", body: { sha: "newcommit" } },
    { match: "/git/refs/heads/" + CONVERGE_BRANCH, method: "PATCH", body: {} },
    { match: "/git/refs", method: "POST", body: {} },
    { match: "/pulls?state=open", method: "GET", body: openPr },
    { match: "/pulls", method: "POST", body: { number: 42, html_url: "https://example/pr/42", head: { ref: CONVERGE_BRANCH } } },
  ];
}

test("no diff → no branch, no PR (complete no-op)", async () => {
  // Precompute the desired files and seed the target tree with their
  // exact content and correct modes so nothing differs.
  const desired = buildDesiredFiles(CTX);
  const treeEntries = {};
  const blobs = {};
  for (const f of desired) {
    const sha = "sha-" + f.path;
    treeEntries[f.path] = {
      sha,
      mode: f.executable ? FILE_MODE.executable : FILE_MODE.regular,
    };
    blobs[sha] = f.content;
  }
  const fetch = fakeFetch([...readRoutes({ treeEntries, blobs })]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  assert.equal(result.noop, true);
  assert.deepEqual(result.changed, []);
  assert.equal(result.pullRequest, undefined);
  // No write calls were made.
  assert.equal(fetch.calls.some((c) => c.method !== "GET"), false);
});

test("empty target → all files changed, blobs+tree+commit+ref+PR created", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  assert.equal(result.noop, false);
  assert.equal(result.changed.length, buildDesiredFiles(CTX).length);
  assert.deepEqual(result.pullRequest, {
    number: 42,
    url: "https://example/pr/42",
    updated: false,
  });

  // A blob was created per changed file; a new ref was created (POST),
  // not force-updated (PATCH), since no PR was open.
  const blobPosts = fetch.calls.filter(
    (c) => c.method === "POST" && c.url.includes("/git/blobs"),
  );
  assert.equal(blobPosts.length, result.changed.length);
  assert.equal(
    fetch.calls.some((c) => c.method === "POST" && c.url.endsWith("/git/refs")),
    true,
  );
  assert.equal(
    fetch.calls.some((c) => c.method === "PATCH"),
    false,
  );
});

test("scripts land with mode 100755 in the created tree", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  await convergeRepoFiles(client, OWNER, REPO, false);

  const treePost = fetch.calls.find(
    (c) => c.method === "POST" && c.url.includes("/git/trees"),
  );
  const scriptEntries = treePost.body.tree.filter((e) =>
    e.path.endsWith(".sh"),
  );
  assert.ok(scriptEntries.length > 0);
  for (const e of scriptEntries) {
    assert.equal(e.mode, "100755", `${e.path} must be executable`);
  }
  const ymlEntries = treePost.body.tree.filter((e) => e.path.endsWith(".yml"));
  for (const e of ymlEntries) {
    assert.equal(e.mode, "100644", `${e.path} must not be executable`);
  }
});

test("right-content-wrong-mode script counts as differing", async () => {
  // Seed EVERY desired file with correct content, but give the scripts
  // mode 100644 (right content, wrong mode). Only the scripts should
  // differ.
  const desired = buildDesiredFiles(CTX);
  const treeEntries = {};
  const blobs = {};
  for (const f of desired) {
    const sha = "sha-" + f.path;
    // Wrong mode for scripts (100644 instead of 100755).
    treeEntries[f.path] = { sha, mode: FILE_MODE.regular };
    blobs[sha] = f.content;
  }
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries, blobs }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  assert.equal(result.noop, false);
  // Only the .sh files differ (their mode is wrong); .yml files match.
  const expected = desired.filter((f) => f.executable).map((f) => f.path);
  assert.deepEqual(result.changed.sort(), expected.sort());
});

test("existing open converger PR → branch is force-updated, no second PR", async () => {
  const openPr = [
    { number: 7, html_url: "https://example/pr/7", head: { ref: CONVERGE_BRANCH } },
  ];
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  assert.deepEqual(result.pullRequest, {
    number: 7,
    url: "https://example/pr/7",
    updated: true,
  });
  // The ref was PATCHed (force-updated), and no new PR was POSTed.
  assert.equal(
    fetch.calls.some((c) => c.method === "PATCH" && c.url.includes("/git/refs/heads/")),
    true,
  );
  assert.equal(
    fetch.calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls")),
    false,
  );
});

test("dryRun → diffs computed, nothing written", async () => {
  const fetch = fakeFetch([...readRoutes({ treeEntries: {}, blobs: {} })]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, true);

  assert.equal(result.noop, false);
  assert.equal(result.changed.length, buildDesiredFiles(CTX).length);
  assert.equal(result.pullRequest, undefined);
  // No mutating calls.
  assert.equal(fetch.calls.some((c) => c.method !== "GET"), false);
});

test("readTree throws on a truncated tree rather than converging blind", async () => {
  const fetch = fakeFetch([
    { match: `/repos/${OWNER}/${REPO}`, when: (u) => u.endsWith(`/${REPO}`), body: { default_branch: "main" } },
    { match: "/git/ref/heads/main", body: { object: { sha: "basecommit" } } },
    { match: "/git/trees/basecommit", body: { tree: [], truncated: true } },
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  await assert.rejects(
    () => convergeRepoFiles(client, OWNER, REPO, false),
    /truncated/,
  );
});
