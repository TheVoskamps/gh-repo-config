/**
 * The selection-loop walking skeleton (issue #13, slice 2), plus the
 * merge pass that makes fan-out runs unattended end to end (issue #24).
 *
 * Reads the three selection/stamp org custom properties, applies the
 * precedence table + version-skip to every repo, "converges" each due
 * repo (a **stub** — log/no-op this slice), and re-stamps the converged
 * repos with the current release version. Convergence itself (rendering
 * files, GHAS toggles, rulesets) is later slices' scope (#14–#18).
 *
 * Independent of the version-skip decision, every managed *and*
 * unmanaged repo also gets a merge pass: list the converger App's own
 * open PRs on that repo and merge whichever are green. A repo can have
 * an unmerged converger PR sitting open regardless of whether it's due
 * for a new convergence this tick, so the merge pass runs over every
 * repo the properties API returns, not just the ones selected for
 * `converge`.
 */
import {
  normalizeOrgDefault,
  type OrgDefault,
} from "./config/selection.js";
import { decideRepo, type RepoAction } from "./stamp/decide.js";
import {
  OrgPropertiesClient,
  PartialStampError,
  type OrgPropertiesClientOptions,
  type RepoPropertyValues,
} from "./github/properties.js";
import {
  MergeClient,
  type MergeAttemptResult,
  type MergeClientOptions,
} from "./github/merge.js";
import { CURRENT_VERSION } from "./version.js";

/** One repo's outcome in a sweep run. */
export interface SweepRepoResult {
  readonly repo: string;
  readonly action: RepoAction;
  readonly reason: string;
}

/** The full result of a sweep run, for logging and CI assertions. */
export interface SweepReport {
  readonly org: string;
  readonly version: string;
  readonly orgDefault: OrgDefault;
  /** `true` when no stamping was performed (see {@link SweepOptions}). */
  readonly dryRun: boolean;
  readonly results: readonly SweepRepoResult[];
  /**
   * Repos whose converge step succeeded and that were selected for
   * stamping (in dry-run, "would have been stamped"; otherwise identical
   * to `stamped` unless a mid-batch stamp write failed partway — see
   * {@link stamped}).
   */
  readonly converged: readonly string[];
  /**
   * Repos actually confirmed stamped by the properties API. Equal to
   * `converged` on a fully successful (non-dry-run) sweep. When a batch
   * `stampVersion` write fails partway through, this reflects only the
   * repos from batches that completed before the failure — the
   * authoritative "what actually got written" list, distinct from
   * `converged` ("what the sweep intended to stamp"). Empty on a
   * `dryRun` sweep (nothing is ever written).
   */
  readonly stamped: readonly string[];
  /**
   * Repos that did not end the sweep successfully: either the converge
   * step threw, or convergence succeeded but the subsequent
   * `stampVersion` batch write for that repo failed. Not stamped, not
   * up to date — must be retried on the next sweep. A non-empty `failed`
   * means the sweep as a whole did not fully succeed; see
   * `runSweepFromEnv`'s exit-code contract in `bin/gh-repo-config.js`.
   */
  readonly failed: readonly string[];
  readonly skippedUnmanaged: number;
  readonly skippedCurrent: number;
  /**
   * Converger-authored PRs merged this tick (all required checks green,
   * mergeable, merge-commit issued — or, under `dryRun`, would have
   * been). Runs over every repo the properties API returned, independent
   * of that repo's version-skip decision.
   */
  readonly merged: readonly MergeAttemptResult[];
  /**
   * Converger-authored PRs left open this tick: a required check is red
   * (the escalation-to-human path), a required check is still pending
   * (not yet, retried next tick), or the merge call itself was rejected
   * with a 405/409 between the read and the merge attempt (head moved /
   * no-longer-mergeable — also retried next tick). None of these count
   * as a sweep failure.
   */
  readonly awaitingChecks: readonly MergeAttemptResult[];
}

/** How to run the sweep. */
export interface SweepOptions {
  /**
   * When `true`, decide and log but do not stamp — used by
   * `workflow_dispatch` runs that want to preview selection before
   * giving the sweep teeth. Defaults to `false`.
   */
  readonly dryRun?: boolean;
  /**
   * Injectable converge step. This slice's default is a no-op stub;
   * later slices replace it with the real (throwing-on-failure)
   * converger. Returning normally means "converged, safe to stamp";
   * throwing records that repo's outcome as `failed` in the report (not
   * stamped, not treated as up to date) and causes the sweep as a whole
   * to be reported as failed — see {@link SweepReport.failed}.
   */
  readonly converge?: (repo: string) => Promise<void> | void;
  /** Injectable logger (defaults to `console`). */
  readonly log?: (message: string) => void;
  /**
   * The merge client used for the merge pass (issue #24). When omitted,
   * the merge pass is skipped entirely (`merged`/`awaitingChecks` come
   * back empty) — used by callers/tests that only care about the
   * selection loop. `runSweepFromEnv` always supplies one.
   */
  readonly mergeClient?: MergeClient;
  /**
   * The converger App's slug (e.g. `my-converger-app`), used to match
   * `user.login === "<appSlug>[bot]"` when listing a repo's open PRs.
   * Required whenever `mergeClient` is supplied.
   */
  readonly appSlug?: string;
}

/**
 * Run one full sweep against an org.
 *
 * @param client the org custom-properties client (already authenticated).
 * @param version the converger version to compare stamps against and to
 *   stamp converged repos with. Defaults to {@link CURRENT_VERSION}.
 */
export async function runSweep(
  client: OrgPropertiesClient,
  org: string,
  version: string = CURRENT_VERSION,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const log = options.log ?? ((m: string) => console.log(m));
  const converge = options.converge ?? (() => {});
  const dryRun = options.dryRun ?? false;

  const orgDefault = normalizeOrgDefault(await client.readOrgDefault());
  const repos = await client.readAllRepoValues();

  log(
    `Sweep of ${org}: version=${version}, org default=${orgDefault}, ${repos.length} repo(s)`,
  );

  const results: SweepRepoResult[] = [];
  const toStamp: string[] = [];

  for (const repo of repos) {
    const decision = decideRepo(
      { mode: repo.mode, version: repo.version },
      orgDefault,
      version,
    );
    results.push({ repo: repo.repo, action: decision.action, reason: decision.reason });
    log(`  ${repo.repo}: ${decision.action} — ${decision.reason}`);

    if (decision.action === "converge") {
      try {
        await converge(repo.repo);
        toStamp.push(repo.repo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ${repo.repo}: convergence failed, not stamping — ${msg}`);
        // A convergence failure is its own outcome — distinct from
        // "already up to date" (skip-current) — so the report can't be
        // misread as a clean run. It is not stamped and must be retried.
        results[results.length - 1] = {
          repo: repo.repo,
          action: "failed",
          reason: `convergence failed: ${msg}`,
        };
      }
    }
  }

  let stamped: string[] = [];
  if (toStamp.length > 0 && !dryRun) {
    log(`Stamping ${toStamp.length} repo(s) with ${version}...`);
    try {
      await client.stampVersion(toStamp, version);
      stamped = [...toStamp];
    } catch (err) {
      if (err instanceof PartialStampError) {
        stamped = [...err.stamped];
        const notStamped = [...err.failedBatch, ...err.notAttempted];
        log(
          `  stampVersion failed partway: ${stamped.length} repo(s) stamped, ` +
            `${notStamped.length} repo(s) not stamped (${notStamped.join(", ")}) — ${err.message}`,
        );
        // Downgrade the not-actually-stamped repos' recorded action to
        // `failed` so the report reflects reality: they were converged
        // but the stamp write never landed, so a re-sweep must retry
        // them rather than the report silently claiming success.
        for (const repoName of notStamped) {
          const idx = results.findIndex((r) => r.repo === repoName);
          if (idx !== -1) {
            results[idx] = {
              repo: repoName,
              action: "failed",
              reason: `converged but stamp write failed: ${err.message}`,
            };
          }
        }
      } else {
        throw err;
      }
    }
  } else if (toStamp.length > 0) {
    log(`[dry-run] would stamp ${toStamp.length} repo(s) with ${version}`);
  }

  const failed = results.filter((r) => r.action === "failed").map((r) => r.repo);

  const merged: MergeAttemptResult[] = [];
  const awaitingChecks: MergeAttemptResult[] = [];
  const mergeClient = options.mergeClient;
  if (mergeClient) {
    const appSlug = options.appSlug;
    if (!appSlug) {
      throw new Error("appSlug is required when mergeClient is supplied");
    }
    // The merge pass runs over every repo the properties API returned,
    // independent of that repo's version-skip decision — a stamped
    // repo can still have an unmerged converger PR sitting open.
    for (const repo of repos) {
      const prs = await mergeClient.listOwnOpenPullRequests(
        org,
        repo.repo,
        appSlug,
      );
      for (const pr of prs) {
        const attempt = await mergeClient.evaluateAndMerge(
          org,
          repo.repo,
          pr,
          dryRun,
        );
        log(
          `  ${repo.repo}#${pr.number}: ${attempt.outcome} — ${attempt.reason}`,
        );
        if (attempt.outcome === "merged") {
          merged.push(attempt);
        } else {
          awaitingChecks.push(attempt);
        }
      }
    }
  }

  return {
    org,
    version,
    orgDefault,
    dryRun,
    results,
    converged: toStamp,
    stamped: dryRun ? [] : stamped,
    failed,
    skippedUnmanaged: results.filter((r) => r.action === "skip-unmanaged").length,
    skippedCurrent: results.filter((r) => r.action === "skip-current").length,
    merged,
    awaitingChecks,
  };
}

/**
 * Build a client and run a sweep from environment-provided config. This
 * is the CI entry point the `sweep` CLI subcommand calls.
 *
 * Required env:
 * - `GH_REPO_CONFIG_ORG` — the org to sweep.
 * - `GH_REPO_CONFIG_TOKEN` — a bearer token (the App installation token).
 * - `GH_REPO_CONFIG_APP_SLUG` — the converger App's slug, used by the
 *   merge pass (issue #24) to match `user.login === "<slug>[bot]"` when
 *   listing a repo's open PRs. `sweep.yml` already knows this — it's
 *   the App the token-mint step mints from.
 *
 * Optional env:
 * - `GH_REPO_CONFIG_DRY_RUN` — `true` to decide/log without stamping or
 *   merging.
 * - `GITHUB_API_URL` — API base (GitHub Actions sets this).
 */
export async function runSweepFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SweepReport> {
  const org = env.GH_REPO_CONFIG_ORG;
  const token = env.GH_REPO_CONFIG_TOKEN;
  const appSlug = env.GH_REPO_CONFIG_APP_SLUG;
  if (!org) {
    throw new Error("GH_REPO_CONFIG_ORG is required");
  }
  if (!token) {
    throw new Error("GH_REPO_CONFIG_TOKEN is required");
  }
  if (!appSlug) {
    throw new Error("GH_REPO_CONFIG_APP_SLUG is required");
  }

  const apiBase = env.GITHUB_API_URL;
  const clientOptions: OrgPropertiesClientOptions = {
    org,
    token,
    ...(apiBase ? { apiBase } : {}),
  };
  const client = new OrgPropertiesClient(clientOptions);

  const mergeClientOptions: MergeClientOptions = {
    token,
    ...(apiBase ? { apiBase } : {}),
  };
  const mergeClient = new MergeClient(mergeClientOptions);

  return runSweep(client, org, CURRENT_VERSION, {
    dryRun: env.GH_REPO_CONFIG_DRY_RUN === "true",
    mergeClient,
    appSlug,
  });
}
