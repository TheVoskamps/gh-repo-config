/**
 * A thin GitHub REST client for merging the converger's own green PRs
 * (issue #24) — the control plane's missing half. The sweep opens
 * convergence PRs on managed repos; this client lists them, resolves
 * whether they're mergeable against the base branch's required checks,
 * and merges the ones that are.
 *
 * Zero runtime dependencies, mirroring {@link OrgPropertiesClient} in
 * `./properties.js`: built-in `fetch` (Node >=22), bearer-token auth,
 * injectable `fetch`/`apiBase` for tests.
 *
 * REST surface used:
 * - List PRs: `GET /repos/{owner}/{repo}/pulls?state=open`.
 * - Required checks on the base branch: `GET
 *   /repos/{owner}/{repo}/rules/branches/{branch}` (ruleset-derived
 *   rules, matching the `protect-main` ruleset model — not the legacy
 *   branch-protection API).
 * - PR head check rollup: `GET
 *   /repos/{owner}/{repo}/commits/{ref}/check-runs` (GitHub Checks) plus
 *   `GET /repos/{owner}/{repo}/commits/{ref}/status` (legacy combined
 *   status, for any check that only posts a commit status).
 * - Merge: `PUT /repos/{owner}/{repo}/pulls/{number}/merge`, merge
 *   method `merge` (merge-commit only, per the org's merge-commit-only
 *   standard — never squash, never rebase).
 */

/** A single open PR, projected to the fields the merge pass needs. */
export interface OpenPullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly authorLogin: string;
  readonly authorType: string;
}

interface RawUser {
  readonly login: string;
  readonly type: string;
}

interface RawPullRequest {
  readonly number: number;
  readonly user: RawUser | null;
  readonly head: { readonly sha: string; readonly ref: string };
  readonly base: { readonly ref: string };
}

interface RawRequiredStatusCheckRule {
  readonly type: string;
  readonly parameters?: {
    readonly required_status_checks?: readonly { readonly context: string }[];
  };
}

interface RawCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

interface RawCombinedStatus {
  readonly statuses: readonly { readonly context: string; readonly state: string }[];
}

/** The three-way rollup of a single required check's state. */
export type CheckState = "green" | "red" | "pending";

/** Per-check outcome, for reporting which check(s) blocked a merge. */
export interface RequiredCheckResult {
  readonly context: string;
  readonly state: CheckState;
}

/** Config for {@link MergeClient}. */
export interface MergeClientOptions {
  /** A bearer token with `pull_requests: write` (the converger App). */
  readonly token: string;
  /** Override the API base (for tests). Defaults to public GitHub. */
  readonly apiBase?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** Outcomes a merge attempt can settle into. */
export type MergeOutcome =
  /** All required checks green, mergeable, and (unless dryRun) merged. */
  | "merged"
  /** A required check is red, or GitHub reports the PR not mergeable. */
  | "blocked"
  /** All required checks are green/empty but at least one is still pending. */
  | "pending"
  /**
   * Checks were green and mergeable at read time, but the merge call
   * itself got a 405/409 (head moved, or no-longer-mergeable) between
   * the read and the merge attempt. Retry next tick, not a failure.
   */
  | "awaiting-retry";

/** Full result of evaluating (and possibly merging) one PR. */
export interface MergeAttemptResult {
  readonly pr: OpenPullRequest;
  readonly outcome: MergeOutcome;
  readonly checks: readonly RequiredCheckResult[];
  readonly reason: string;
}

/** Conclusion mapping from a GitHub check-run conclusion to a {@link CheckState}. */
function checkRunState(run: RawCheckRun): CheckState {
  if (run.status !== "completed") {
    return "pending";
  }
  switch (run.conclusion) {
    case "success":
    case "skipped":
    case "neutral":
      return "green";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
      return "red";
    default:
      // Any other/unknown completed conclusion (e.g. `stale`) is treated
      // as pending rather than silently green or red.
      return "pending";
  }
}

/** Conclusion mapping from a legacy combined-status state to a {@link CheckState}. */
function combinedStatusState(state: string): CheckState {
  switch (state) {
    case "success":
      return "green";
    case "failure":
    case "error":
      return "red";
    default:
      return "pending";
  }
}

/** Roll up a list of per-check states into one overall {@link CheckState}. */
function rollUp(states: readonly CheckState[]): CheckState {
  if (states.some((s) => s === "red")) {
    return "red";
  }
  if (states.some((s) => s === "pending")) {
    return "pending";
  }
  return "green";
}

/**
 * Lists, evaluates, and merges the converger App's own green open PRs.
 */
export class MergeClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;

  constructor(options: MergeClientOptions) {
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
   * List open PRs in `owner/repo` authored by the converger App. Matches
   * `user.login === "<appSlug>[bot]"` **and** `user.type === "Bot"` —
   * both conditions, so a human or another bot that happens to share a
   * similarly-named login is never treated as the converger.
   */
  async listOwnOpenPullRequests(
    owner: string,
    repo: string,
    appSlug: string,
  ): Promise<OpenPullRequest[]> {
    const expectedLogin = `${appSlug}[bot]`;
    const perPage = 100;
    const results: OpenPullRequest[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.apiBase}/repos/${owner}/${repo}/pulls?state=open&per_page=${perPage}&page=${page}`;
      const res = await this.doFetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error(
          `Failed to list open PRs for ${owner}/${repo} (page ${page}): ${res.status} ${res.statusText}`,
        );
      }
      const batch = (await res.json()) as RawPullRequest[];
      for (const pr of batch) {
        if (pr.user?.login === expectedLogin && pr.user?.type === "Bot") {
          results.push({
            number: pr.number,
            headSha: pr.head.sha,
            headRef: pr.head.ref,
            baseRef: pr.base.ref,
            authorLogin: pr.user.login,
            authorType: pr.user.type,
          });
        }
      }
      if (batch.length < perPage) {
        break;
      }
    }
    return results;
  }

  /**
   * Resolve the base branch's required-check contexts via the rules API
   * (`GET /repos/{owner}/{repo}/rules/branches/{branch}`) — the
   * ruleset-derived rules, matching the `protect-main` ruleset model.
   * Returns an empty array when no `required_status_checks` rule
   * applies (e.g. an unprotected fixture branch).
   */
  async getRequiredCheckContexts(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string[]> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/rules/branches/${branch}`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `Failed to read branch rules for ${owner}/${repo}@${branch}: ${res.status} ${res.statusText}`,
      );
    }
    const rules = (await res.json()) as RawRequiredStatusCheckRule[];
    const contexts: string[] = [];
    for (const rule of rules) {
      if (rule.type !== "required_status_checks") {
        continue;
      }
      for (const check of rule.parameters?.required_status_checks ?? []) {
        contexts.push(check.context);
      }
    }
    return contexts;
  }

  /**
   * Resolve one PR's required-check rollup: for each required context,
   * find its state among the head commit's check-runs (GitHub Checks)
   * and legacy combined statuses, then roll every context up into one
   * overall {@link CheckState}. An empty `requiredContexts` list rolls
   * up to `"green"` unconditionally (there is nothing to gate on).
   * Actual mergeability is not precomputed here — it is enforced by
   * the merge call itself, whose 405/409 rejection is recorded as
   * `awaiting-retry`.
   */
  async evaluateRequiredChecks(
    owner: string,
    repo: string,
    headSha: string,
    requiredContexts: readonly string[],
  ): Promise<RequiredCheckResult[]> {
    if (requiredContexts.length === 0) {
      return [];
    }

    const [checkRuns, combinedStatus] = await Promise.all([
      this.getCheckRuns(owner, repo, headSha),
      this.getCombinedStatus(owner, repo, headSha),
    ]);

    const checkRunByName = new Map(checkRuns.map((r) => [r.name, r]));
    const statusByContext = new Map(
      combinedStatus.statuses.map((s) => [s.context, s.state]),
    );

    return requiredContexts.map((context) => {
      const run = checkRunByName.get(context);
      if (run) {
        return { context, state: checkRunState(run) };
      }
      const status = statusByContext.get(context);
      if (status !== undefined) {
        return { context, state: combinedStatusState(status) };
      }
      // Required but not reported at all yet — pending, not red: it may
      // not have started.
      return { context, state: "pending" as const };
    });
  }

  private async getCheckRuns(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<RawCheckRun[]> {
    // `filter=latest` is GitHub's implicit default (only the most
    // recent check-run per name/app), but making it explicit avoids
    // relying on that default holding across API changes.
    const url = `${this.apiBase}/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100&filter=latest`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `Failed to read check-runs for ${owner}/${repo}@${ref}: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { check_runs: RawCheckRun[] };
    return body.check_runs;
  }

  private async getCombinedStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<RawCombinedStatus> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/commits/${ref}/status`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(
        `Failed to read combined status for ${owner}/${repo}@${ref}: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as RawCombinedStatus;
  }

  /**
   * REST-merge one PR with the `merge` method (merge-commit only, per
   * the org's merge-commit-only standard). Returns `true` on success.
   * Returns `false` (rather than throwing) on a 405 or 409 — "head
   * moved" / "not mergeable" between the read and this call — so the
   * caller can record it as awaiting-retry instead of a hard failure.
   * Any other non-ok status throws.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<boolean> {
    const url = `${this.apiBase}/repos/${owner}/${repo}/pulls/${number}/merge`;
    const res = await this.doFetch(url, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ merge_method: "merge" }),
    });
    if (res.status === 405 || res.status === 409) {
      return false;
    }
    if (!res.ok) {
      throw new Error(
        `Failed to merge ${owner}/${repo}#${number}: ${res.status} ${res.statusText}`,
      );
    }
    return true;
  }

  /**
   * Evaluate and (unless `dryRun`) merge one PR: resolve its base
   * branch's required checks, roll up the PR head's check state against
   * them, and merge when green. Mirrors the `dryRun` symmetry with
   * {@link OrgPropertiesClient.stampVersion} — decide and report, never
   * issue the merge, when `dryRun` is set.
   */
  async evaluateAndMerge(
    owner: string,
    repo: string,
    pr: OpenPullRequest,
    dryRun: boolean,
  ): Promise<MergeAttemptResult> {
    const requiredContexts = await this.getRequiredCheckContexts(
      owner,
      repo,
      pr.baseRef,
    );
    const checks = await this.evaluateRequiredChecks(
      owner,
      repo,
      pr.headSha,
      requiredContexts,
    );
    const overall = rollUp(checks.map((c) => c.state));

    if (overall === "red") {
      return {
        pr,
        outcome: "blocked",
        checks,
        reason: `required check(s) red: ${checks
          .filter((c) => c.state === "red")
          .map((c) => c.context)
          .join(", ")}`,
      };
    }
    if (overall === "pending") {
      return {
        pr,
        outcome: "pending",
        checks,
        reason: `required check(s) pending: ${checks
          .filter((c) => c.state === "pending")
          .map((c) => c.context)
          .join(", ")}`,
      };
    }

    if (dryRun) {
      return {
        pr,
        outcome: "merged",
        checks,
        reason: "[dry-run] all required checks green, would merge",
      };
    }

    const merged = await this.mergePullRequest(owner, repo, pr.number);
    if (!merged) {
      return {
        pr,
        outcome: "awaiting-retry",
        checks,
        reason:
          "all required checks green, but merge was rejected (head moved or not mergeable) — retrying next tick",
      };
    }
    return { pr, outcome: "merged", checks, reason: "all required checks green, merged" };
  }
}
