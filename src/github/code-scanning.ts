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

/** Reads and converges one repo's CodeQL default-setup state. */
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
}
