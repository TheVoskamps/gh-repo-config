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

interface RawPull {
  readonly number: number;
  readonly html_url: string;
  readonly head: { readonly ref: string };
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
  ): Promise<{ number: number; url: string } | undefined> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branch}&per_page=100`,
      { headers: this.headers() },
    );
    const body = await this.json<RawPull[]>(
      res,
      `Failed to list PRs for ${owner}/${repo}`,
    );
    const match = body.find((p) => p.head.ref === branch);
    return match ? { number: match.number, url: match.html_url } : undefined;
  }

  /** Open a PR from `branch` into `base`; returns the created PR. */
  async createPullRequest(
    owner: string,
    repo: string,
    branch: string,
    base: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }> {
    const res = await this.doFetch(
      `${this.apiBase}/repos/${owner}/${repo}/pulls`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ title, head: branch, base, body }),
      },
    );
    const created = await this.json<RawPull>(
      res,
      `Failed to create PR for ${owner}/${repo}`,
    );
    return { number: created.number, url: created.html_url };
  }
}
