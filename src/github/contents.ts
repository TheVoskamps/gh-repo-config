/**
 * A thin GitHub REST client for the converger's file-write path (issue
 * #14): read a target repo's default branch and current file state, and
 * commit changed files onto a work branch via the **git-data API**
 * (blobs → tree → commit → ref), then open (or update) a single PR.
 *
 * Zero runtime dependencies, mirroring {@link OrgPropertiesClient} in
 * `./properties.js` and {@link MergeClient} in `./merge.js`: built-in
 * `fetch` (Node >=22), bearer-token auth, injectable `fetch`/`apiBase`
 * for tests.
 *
 * Why the git-data API rather than the contents API: the contents API
 * (`PUT /repos/{o}/{r}/contents/{path}`) cannot set a blob's file mode,
 * so scripts committed through it land `100644` — not executable. The
 * gate/guard `.sh` scripts must ship `100755`. The git-data flow lets
 * the tree entry carry an explicit mode, so scripts land executable.
 *
 * REST surface used:
 * - Repo metadata (default branch): `GET /repos/{o}/{r}`.
 * - Branch head SHA: `GET /repos/{o}/{r}/git/ref/heads/{branch}`.
 * - Recursive tree read (existing path → blob sha + mode):
 *   `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1`.
 * - Blob content read (compare existing vs desired):
 *   `GET /repos/{o}/{r}/git/blobs/{sha}`.
 * - Create blob / tree / commit:
 *   `POST /repos/{o}/{r}/git/blobs|trees|commits`.
 * - Create / update the work-branch ref:
 *   `POST /repos/{o}/{r}/git/refs`, `PATCH /repos/{o}/{r}/git/refs/{ref}`.
 * - List / create PRs: `GET|POST /repos/{o}/{r}/pulls`.
 * - Single-file read by path, absent-tolerant (the community-file seed
 *   source in the org's `.github` repo, issue #90):
 *   `GET /repos/{o}/{r}/contents/{path}`.
 *
 * Two operations have no REST surface at all and are the module's only
 * GraphQL calls: flipping an already-open PR's draft state either way
 * (issue #92). `PATCH /repos/{o}/{r}/pulls/{n}` cannot set `draft` — the
 * flag is writable at creation only — so ready-to-draft goes through the
 * `convertPullRequestToDraft` mutation and draft-to-ready through
 * `markPullRequestReadyForReview`. Both are still bare `fetch` against
 * the same host, so the zero-dependency shape is unchanged.
 */

/** The file modes the converger writes. */
export const FILE_MODE = {
  /** Non-executable regular file (rendered YAML). */
  regular: "100644",
  /** Executable regular file (verbatim scripts). */
  executable: "100755",
} as const;

/** One tree entry the git-data commit writes. */
export interface TreeFile {
  /** Repo-relative path (POSIX separators). */
  readonly path: string;
  /** Full file content. */
  readonly content: string;
  /** The git file mode to record on the tree entry. */
  readonly mode: string;
}

/** A target repo's current state of one path (from the recursive tree). */
export interface ExistingBlob {
  /** The blob SHA. */
  readonly sha: string;
  /** The tree-entry file mode (e.g. `100644` / `100755`). */
  readonly mode: string;
}

interface RawRepo {
  readonly default_branch: string;
}

interface RawRef {
  readonly object: { readonly sha: string };
}

interface RawTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

interface RawTree {
  readonly tree: readonly RawTreeEntry[];
  readonly truncated: boolean;
}

interface RawBlob {
  readonly content: string;
  readonly encoding: string;
}

interface RawCreated {
  readonly sha: string;
}

interface RawContentsFile {
  readonly type: string;
  readonly content?: string;
  readonly encoding?: string;
}

interface RawPull {
  readonly number: number;
  readonly node_id: string;
  readonly html_url: string;
  readonly draft?: boolean;
  readonly head: { readonly ref: string };
}

interface RawGraphQlResponse {
  readonly errors?: readonly { readonly message: string }[];
}

/** Config for {@link ContentsClient}. */
export interface ContentsClientOptions {
  /** A bearer token with `contents: write` + `pull_requests: write`. */
  readonly token: string;
  /** Override the API base (for tests). Defaults to public GitHub. */
  readonly apiBase?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** Result of opening or updating the converger's PR on a repo. */
export interface PullRequestResult {
  readonly number: number;
  readonly url: string;
  /** `true` when an existing open PR's branch was updated in place. */
  readonly updated: boolean;
  /**
   * `true` when the PR is a draft and so cannot merge (issue #92: the
   * sweeper repo's trust anchor under `sweeper-update-policy: manual`).
   */
  readonly draft: boolean;
}

/** An open PR on the converger's work branch, as the write path needs it. */
export interface OpenPullRequestRef {
  readonly number: number;
  readonly url: string;
  /**
   * The PR's GraphQL node ID. Carried because flipping an open PR's
   * draft state has no REST surface — see
   * {@link ContentsClient.convertPullRequestToDraft} and
   * {@link ContentsClient.markPullRequestReadyForReview}.
   */
  readonly nodeId: string;
  /** `true` when the PR is already a draft. */
  readonly draft: boolean;
}

/**
 * Reads a repo's file state and commits changed files via the git-data
 * API. All methods are individually testable with an injected `fetch`.
 */
export class ContentsClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;

  constructor(options: ContentsClientOptions) {
    this.token = options.token;
    this.apiBase = options.apiBase ?? "https://api.github.com";
    this.doFetch = options.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "x-github-api-version": "2022-11-28",
    };
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) {
      throw new Error(`${what}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /** Read the repo's default branch name. */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const res = await this.doFetch(`${this.apiBase}/repos/${owner}/${repo}`, {
      headers: this.headers(),
    });
    const body = await this.json<RawRepo>(
      res,
      `Failed to read repo ${owner}/${repo}`,
    );
    return body.default_branch;
  }

  /** Read a branch's head commit SHA. */
  async getBranchHeadSha(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers: this.headers() },
    );
    const body = await this.json<RawRef>(
      res,
      `Failed to read ref heads/${branch} for ${owner}/${repo}`,
    );
    return body.object.sha;
  }

  /**
   * Read a commit's full recursive tree as a `path → {sha, mode}` map,
   * for exactly the blob (`type === "blob"`) entries. Used to compare
   * the target's current file state (content via the blob SHA, mode via
   * the tree entry) against the desired files.
   *
   * A `truncated` tree (>100k entries or >7MB) throws rather than
   * silently comparing against a partial view — a converger must not
   * decide "no change" from an incomplete tree.
   */
  async readTree(
    owner: string,
    repo: string,
    commitSha: string,
  ): Promise<Map<string, ExistingBlob>> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
      { headers: this.headers() },
    );
    const body = await this.json<RawTree>(
      res,
      `Failed to read tree ${commitSha} for ${owner}/${repo}`,
    );
    if (body.truncated) {
      throw new Error(
        `Tree ${commitSha} for ${owner}/${repo} is truncated; cannot converge against a partial tree`,
      );
    }
    const map = new Map<string, ExistingBlob>();
    for (const entry of body.tree) {
      if (entry.type === "blob") {
        map.set(entry.path, { sha: entry.sha, mode: entry.mode });
      }
    }
    return map;
  }

  /**
   * Read one file's content by path from a repo's default branch, or
   * `undefined` when there is nothing there to read: the repo does not
   * exist (or is not visible to the token), the path is absent, or the
   * path is not a regular file. All three are one outcome for the
   * caller — "no such file" — which is what the community-file seed
   * lookup (issue #90) needs: an org without a `.github` repo and an org
   * whose `.github` repo lacks one file both mean "nothing to seed".
   * Any other non-2xx status still throws.
   *
   * Uses the contents API rather than the tree/blob reads the write
   * path uses because a single request answers "present, and here is
   * the content" or "absent" per file, with no ref/tree round-trips and
   * no distinct handling for an empty repo.
   */
  async readFileIfPresent(
    owner: string,
    repo: string,
    path: string,
  ): Promise<string | undefined> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/contents/${path}`,
      { headers: this.headers() },
    );
    if (res.status === 404) {
      return undefined;
    }
    const body = await this.json<RawContentsFile | RawContentsFile[]>(
      res,
      `Failed to read ${path} from ${owner}/${repo}`,
    );
    // A directory at that path returns an array; anything but a regular
    // file with inline content is "not a file to seed".
    if (Array.isArray(body) || body.type !== "file" || body.content === undefined) {
      return undefined;
    }
    if (body.encoding === "base64") {
      return Buffer.from(body.content, "base64").toString("utf8");
    }
    return body.content;
  }

  /** Read a blob's content as a UTF-8 string. */
  async readBlob(owner: string, repo: string, sha: string): Promise<string> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/git/blobs/${sha}`,
      { headers: this.headers() },
    );
    const body = await this.json<RawBlob>(
      res,
      `Failed to read blob ${sha} for ${owner}/${repo}`,
    );
    if (body.encoding === "base64") {
      return Buffer.from(body.content, "base64").toString("utf8");
    }
    return body.content;
  }

  /** Create a blob from UTF-8 content; returns its SHA. */
  async createBlob(
    owner: string,
    repo: string,
    content: string,
  ): Promise<string> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/git/blobs`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({
          content: Buffer.from(content, "utf8").toString("base64"),
          encoding: "base64",
        }),
      },
    );
    const body = await this.json<RawCreated>(
      res,
      `Failed to create blob for ${owner}/${repo}`,
    );
    return body.sha;
  }

  /**
   * Create a tree rooted at `baseTreeSha` with the given file entries
   * overlaid. Each entry's `mode` is recorded on its tree entry (this is
   * how scripts get `100755`, which the contents API cannot do).
   * Returns the new tree SHA.
   */
  async createTree(
    owner: string,
    repo: string,
    baseTreeSha: string,
    entries: readonly { path: string; mode: string; sha: string }[],
  ): Promise<string> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/git/trees`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: entries.map((e) => ({
            path: e.path,
            mode: e.mode,
            type: "blob",
            sha: e.sha,
          })),
        }),
      },
    );
    const body = await this.json<RawCreated>(
      res,
      `Failed to create tree for ${owner}/${repo}`,
    );
    return body.sha;
  }

  /** Create a commit with the given tree and parent; returns its SHA. */
  async createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parentSha: string,
  ): Promise<string> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/git/commits`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({
          message,
          tree: treeSha,
          parents: [parentSha],
        }),
      },
    );
    const body = await this.json<RawCreated>(
      res,
      `Failed to create commit for ${owner}/${repo}`,
    );
    return body.sha;
  }

  /**
   * Point the work branch at `commitSha`. Creates the ref when it does
   * not exist; otherwise force-updates it (the converger owns the
   * branch, and updating a stale prior-run branch is the intended
   * "reset onto the current default head" behavior). The `exists` flag
   * lets the caller skip a create-then-409 round-trip.
   */
  async setBranchRef(
    owner: string,
    repo: string,
    branch: string,
    commitSha: string,
    exists: boolean,
  ): Promise<void> {
    if (exists) {
      const res = await this.doFetch(
        `${this.apiBase}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        {
          method: "PATCH",
          headers: { ...this.headers(), "content-type": "application/json" },
          body: JSON.stringify({ sha: commitSha, force: true }),
        },
      );
      await this.json<unknown>(
        res,
        `Failed to update ref heads/${branch} for ${owner}/${repo}`,
      );
      return;
    }
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/git/refs`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
      },
    );
    await this.json<unknown>(
      res,
      `Failed to create ref heads/${branch} for ${owner}/${repo}`,
    );
  }

  /**
   * Find an open PR whose head ref is `branch`, or `undefined` when none
   * is open. Used to decide "update the existing converger PR's branch"
   * vs "open a new PR".
   */
  async findOpenPullRequest(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<OpenPullRequestRef | undefined> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branch}&per_page=100`,
      { headers: this.headers() },
    );
    const body = await this.json<RawPull[]>(
      res,
      `Failed to list PRs for ${owner}/${repo}`,
    );
    const match = body.find((p) => p.head.ref === branch);
    if (!match) {
      return undefined;
    }
    return {
      number: match.number,
      url: match.html_url,
      nodeId: match.node_id,
      draft: match.draft === true,
    };
  }

  /**
   * Open a PR from `branch` into `base`; returns the created PR.
   *
   * @param draft open it as a draft (issue #92). A draft PR cannot be
   *   merged by anything — not the sweep's own REST merge, not GitHub's
   *   native auto-merge, which refuses to be enabled on one — so this is
   *   what holds the sweeper repo's trust anchor for a human without
   *   depending on a ruleset or a workflow's cooperation.
   */
  async createPullRequest(
    owner: string,
    repo: string,
    branch: string,
    base: string,
    title: string,
    body: string,
    draft: boolean,
  ): Promise<{ number: number; url: string }> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/pulls`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ title, head: branch, base, body, draft }),
      },
    );
    const created = await this.json<RawPull>(
      res,
      `Failed to create PR for ${owner}/${repo}`,
    );
    return { number: created.number, url: created.html_url };
  }

  /**
   * Run one of the two draft-state mutations against a PR node ID.
   *
   * A GraphQL error arrives as HTTP 200 with an `errors` array, so both
   * the status and that array are checked; either throws, carrying
   * `what` as the message prefix.
   */
  private async pullRequestDraftMutation(
    mutation: string,
    nodeId: string,
    what: string,
  ): Promise<void> {
    const res = await this.doFetch(`${this.apiBase}/graphql`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
        variables: { id: nodeId },
      }),
    });
    const body = await this.json<RawGraphQlResponse>(res, what);
    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `${what}: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
  }

  /**
   * Convert an already-open, ready-for-review PR back to a draft (issue
   * #92), addressed by its GraphQL node ID.
   *
   * This is GraphQL because there is no REST equivalent: `draft` is
   * writable only on the create call, and
   * `PATCH /repos/{o}/{r}/pulls/{n}` silently carries no such field. The
   * mutation is what lets a PR opened before the anchor appeared in it —
   * or opened by an earlier converger version — still be held once an
   * anchor-touching commit lands on its branch.
   */
  async convertPullRequestToDraft(
    owner: string,
    repo: string,
    number: number,
    nodeId: string,
  ): Promise<void> {
    await this.pullRequestDraftMutation(
      "convertPullRequestToDraft",
      nodeId,
      `Failed to convert ${owner}/${repo}#${number} to a draft`,
    );
  }

  /**
   * Mark an already-open draft PR ready for review (issue #92), the
   * mirror of {@link ContentsClient.convertPullRequestToDraft} and
   * GraphQL-only for the same reason.
   *
   * It is what lets a hold placed under `sweeper-update-policy: manual`
   * be released when the org switches that policy to one that no longer
   * reserves the anchor path — `auto` or `off`; without it the drafted
   * PR stays a draft forever and can never merge.
   */
  async markPullRequestReadyForReview(
    owner: string,
    repo: string,
    number: number,
    nodeId: string,
  ): Promise<void> {
    await this.pullRequestDraftMutation(
      "markPullRequestReadyForReview",
      nodeId,
      `Failed to mark ${owner}/${repo}#${number} ready for review`,
    );
  }
}
