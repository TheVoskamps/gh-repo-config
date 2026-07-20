/**
 * A thin GitHub REST client for the `protect-main` repository ruleset
 * (issue #16) plus the org-installation lookup the ruleset's App bypass
 * actors need.
 *
 * Zero runtime dependencies, mirroring the other `src/github/` clients:
 * built-in `fetch` (Node >=22), bearer-token auth, injectable
 * `fetch`/`apiBase` for tests.
 *
 * REST surface used:
 * - `GET  /repos/{o}/{r}/rulesets` — list repo rulesets (paginated;
 *   `?includes_parents=true` so org-inherited rulesets show up).
 * - `GET  /repos/{o}/{r}/rulesets/{id}` — read one ruleset's full body.
 * - `POST /repos/{o}/{r}/rulesets` — create a ruleset.
 * - `PUT  /repos/{o}/{r}/rulesets/{id}` — replace a ruleset's body.
 * - `DELETE /repos/{o}/{r}/rulesets/{id}` — delete a ruleset.
 * - `GET  /orgs/{org}/installations` — resolve App slug → app_id for the
 *   bypass-actor entries (paginated).
 */

/** Config for {@link RulesetsClient}. */
export interface RulesetsClientOptions {
  /** A bearer token with `Administration: write` (the converger App). */
  readonly token: string;
  /** Override the API base (for tests). Defaults to public GitHub. */
  readonly apiBase?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** A ruleset as it appears in the list response (summary shape). */
export interface RulesetSummary {
  readonly id: number;
  readonly name: string;
  /** `"Repository"` or `"Organization"`. */
  readonly source_type?: string;
  /** The active/evaluate/disabled enforcement level. */
  readonly enforcement?: string;
  /** `"branch"`, `"tag"`, or `"push"` — which ref-kind the ruleset targets. */
  readonly target?: string;
}

/** A ref-name condition (include / exclude glob-or-symbolic lists). */
export interface RefNameCondition {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** One bypass actor entry (admin role, or an App integration). */
export interface BypassActor {
  readonly actor_id: number | null;
  readonly actor_type: string;
  readonly bypass_mode: string;
}

/** One rule in a ruleset's `rules` array (opaque parameters). */
export interface RulesetRule {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}

/** The full ruleset body used for reads and writes. */
export interface RulesetBody {
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly conditions: { readonly ref_name: RefNameCondition };
  readonly bypass_actors: readonly BypassActor[];
  readonly rules: readonly RulesetRule[];
}

/** A read ruleset, carrying its server-assigned id and source. */
export interface ExistingRuleset extends RulesetBody {
  readonly id: number;
  readonly source_type?: string;
}

interface RawInstallation {
  readonly app_id: number;
  readonly app_slug: string;
}

/**
 * The outcome of writing (create/update) a ruleset, distinguishing a
 * `code_quality`-attributable 422 (which the caller retries without that
 * rule) from success and from a real failure.
 */
export type RulesetWriteResult =
  | { readonly kind: "ok"; readonly ruleset: ExistingRuleset }
  /** A 422 naming code_quality — caller retries with the rule dropped. */
  | { readonly kind: "code-quality-422" };

/** Reads and converges the `protect-main` ruleset for one repo at a time. */
export class RulesetsClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;

  constructor(options: RulesetsClientOptions) {
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
   * List a repo's rulesets, following pagination. `includes_parents=true`
   * so an org-inherited ruleset (`source_type: "Organization"`) is
   * returned too — that is how the caller detects an org ruleset that
   * governs the repo's default branch.
   */
  async listRulesets(owner: string, repo: string): Promise<RulesetSummary[]> {
    const perPage = 100;
    const out: RulesetSummary[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.apiBase}/repos/${owner}/${repo}/rulesets?includes_parents=true&per_page=${perPage}&page=${page}`;
      const res = await this.doFetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error(
          `Failed to list rulesets for ${owner}/${repo} (page ${page}): ${res.status} ${res.statusText}`,
        );
      }
      const batch = (await res.json()) as RulesetSummary[];
      out.push(...batch);
      if (batch.length < perPage) {
        break;
      }
    }
    return out;
  }

  /** Read one ruleset's full body (with rules and conditions). */
  async getRuleset(owner: string, repo: string, id: number): Promise<ExistingRuleset> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/rulesets/${id}`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `Failed to read ruleset ${id} for ${owner}/${repo}: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as ExistingRuleset;
  }

  /** `POST /repos/{o}/{r}/rulesets` — create a ruleset from the body. */
  async createRuleset(owner: string, repo: string, body: RulesetBody): Promise<RulesetWriteResult> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/rulesets`;
    const res = await this.doFetch(url, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.writeResult(res, owner, repo, "create");
  }

  /** `PUT /repos/{o}/{r}/rulesets/{id}` — replace a ruleset's body. */
  async updateRuleset(
    owner: string,
    repo: string,
    id: number,
    body: RulesetBody,
  ): Promise<RulesetWriteResult> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/rulesets/${id}`;
    const res = await this.doFetch(url, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.writeResult(res, owner, repo, "update");
  }

  /** `DELETE /repos/{o}/{r}/rulesets/{id}` — delete a ruleset. */
  async deleteRuleset(owner: string, repo: string, id: number): Promise<void> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/rulesets/${id}`;
    const res = await this.doFetch(url, { method: "DELETE", headers: this.headers() });
    // 204 (deleted) and 404 (already gone) are both success — the repo
    // ends up without that ruleset either way.
    if (res.status === 204 || res.status === 404) {
      return;
    }
    if (!res.ok) {
      throw new Error(
        `Failed to delete ruleset ${id} for ${owner}/${repo}: ${res.status} ${res.statusText}`,
      );
    }
  }

  /**
   * Map a create/update write response to a {@link RulesetWriteResult}.
   * A 422 whose body names the `code_quality` rule type (limited
   * availability) is reported as `code-quality-422` so the caller can
   * retry with that rule dropped rather than hard-failing. Any other
   * non-ok status throws.
   */
  private async writeResult(
    res: Response,
    owner: string,
    repo: string,
    verb: string,
  ): Promise<RulesetWriteResult> {
    if (res.ok) {
      return { kind: "ok", ruleset: (await res.json()) as ExistingRuleset };
    }
    if (res.status === 422) {
      const text = await res.text();
      if (isCodeQualityRejection(text)) {
        return { kind: "code-quality-422" };
      }
      throw new Error(
        `Failed to ${verb} ruleset for ${owner}/${repo}: 422 ${res.statusText} — ${text}`,
      );
    }
    throw new Error(
      `Failed to ${verb} ruleset for ${owner}/${repo}: ${res.status} ${res.statusText}`,
    );
  }

  /**
   * Resolve every installed App's slug → app_id for the org, via
   * `GET /orgs/{org}/installations` (paginated). Returns a map keyed by
   * app slug. A slug absent from the map is an App not installed in the
   * org — the caller omits its bypass entry and reports, never fails.
   */
  async readAppIdsBySlug(org: string): Promise<Map<string, number>> {
    const perPage = 100;
    const out = new Map<string, number>();
    for (let page = 1; ; page++) {
      const url = `${this.apiBase}/orgs/${org}/installations?per_page=${perPage}&page=${page}`;
      const res = await this.doFetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error(
          `Failed to list installations for ${org} (page ${page}): ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as {
        readonly installations?: readonly RawInstallation[];
      };
      const installations = body.installations ?? [];
      for (const inst of installations) {
        out.set(inst.app_slug, inst.app_id);
      }
      if (installations.length < perPage) {
        break;
      }
    }
    return out;
  }
}

/**
 * Whether a 422 response body is attributable to the `code_quality`
 * rule type being unavailable — a purely syntactic match on the message
 * naming `code_quality` / "Code quality" / an unsupported-rule-type
 * phrasing, mirroring the skill's graceful-skip trigger.
 */
function isCodeQualityRejection(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("code_quality") || lower.includes("code quality");
}
