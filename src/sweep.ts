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
 * Independent of the version-skip decision, every *managed* repo also
 * gets a merge pass: list the converger App's own open PRs on that
 * repo and merge whichever are green. A repo can have an unmerged
 * converger PR sitting open regardless of whether it's due for a new
 * convergence this tick, so the merge pass runs over every repo whose
 * decision is `converge` or `skip-current` — not just the ones
 * selected for `converge` this tick. Unmanaged (`skip-unmanaged`)
 * repos are never probed at all: the converger has no business on a
 * repo that opted out, so scoping is explicit in the iteration rather
 * than resting on the author filter alone.
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
import {
  ContentsClient,
  type ContentsClientOptions,
} from "./github/contents.js";
import { convergeRepoFiles } from "./converge/writer.js";
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
   * Repos that did not end the sweep successfully: the converge step
   * threw, convergence succeeded but the subsequent `stampVersion` batch
   * write for that repo failed, or that repo's merge-pass work (listing
   * or evaluating/merging its open PRs) threw an unexpected error. Not
   * stamped, not up to date, not confirmed merged — must be retried on
   * the next sweep. A non-empty `failed` means the sweep as a whole did
   * not fully succeed; see `runSweepFromEnv`'s exit-code contract in
   * `bin/gh-repo-config.js`. Does NOT include repos whose PRs are simply
   * `awaitingChecks` (red/pending/405-409) — that is expected, retried
   * next tick, and not a failure.
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

/**
 * Record a repo's outcome as `failed` in `results`, in place.
 *
 * The three call sites in {@link runSweep} (convergence-loop catch,
 * `PartialStampError` downgrade, merge-loop catch) all need to encode
 * "this repo did not end the sweep successfully, here's why" into the
 * same `results` array, so a re-sweep retries it. This is the one
 * canonical way to do that:
 *
 * - Finds the repo's existing entry by name (every repo already got a
 *   `results.push` from the initial selection loop, so an entry always
 *   exists by the time any of the three call sites run).
 * - Leaves a prior `failed` entry alone rather than clobbering it with a
 *   less-specific reason — e.g. a repo whose `converge` step already
 *   threw this tick must not have that recorded failure overwritten by a
 *   later merge-pass error for the same repo.
 *
 * @param results the sweep's in-progress results array, mutated in place.
 * @param repo the repo name to mark failed.
 * @param reason the human-readable failure reason for this repo.
 */
function markFailed(
  results: SweepRepoResult[],
  repo: string,
  reason: string,
): void {
  const idx = results.findIndex((r) => r.repo === repo);
  if (idx !== -1 && results[idx].action !== "failed") {
    results[idx] = { repo, action: "failed", reason };
  }
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
  // Repos whose selection decision was NOT skip-unmanaged — i.e. the
  // repo is managed, whether or not it happened to be due for
  // convergence this tick. The merge pass (below) is scoped to this
  // list explicitly, rather than resting on the author filter alone,
  // per issue #24's "per managed repo" step-1 scope: an unmanaged repo
  // must never be probed, even defensively.
  const managedRepos: RepoPropertyValues[] = [];

  for (const repo of repos) {
    const decision = decideRepo(
      { mode: repo.mode, version: repo.version },
      orgDefault,
      version,
    );
    results.push({ repo: repo.repo, action: decision.action, reason: decision.reason });
    log(`  ${repo.repo}: ${decision.action} — ${decision.reason}`);

    if (decision.action !== "skip-unmanaged") {
      managedRepos.push(repo);
    }

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
        markFailed(results, repo.repo, `convergence failed: ${msg}`);
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
          markFailed(
            results,
            repoName,
            `converged but stamp write failed: ${err.message}`,
          );
        }
      } else {
        throw err;
      }
    }
  } else if (toStamp.length > 0) {
    log(`[dry-run] would stamp ${toStamp.length} repo(s) with ${version}`);
  }

  const merged: MergeAttemptResult[] = [];
  const awaitingChecks: MergeAttemptResult[] = [];
  const mergeClient = options.mergeClient;
  if (mergeClient) {
    const appSlug = options.appSlug;
    if (!appSlug) {
      throw new Error("appSlug is required when mergeClient is supplied");
    }
    // The merge pass runs over every *managed* repo, independent of
    // that repo's version-skip decision — a stamped repo can still
    // have an unmerged converger PR sitting open. Unmanaged repos are
    // excluded from the iteration itself (not just filtered out by
    // author match), so an unmanaged repo is never probed at all.
    //
    // Each repo's merge-pass work is isolated in its own try/catch,
    // mirroring the convergence loop above: an unexpected error (network,
    // 5xx, auth) merging repo A must not abort the merge pass for repos
    // B/C/D. This is distinct from the 405/409 "head moved / no longer
    // mergeable" case, which `evaluateAndMerge` already reports as the
    // non-throwing `awaiting-retry` outcome — this catch only ever sees
    // genuinely unexpected failures.
    for (const repo of managedRepos) {
      try {
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ${repo.repo}: merge pass failed — ${msg}`);
        // Record this repo's outcome as `failed`, the same way the
        // convergence loop above does — a non-empty `failed` means the
        // sweep as a whole did not fully succeed and this repo must be
        // retried next tick. Don't clobber a convergence failure already
        // recorded for this repo (e.g. `converge` threw earlier this
        // tick) — that's already `failed` and already the right reason.
        markFailed(results, repo.repo, `merge pass failed: ${msg}`);
      }
    }
  }

  // Computed after the merge pass loop (not before) so a merge-pass
  // failure recorded above is reflected in `failed` too — the same
  // `results` array the convergence loop's failures already flow through.
  const failed = results.filter((r) => r.action === "failed").map((r) => r.repo);

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

  const contentsClientOptions: ContentsClientOptions = {
    token,
    ...(apiBase ? { apiBase } : {}),
  };
  const contentsClient = new ContentsClient(contentsClientOptions);
  const dryRun = env.GH_REPO_CONFIG_DRY_RUN === "true";

  // The real converge step (issue #14): render this slice's payload set
  // and open/update one PR per repo. It throws on any convergence
  // failure (unresolved token, git-data write error), which
  // `runSweep` records as that repo's `failed` outcome — the repo is
  // not stamped and is retried next tick. Under `dryRun` it computes the
  // file diff without writing.
  return runSweep(client, org, CURRENT_VERSION, {
    dryRun,
    converge: async (repo: string) => {
      await convergeRepoFiles(contentsClient, org, repo, dryRun);
    },
    mergeClient,
    appSlug,
  });
}
