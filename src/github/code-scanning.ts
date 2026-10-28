/**
 * A thin GitHub REST client for the CodeQL **default-setup** state
 * (issue #16). The converger ships an *advanced* CodeQL workflow
 * (`.github/workflows/codeql.yml`), and default setup + an advanced
 * workflow are mutually exclusive — a live default setup suppresses the
 * advanced workflow's results. So the converger drives default setup to
 * `not-configured` on every managed repo.
 *
 * Zero runtime dependencies, mirroring {@link OrgPropertiesClient} in
 * `./properties.js` / {@link MergeClient} in `./merge.js` /
 * {@link RepoSettingsClient} in `./settings.js`: built-in `fetch`
 * (Node >=22), bearer-token auth, injectable `fetch`/`apiBase` for tests.
 *
 * REST surface used:
 * - `GET  /repos/{o}/{r}/code-scanning/default-setup` — read the current
 *   default-setup state (`{ state, languages, ... }`).
 * - `PATCH /repos/{o}/{r}/code-scanning/default-setup` — set the state
 *   (`{ state: "not-configured" }`).
 * - `GET  /repos/{o}/{r}/code-scanning/analyses` — list one ref's CodeQL
 *   analyses, newest first, to find stale configurations (issue #158).
 * - `DELETE /repos/{o}/{r}/code-scanning/analyses/{id}` — delete one
 *   analysis, with `confirm_delete` when it is its configuration's last.
 * - `GET  /repos/{o}/{r}` and `GET /repos/{o}/{r}/contents/{path}` — read
 *   the default branch's name and the CodeQL workflow on it, which gates
 *   the stale-configuration deletion (issue #158).
 */

/** Config for {@link CodeScanningClient}. */
export interface CodeScanningClientOptions {
  /** A bearer token with code-scanning write (the converger App). */
  readonly token: string;
  /** Override the API base (for tests). Defaults to public GitHub. */
  readonly apiBase?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * The CodeQL default-setup state GitHub reports. `configured` means a
 * server-side default scan is active (the state the converger drives
 * *off*); `not-configured` is the target. Any other/unknown string is
 * surfaced verbatim so a future state does not silently read as one of
 * these two.
 */
export type DefaultSetupState = "configured" | "not-configured" | string;

/** A read of the current default-setup state. */
export interface DefaultSetupStatus {
  readonly state: DefaultSetupState;
  /** Languages the default scan covers, when reported (empty otherwise). */
  readonly languages: readonly string[];
}

interface RawDefaultSetup {
  readonly state?: string;
  readonly languages?: readonly string[] | null;
}

/**
 * The read outcome, distinguishing an unavailable feature/plan (a 403 or
 * 404, which callers treat as report-and-skip) from a real read.
 */
export type DefaultSetupReadResult =
  | { readonly kind: "read"; readonly status: DefaultSetupStatus }
  /**
   * The endpoint returned a 403/404 — code scanning is not available on
   * this repo/plan. Not an error; the caller reports-and-skips the whole
   * default-setup convergence for this repo.
   */
  | { readonly kind: "unavailable"; readonly status: number };

/** One CodeQL analysis, as the analyses list reports it. */
export interface CodeScanningAnalysis {
  readonly id: number;
  /** The analysis category; empty when GitHub reports none. */
  readonly category: string;
}

interface RawAnalysis {
  readonly id: number;
  readonly category?: string | null;
}

/** A list of analyses, or a 403/404 (code scanning unavailable). */
export type AnalysesListResult =
  | { readonly kind: "listed"; readonly analyses: readonly CodeScanningAnalysis[] }
  | { readonly kind: "unavailable"; readonly status: number };

/**
 * One analysis deletion. `next` is the URL that deletes the next analysis
 * of the same configuration — the response's `next_analysis_url`, else its
 * `confirm_delete_url` when the next deletion removes the configuration's
 * last analysis — and is absent once the configuration is gone.
 */
export type AnalysisDeleteResult =
  | { readonly kind: "deleted"; readonly next?: string }
  | { readonly kind: "unavailable"; readonly status: number };

interface RawAnalysisDelete {
  readonly next_analysis_url?: string | null;
  readonly confirm_delete_url?: string | null;
}

/**
 * One file read from a repo's default branch: the branch's name, and the
 * file's content, absent when the path holds no regular file there.
 */
export interface DefaultBranchFile {
  readonly branch: string;
  readonly content?: string;
}

interface RawRepo {
  readonly default_branch: string;
}

interface RawContentsFile {
  readonly type: string;
  readonly content?: string;
  readonly encoding?: string;
}

/** The analyses list's largest page size. */
const ANALYSES_PAGE_SIZE = 100;

/**
 * Reads and converges one repo's CodeQL default-setup state, and lists
 * and deletes its CodeQL analyses.
 */
export class CodeScanningClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;

  constructor(options: CodeScanningClientOptions) {
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

  /**
   * Read the current default-setup state. A 403/404 (feature/plan
   * unavailable) is reported as `unavailable` rather than thrown — the
   * caller report-and-skips this repo's default-setup convergence. Any
   * other non-ok status is a real failure and throws (auth/scope errors
   * must not be silently swallowed).
   */
  async readDefaultSetup(owner: string, repo: string): Promise<DefaultSetupReadResult> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/code-scanning/default-setup`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (res.status === 403 || res.status === 404) {
      return { kind: "unavailable", status: res.status };
    }
    if (!res.ok) {
      throw new Error(
        `Failed to read code-scanning default-setup for ${owner}/${repo}: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as RawDefaultSetup;
    return {
      kind: "read",
      status: {
        state: body.state ?? "not-configured",
        languages: body.languages ?? [],
      },
    };
  }

  /**
   * `PATCH .../code-scanning/default-setup` with `state: not-configured`.
   * Returns the raw response so the caller can treat a 403/404
   * (entitlement / availability) as report-and-skip rather than a thrown
   * error, and distinguish it from a real (auth/scope) failure.
   */
  async setDefaultSetupNotConfigured(owner: string, repo: string): Promise<Response> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/code-scanning/default-setup`;
    return this.doFetch(url, {
      method: "PATCH",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ state: "not-configured" }),
    });
  }

  /**
   * Read the repo's default branch and the file at `path` on it. A 404 on
   * the file, or a path that is not a regular file, leaves `content`
   * absent; any other non-ok status throws.
   */
  async readDefaultBranchFile(
    owner: string,
    repo: string,
    path: string,
  ): Promise<DefaultBranchFile> {
    const repoRes = await this.doFetch(`${this.apiBase}/repos/${owner}/${repo}`, {
      headers: this.headers(),
    });
    if (!repoRes.ok) {
      throw new Error(
        `Failed to read repo ${owner}/${repo}: ${repoRes.status} ${repoRes.statusText}`,
      );
    }
    const branch = ((await repoRes.json()) as RawRepo).default_branch;

    const url =
      `${this.apiBase}/repos/${owner}/${repo}/contents/${path}` +
      `?ref=${encodeURIComponent(branch)}`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (res.status === 404) {
      return { branch };
    }
    if (!res.ok) {
      throw new Error(
        `Failed to read ${path} from ${owner}/${repo}@${branch}: ${res.status} ${res.statusText}`,
      );
    }
    // A directory at that path returns an array.
    const body = (await res.json()) as RawContentsFile | readonly RawContentsFile[];
    if (Array.isArray(body)) {
      return { branch };
    }
    const file = body as RawContentsFile;
    if (file.type !== "file" || file.content === undefined) {
      return { branch };
    }
    const content =
      file.encoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
    return { branch, content };
  }

  /**
   * List every CodeQL analysis on `branch`, newest first, reading every
   * page. A 403/404 is `unavailable`; any other non-ok status throws.
   */
  async listCodeqlAnalyses(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<AnalysesListResult> {
    const ref = encodeURIComponent(`refs/heads/${branch}`);
    const analyses: CodeScanningAnalysis[] = [];
    for (let page = 1; ; page++) {
      const url =
        `${this.apiBase}/repos/${owner}/${repo}/code-scanning/analyses` +
        `?tool_name=CodeQL&ref=${ref}&per_page=${ANALYSES_PAGE_SIZE}&page=${page}`;
      const res = await this.doFetch(url, { headers: this.headers() });
      if (res.status === 403 || res.status === 404) {
        return { kind: "unavailable", status: res.status };
      }
      if (!res.ok) {
        throw new Error(
          `Failed to list code-scanning analyses for ${owner}/${repo}: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as readonly RawAnalysis[];
      for (const raw of body) {
        analyses.push({ id: raw.id, category: raw.category ?? "" });
      }
      if (body.length < ANALYSES_PAGE_SIZE) {
        return { kind: "listed", analyses };
      }
    }
  }

  /**
   * Delete one analysis. `confirmDelete` is required when it is the last
   * analysis of its configuration, and deletes the configuration with it.
   */
  async deleteAnalysis(
    owner: string,
    repo: string,
    analysisId: number,
    confirmDelete: boolean,
  ): Promise<AnalysisDeleteResult> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/code-scanning/analyses/${analysisId}`;
    return this.deleteAnalysisAt(confirmDelete ? `${url}?confirm_delete` : url);
  }

  /**
   * Delete the analysis a previous deletion's `next` URL names. A 403/404
   * is `unavailable`; any other non-ok status throws.
   */
  async deleteAnalysisAt(url: string): Promise<AnalysisDeleteResult> {
    const res = await this.doFetch(url, { method: "DELETE", headers: this.headers() });
    if (res.status === 403 || res.status === 404) {
      return { kind: "unavailable", status: res.status };
    }
    if (!res.ok) {
      throw new Error(
        `Failed to delete code-scanning analysis ${url}: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as RawAnalysisDelete;
    const next = body.next_analysis_url ?? body.confirm_delete_url ?? undefined;
    return next === undefined ? { kind: "deleted" } : { kind: "deleted", next };
  }
}
