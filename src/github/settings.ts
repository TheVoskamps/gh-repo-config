/**
 * A thin GitHub REST client for the per-repo GHAS / repo-security and
 * merge-button settings the sweep converges (issue #15) — pure API
 * mutations, no files, no PR.
 *
 * Zero runtime dependencies, mirroring {@link OrgPropertiesClient} in
 * `./properties.js` / {@link MergeClient} in `./merge.js` / the
 * `ContentsClient` in `./contents.js`: built-in `fetch` (Node >=22),
 * bearer-token auth, injectable `fetch`/`apiBase` for tests.
 *
 * REST surface used:
 * - Dependabot alerts: `GET`/`PUT /repos/{o}/{r}/vulnerability-alerts`
 *   (`GET` returns 204 enabled / 404 disabled — no JSON body either way).
 * - Dependabot security updates:
 *   `GET`/`PUT /repos/{o}/{r}/automated-security-fixes` (`GET` returns
 *   `{ enabled, paused }`).
 * - Repo settings (secret scanning + push protection, delegated bypass,
 *   merge-button / PR-hygiene): `GET`/`PATCH /repos/{o}/{r}`.
 *
 * Every write is read-then-PATCH: read the current value first and
 * write only the sub-keys that differ, so an already-converged repo
 * produces zero mutations (a repeat sweep is a no-op).
 */

/** Config for {@link RepoSettingsClient}. */
export interface RepoSettingsClientOptions {
  /** A bearer token with `Administration: write` (the converger App). */
  readonly token: string;
  /** Override the API base (for tests). Defaults to public GitHub. */
  readonly apiBase?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** A `security_and_analysis` sub-setting's status, as GitHub reports it. */
export type SecurityAnalysisStatus = "enabled" | "disabled";

/** The current state of the settings this client reads/converges. */
export interface RepoSecuritySettings {
  readonly vulnerabilityAlertsEnabled: boolean;
  readonly automatedSecurityFixesEnabled: boolean;
  readonly secretScanning: SecurityAnalysisStatus | undefined;
  readonly secretScanningPushProtection: SecurityAnalysisStatus | undefined;
  readonly allowMergeCommit: boolean;
  readonly allowSquashMerge: boolean;
  readonly allowRebaseMerge: boolean;
  readonly allowAutoMerge: boolean;
  readonly deleteBranchOnMerge: boolean;
}

interface RawSecurityAndAnalysisEntry {
  readonly status: string;
}

interface RawRepo {
  readonly security_and_analysis?: {
    readonly secret_scanning?: RawSecurityAndAnalysisEntry;
    readonly secret_scanning_push_protection?: RawSecurityAndAnalysisEntry;
  };
  readonly allow_merge_commit?: boolean;
  readonly allow_squash_merge?: boolean;
  readonly allow_rebase_merge?: boolean;
  readonly allow_auto_merge?: boolean;
  readonly delete_branch_on_merge?: boolean;
}

interface RawAutomatedSecurityFixes {
  readonly enabled: boolean;
  readonly paused: boolean;
}

/**
 * Reserved for a future typed-error write path. Every
 * {@link RepoSettingsClient} write method today (`enableVulnerabilityAlerts`,
 * `enableAutomatedSecurityFixes`, `patchSecurityAndAnalysis`,
 * `enableSecretScanningDelegatedBypass`, `patchMergeButtonSettings`)
 * returns the raw `Response` instead of throwing, so callers (see
 * `src/converge/ghas.ts`'s `outcomeFromResponse`) can treat a 422
 * (entitlement) as report-and-skip without a try/catch. This class is
 * not currently thrown anywhere in this module.
 */
export class SettingsWriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SettingsWriteError";
    this.status = status;
  }
}

/**
 * Reads and converges the GHAS / repo-security toggles and merge-button
 * settings for one repo at a time.
 */
export class RepoSettingsClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;

  constructor(options: RepoSettingsClientOptions) {
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
   * Read the full current-state snapshot this converger cares about:
   * Dependabot alerts, Dependabot security updates, secret scanning +
   * push protection status, and the merge-button settings. One extra
   * round-trip (`GET /repos/{o}/{r}`) is shared by both the security
   * sub-keys and the merge-button settings since they live on the same
   * repo object.
   */
  async readSettings(owner: string, repo: string): Promise<RepoSecuritySettings> {
    const [vulnerabilityAlertsEnabled, automatedSecurityFixesEnabled, rawRepo] =
      await Promise.all([
        this.readVulnerabilityAlertsEnabled(owner, repo),
        this.readAutomatedSecurityFixesEnabled(owner, repo),
        this.readRepo(owner, repo),
      ]);

    const secAnalysis = rawRepo.security_and_analysis;
    return {
      vulnerabilityAlertsEnabled,
      automatedSecurityFixesEnabled,
      secretScanning: asStatus(secAnalysis?.secret_scanning?.status),
      secretScanningPushProtection: asStatus(
        secAnalysis?.secret_scanning_push_protection?.status,
      ),
      allowMergeCommit: rawRepo.allow_merge_commit ?? false,
      allowSquashMerge: rawRepo.allow_squash_merge ?? false,
      allowRebaseMerge: rawRepo.allow_rebase_merge ?? false,
      allowAutoMerge: rawRepo.allow_auto_merge ?? false,
      deleteBranchOnMerge: rawRepo.delete_branch_on_merge ?? false,
    };
  }

  private async readRepo(owner: string, repo: string): Promise<RawRepo> {
    const url = `${this.apiBase}/repos/${owner}/${repo}`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Failed to read repo ${owner}/${repo}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as RawRepo;
  }

  /**
   * `GET /repos/{o}/{r}/vulnerability-alerts` reports enabled/disabled by
   * status code alone (204 enabled, 404 disabled), never a JSON body.
   */
  private async readVulnerabilityAlertsEnabled(owner: string, repo: string): Promise<boolean> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/vulnerability-alerts`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (res.status === 204) {
      return true;
    }
    if (res.status === 404) {
      return false;
    }
    throw new Error(
      `Failed to read vulnerability-alerts for ${owner}/${repo}: ${res.status} ${res.statusText}`,
    );
  }

  private async readAutomatedSecurityFixesEnabled(owner: string, repo: string): Promise<boolean> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/automated-security-fixes`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `Failed to read automated-security-fixes for ${owner}/${repo}: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as RawAutomatedSecurityFixes;
    return body.enabled;
  }

  /**
   * `PUT /repos/{o}/{r}/vulnerability-alerts` — enable Dependabot alerts.
   * Returns the raw response so the caller can treat a 422 (entitlement)
   * as report-and-skip rather than a thrown error.
   */
  async enableVulnerabilityAlerts(owner: string, repo: string): Promise<Response> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/vulnerability-alerts`;
    return this.doFetch(url, { method: "PUT", headers: this.headers() });
  }

  /**
   * `PUT /repos/{o}/{r}/automated-security-fixes` — enable Dependabot
   * security updates (enablement only; grouping lives in
   * `dependabot.yml`, owned by issue #14).
   */
  async enableAutomatedSecurityFixes(owner: string, repo: string): Promise<Response> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/automated-security-fixes`;
    return this.doFetch(url, { method: "PUT", headers: this.headers() });
  }

  /**
   * `PATCH /repos/{o}/{r}` with a `security_and_analysis` block carrying
   * only the sub-keys that differ (secret scanning and/or push
   * protection). Returns the raw response so the caller can treat a 422
   * (entitlement) as report-and-skip.
   */
  async patchSecurityAndAnalysis(
    owner: string,
    repo: string,
    patch: { secretScanning?: boolean; secretScanningPushProtection?: boolean },
  ): Promise<Response> {
    const securityAndAnalysis: Record<string, { status: string }> = {};
    if (patch.secretScanning !== undefined) {
      securityAndAnalysis.secret_scanning = {
        status: patch.secretScanning ? "enabled" : "disabled",
      };
    }
    if (patch.secretScanningPushProtection !== undefined) {
      securityAndAnalysis.secret_scanning_push_protection = {
        status: patch.secretScanningPushProtection ? "enabled" : "disabled",
      };
    }
    return this.patchRepo(owner, repo, {
      security_and_analysis: securityAndAnalysis,
    });
  }

  /**
   * Best-effort push-protection bypass lockdown: enable delegated bypass
   * so nobody may bypass push protection without review. Mirrors the
   * exact call the `gh-repo-setup-protection` skill makes today. There
   * is no clean, stable per-repo public REST toggle that sets the
   * bypass list to "nobody" directly, so this is a best-effort repo-level
   * enablement — never a hard failure regardless of outcome (a 404/422
   * means the endpoint/feature is unavailable; the residual manual step
   * is surfaced in the sweep report, not treated as an error).
   */
  async enableSecretScanningDelegatedBypass(owner: string, repo: string): Promise<Response> {
    return this.patchRepo(owner, repo, {
      security_and_analysis: {
        secret_scanning_delegated_bypass: { status: "enabled" },
      },
    });
  }

  /**
   * `PATCH /repos/{o}/{r}` with only the merge-button sub-keys that
   * differ from the current state (merge-commit-only, auto-merge,
   * delete-branch-on-merge). `allow_update_branch` is deliberately not
   * part of this converger's spec — see issue #15's decision to diverge
   * from `gh-repo-setup-protection`'s table on that one key.
   */
  async patchMergeButtonSettings(
    owner: string,
    repo: string,
    patch: {
      allowMergeCommit?: boolean;
      allowSquashMerge?: boolean;
      allowRebaseMerge?: boolean;
      allowAutoMerge?: boolean;
      deleteBranchOnMerge?: boolean;
    },
  ): Promise<Response> {
    const body: Record<string, boolean> = {};
    if (patch.allowMergeCommit !== undefined) {
      body.allow_merge_commit = patch.allowMergeCommit;
    }
    if (patch.allowSquashMerge !== undefined) {
      body.allow_squash_merge = patch.allowSquashMerge;
    }
    if (patch.allowRebaseMerge !== undefined) {
      body.allow_rebase_merge = patch.allowRebaseMerge;
    }
    if (patch.allowAutoMerge !== undefined) {
      body.allow_auto_merge = patch.allowAutoMerge;
    }
    if (patch.deleteBranchOnMerge !== undefined) {
      body.delete_branch_on_merge = patch.deleteBranchOnMerge;
    }
    return this.patchRepo(owner, repo, body);
  }

  private async patchRepo(
    owner: string,
    repo: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const url = `${this.apiBase}/repos/${owner}/${repo}`;
    return this.doFetch(url, {
      method: "PATCH",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

function asStatus(status: string | undefined): SecurityAnalysisStatus | undefined {
  if (status === "enabled" || status === "disabled") {
    return status;
  }
  return undefined;
}
