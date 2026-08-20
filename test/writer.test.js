import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContentsClient,
  convergeRepoFiles,
  buildDesiredFiles,
  readOrgCommunityFiles,
  COMMUNITY_FILE_PATHS,
  COMMUNITY_SOURCE_REPO,
  CONVERGE_BRANCH,
  FILE_MODE,
  SWEEPER_WORKFLOW_PATH,
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

// The org's community-file seed content, served from its `.github` repo
// (issue #90). Every route set below carries these by default so the
// pre-#90 seeding expectations hold; individual tests drop a file or the
// whole repo to exercise the absent cases.
const ORG_COMMUNITY = {
  CONTRIBUTORS: "Ada Lovelace <ada@example.org>\n",
  LICENSE: "MIT License\n\nCopyright (c) TheVoskamps\n",
  PATENTS: "No patent grant.\n",
  "PRIOR_ART.md": "# Prior art\n",
};
const COMMUNITY_URL = `/repos/${OWNER}/${COMMUNITY_SOURCE_REPO}/contents/`;

// Routes for the org's `.github` repo contents API. `files` maps path ->
// content for the files present there; `repoExists: false` 404s every
// path (an org with no `.github` repo at all). A path not in `files` 404s.
function communityRoutes({ files = ORG_COMMUNITY, repoExists = true } = {}) {
  const routes = [];
  if (repoExists) {
    for (const [path, content] of Object.entries(files)) {
      routes.push({
        match: `${COMMUNITY_URL}${path}`,
        body: { type: "file", ...blobBody(content) },
      });
    }
  }
  routes.push({ match: COMMUNITY_URL, status: 404, statusText: "Not Found", body: {} });
  return routes;
}

// Routes that make the target repo report a given tree + blob contents.
// `treeEntries` maps path -> { sha, mode }; `blobs` maps sha -> content.
function readRoutes({ treeEntries = {}, blobs = {}, community = {} }) {
  const tree = Object.entries(treeEntries).map(([path, e]) => ({
    path,
    mode: e.mode,
    type: "blob",
    sha: e.sha,
  }));
  return [
    ...communityRoutes(community),
    { match: `/repos/${OWNER}/${REPO}`, when: (u) => u.endsWith(`/${REPO}`), body: { default_branch: "main" } },
    { match: "/git/ref/heads/main", body: { object: { sha: "basecommit" } } },
    { match: "/git/trees/basecommit", body: { tree, truncated: false } },
    ...Object.entries(blobs).map(([sha, content]) => ({
      match: `/git/blobs/${sha}`,
      body: blobBody(content),
    })),
  ];
}

// Write routes: blob/tree/commit creation, ref set, PR list/create, and
// the ready-to-draft GraphQL mutation (issue #92).
function writeRoutes({ openPr = [] } = {}) {
  return [
    { match: "/git/blobs", method: "POST", body: { sha: "newblob" } },
    { match: "/git/trees", method: "POST", body: { sha: "newtree" } },
    { match: "/git/commits", method: "POST", body: { sha: "newcommit" } },
    { match: "/git/refs/heads/" + CONVERGE_BRANCH, method: "PATCH", body: {} },
    { match: "/git/refs", method: "POST", body: {} },
    { match: "/pulls?state=open", method: "GET", body: openPr },
    { match: "/pulls", method: "POST", body: { number: 42, node_id: "PR_42", html_url: "https://example/pr/42", head: { ref: CONVERGE_BRANCH } } },
    { match: "/graphql", method: "POST", body: { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } } },
  ];
}

test("no diff → no branch, no PR (complete no-op)", async () => {
  // Precompute the desired files and seed the target tree with their
  // exact content and correct modes so nothing differs.
  const desired = buildDesiredFiles(CTX, { communityFiles: ORG_COMMUNITY });
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
  assert.equal(
    result.changed.length,
    buildDesiredFiles(CTX, { communityFiles: ORG_COMMUNITY }).length,
  );
  assert.deepEqual(result.pullRequest, {
    number: 42,
    url: "https://example/pr/42",
    updated: false,
    draft: false,
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
  const desired = buildDesiredFiles(CTX, { communityFiles: ORG_COMMUNITY });
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
    draft: false,
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
  assert.equal(
    result.changed.length,
    buildDesiredFiles(CTX, { communityFiles: ORG_COMMUNITY }).length,
  );
  assert.equal(result.pullRequest, undefined);
  // No mutating calls.
  assert.equal(fetch.calls.some((c) => c.method !== "GET"), false);
});

const COMMUNITY_PATHS = ["CONTRIBUTORS", "LICENSE", "PATENTS", "PRIOR_ART.md"];

test("bare target: all four community files are seeded alongside the other payloads", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  for (const path of COMMUNITY_PATHS) {
    assert.ok(result.changed.includes(path), `${path} should be seeded`);
  }
});

test("target with its own LICENSE at root keeps it byte-for-byte (never overwritten)", async () => {
  const desired = buildDesiredFiles(CTX, { communityFiles: ORG_COMMUNITY });
  const license = desired.find((f) => f.path === "LICENSE");
  const treeEntries = {
    LICENSE: { sha: "own-license-sha", mode: FILE_MODE.regular },
  };
  const blobs = { "own-license-sha": "totally different content" };
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries, blobs }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  assert.equal(result.changed.includes("LICENSE"), false);
  // No blob read was issued for the existing LICENSE — the seed-if-absent
  // check short-circuits before any content compare.
  assert.equal(
    fetch.calls.some((c) => c.url.includes("/git/blobs/own-license-sha")),
    false,
  );
  assert.notEqual(license.content, "totally different content");
});

test("target with its own LICENSE under .github/ keeps it (honored location)", async () => {
  const treeEntries = {
    ".github/LICENSE": { sha: "gh-license-sha", mode: FILE_MODE.regular },
  };
  const blobs = { "gh-license-sha": "own copy under .github/" };
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries, blobs }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  assert.equal(result.changed.includes("LICENSE"), false);
});

test("target with its own LICENSE under docs/ keeps it (honored location)", async () => {
  const treeEntries = {
    "docs/LICENSE": { sha: "docs-license-sha", mode: FILE_MODE.regular },
  };
  const blobs = { "docs-license-sha": "own copy under docs/" };
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries, blobs }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);

  assert.equal(result.changed.includes("LICENSE"), false);
});

test("idempotent re-run: a target already seeded with the converger's own community files is a no-op for them", async () => {
  const desired = buildDesiredFiles(CTX, { communityFiles: ORG_COMMUNITY });
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
  for (const path of COMMUNITY_PATHS) {
    assert.equal(result.changed.includes(path), false);
  }
});

test("readTree throws on a truncated tree rather than converging blind", async () => {
  const fetch = fakeFetch([
    ...communityRoutes(),
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

// Issue #90: community-file seed content comes from the org's `.github`
// repo at sweep time; absence (file or whole repo) is "nothing to seed".

test("bare target: the seeded community files carry the org's .github-repo content, not any asset (issue #90)", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);
  for (const path of COMMUNITY_PATHS) {
    assert.ok(result.changed.includes(path), `${path} seeded`);
  }
  // Each community file's blob was created from the org's own content.
  const blobPosts = fetch.calls
    .filter((c) => c.method === "POST" && c.url.includes("/git/blobs"))
    .map((c) => Buffer.from(c.body.content, "base64").toString("utf8"));
  for (const path of COMMUNITY_PATHS) {
    assert.ok(blobPosts.includes(ORG_COMMUNITY[path]), `${path} content is the org's`);
  }
  // The lookup went to the org's `.github` repo root, once per file.
  const lookups = fetch.calls.filter((c) => c.url.includes(COMMUNITY_URL));
  assert.deepEqual(
    lookups.map((c) => c.url.slice(c.url.indexOf(COMMUNITY_URL) + COMMUNITY_URL.length)),
    [...COMMUNITY_FILE_PATHS],
  );
});

test("a file absent from the org's .github repo is silently not seeded; the others still are (issue #90)", async () => {
  const { LICENSE, ...withoutLicense } = ORG_COMMUNITY;
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {}, community: { files: withoutLicense } }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);
  assert.equal(result.noop, false);
  assert.equal(result.changed.includes("LICENSE"), false);
  for (const path of ["CONTRIBUTORS", "PATENTS", "PRIOR_ART.md"]) {
    assert.ok(result.changed.includes(path), `${path} seeded`);
  }
  // No empty LICENSE blob was written.
  const blobPosts = fetch.calls.filter((c) => c.method === "POST" && c.url.includes("/git/blobs"));
  assert.equal(blobPosts.some((c) => c.body.content === ""), false);
});

test("an org with no .github repo at all seeds no community file, and the converge proceeds normally (issue #90)", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {}, community: { repoExists: false } }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false);
  assert.equal(result.noop, false);
  for (const path of COMMUNITY_PATHS) {
    assert.equal(result.changed.includes(path), false, `${path} not seeded`);
  }
  // Everything else was still converged and the PR opened.
  assert.equal(
    result.changed.length,
    buildDesiredFiles(CTX, { communityFiles: {} }).length,
  );
  assert.deepEqual(result.pullRequest, { number: 42, url: "https://example/pr/42", updated: false, draft: false });
});

test("caller-supplied communityFiles are used as-is and the org's .github repo is not read (issue #90)", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {}, community: { repoExists: false } }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false, {
    communityFiles: { LICENSE: "supplied license\n" },
  });
  assert.ok(result.changed.includes("LICENSE"));
  assert.equal(result.changed.includes("CONTRIBUTORS"), false);
  assert.equal(fetch.calls.some((c) => c.url.includes(COMMUNITY_URL)), false);
});

test("a non-404 failure reading the org's .github repo propagates rather than silently seeding nothing (issue #90)", async () => {
  const fetch = fakeFetch([
    { match: COMMUNITY_URL, status: 500, statusText: "Internal Server Error", body: {} },
    ...readRoutes({ treeEntries: {}, blobs: {} }).filter((r) => !r.match.startsWith(COMMUNITY_URL)),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  await assert.rejects(() => convergeRepoFiles(client, OWNER, REPO, false), /Failed to read CONTRIBUTORS from TheVoskamps\/\.github: 500/);
});

test("readOrgCommunityFiles returns exactly the present files, decoded (issue #90)", async () => {
  const { PATENTS, ...present } = ORG_COMMUNITY;
  const fetch = fakeFetch(communityRoutes({ files: present }));
  const client = new ContentsClient({ token: "t", fetch });
  assert.deepEqual(await readOrgCommunityFiles(client, OWNER), present);

  const none = new ContentsClient({
    token: "t",
    fetch: fakeFetch(communityRoutes({ repoExists: false })),
  });
  assert.deepEqual(await readOrgCommunityFiles(none, OWNER), {});
});

// Issue #92: under `sweeper-update-policy: manual` a converger PR that
// touches the sweeper repo's own trust-anchor workflow is a DRAFT. That
// is the hold itself — nothing merges a draft, so it does not depend on
// a `protect-main` ruleset a first-tick sweeper repo has not got yet, nor
// on `auto-enable-automerge.yml` declining to enable native auto-merge.
const SWEEPER_OPTIONS = { sweeperRepo: `${OWNER}/${REPO}` };

// The PR-create call's request body, or undefined when none was made.
function createdPr(fetch) {
  return fetch.calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"))
    ?.body;
}

function graphqlCalls(fetch) {
  return fetch.calls.filter((c) => c.url.endsWith("/graphql"));
}

test("a sweeper-repo PR carrying the trust anchor is opened as a draft under manual (issue #92)", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false, {
    ...SWEEPER_OPTIONS,
    sweeperUpdatePolicy: "manual",
  });

  assert.ok(result.changed.includes(SWEEPER_WORKFLOW_PATH));
  assert.equal(result.pullRequest.draft, true);
  assert.equal(createdPr(fetch).draft, true);
  // The reviewer who finds a draft converger PR learns why from the body.
  assert.match(createdPr(fetch).body, /\*\*draft\*\*/);
  assert.match(createdPr(fetch).body, /mark it ready for review/);
});

test("an absent policy drafts the anchor PR exactly as manual does (issue #92)", async () => {
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false, SWEEPER_OPTIONS);
  assert.equal(result.pullRequest.draft, true);
  assert.equal(createdPr(fetch).draft, true);
});

test("under auto, and on any repo that is not the sweeper, the PR is not a draft (issue #92)", async () => {
  for (const options of [
    { ...SWEEPER_OPTIONS, sweeperUpdatePolicy: "auto" },
    // `off` renders no anchor at all, so there is nothing to hold.
    { ...SWEEPER_OPTIONS, sweeperUpdatePolicy: "off" },
    { sweeperRepo: `${OWNER}/some-other-repo`, sweeperUpdatePolicy: "manual" },
    {},
  ]) {
    const fetch = fakeFetch([
      ...readRoutes({ treeEntries: {}, blobs: {} }),
      ...writeRoutes({ openPr: [] }),
    ]);
    const client = new ContentsClient({ token: "t", fetch });
    const result = await convergeRepoFiles(client, OWNER, REPO, false, options);
    assert.equal(result.pullRequest.draft, false, JSON.stringify(options));
    assert.equal(createdPr(fetch).draft, false, JSON.stringify(options));
    assert.equal(createdPr(fetch).body.includes("draft"), false);
  }
});

test("a sweeper-repo PR that does not carry the anchor is not a draft (issue #92)", async () => {
  // Seed the target with the anchor already at its desired content, so
  // this commit's changed paths exclude it.
  const desired = buildDesiredFiles(CTX, {
    ...SWEEPER_OPTIONS,
    communityFiles: ORG_COMMUNITY,
  });
  const anchor = desired.find((f) => f.path === SWEEPER_WORKFLOW_PATH);
  const fetch = fakeFetch([
    ...readRoutes({
      treeEntries: { [SWEEPER_WORKFLOW_PATH]: { sha: "anchor-sha", mode: FILE_MODE.regular } },
      blobs: { "anchor-sha": anchor.content },
    }),
    ...writeRoutes({ openPr: [] }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false, SWEEPER_OPTIONS);

  assert.equal(result.changed.includes(SWEEPER_WORKFLOW_PATH), false);
  assert.equal(result.noop, false);
  assert.equal(result.pullRequest.draft, false);
  assert.equal(createdPr(fetch).draft, false);
});

test("an open non-draft converger PR is converted to a draft when the anchor lands on it (issue #92)", async () => {
  const openPr = [
    { number: 7, node_id: "PR_7", html_url: "https://example/pr/7", draft: false, head: { ref: CONVERGE_BRANCH } },
  ];
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr }),
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  const result = await convergeRepoFiles(client, OWNER, REPO, false, SWEEPER_OPTIONS);

  assert.equal(result.pullRequest.draft, true);
  // REST cannot set `draft` on an existing PR, so the conversion is the
  // GraphQL mutation, addressed by the PR's node id.
  const mutations = graphqlCalls(fetch);
  assert.equal(mutations.length, 1);
  assert.match(mutations[0].body.query, /convertPullRequestToDraft/);
  assert.deepEqual(mutations[0].body.variables, { id: "PR_7" });
});

test("an already-draft converger PR is left alone, and a non-anchor update never drafts one (issue #92)", async () => {
  const cases = [
    { openPr: [{ number: 7, node_id: "PR_7", html_url: "https://example/pr/7", draft: true, head: { ref: CONVERGE_BRANCH } }], options: SWEEPER_OPTIONS, expectDraft: true },
    { openPr: [{ number: 7, node_id: "PR_7", html_url: "https://example/pr/7", draft: false, head: { ref: CONVERGE_BRANCH } }], options: { ...SWEEPER_OPTIONS, sweeperUpdatePolicy: "auto" }, expectDraft: false },
  ];
  for (const { openPr, options, expectDraft } of cases) {
    const fetch = fakeFetch([
      ...readRoutes({ treeEntries: {}, blobs: {} }),
      ...writeRoutes({ openPr }),
    ]);
    const client = new ContentsClient({ token: "t", fetch });
    const result = await convergeRepoFiles(client, OWNER, REPO, false, options);
    assert.equal(result.pullRequest.draft, expectDraft);
    assert.deepEqual(graphqlCalls(fetch), []);
  }
});

test("a GraphQL error on the draft conversion throws rather than reporting a hold that did not happen (issue #92)", async () => {
  const openPr = [
    { number: 7, node_id: "PR_7", html_url: "https://example/pr/7", draft: false, head: { ref: CONVERGE_BRANCH } },
  ];
  const fetch = fakeFetch([
    ...readRoutes({ treeEntries: {}, blobs: {} }),
    ...writeRoutes({ openPr }).filter((r) => r.match !== "/graphql"),
    { match: "/graphql", method: "POST", body: { errors: [{ message: "Resource not accessible by integration" }] } },
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  await assert.rejects(
    () => convergeRepoFiles(client, OWNER, REPO, false, SWEEPER_OPTIONS),
    /Failed to convert TheVoskamps\/example#7 to a draft: Resource not accessible by integration/,
  );
});

test("readFileIfPresent: 404 → undefined, a directory listing → undefined, a file → decoded content", async () => {
  const fetch = fakeFetch([
    { match: "/contents/missing", status: 404, statusText: "Not Found", body: {} },
    { match: "/contents/dir", body: [{ type: "file", name: "x" }] },
    { match: "/contents/plain", body: { type: "file", content: "raw text", encoding: "utf-8" } },
    { match: "/contents/LICENSE", body: { type: "file", ...blobBody("decoded\n") } },
  ]);
  const client = new ContentsClient({ token: "t", fetch });
  assert.equal(await client.readFileIfPresent(OWNER, ".github", "missing"), undefined);
  assert.equal(await client.readFileIfPresent(OWNER, ".github", "dir"), undefined);
  assert.equal(await client.readFileIfPresent(OWNER, ".github", "plain"), "raw text");
  assert.equal(await client.readFileIfPresent(OWNER, ".github", "LICENSE"), "decoded\n");
});
