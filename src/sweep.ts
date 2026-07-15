/**
 * The selection-loop walking skeleton (issue #13, slice 2).
 *
 * Reads the three selection/stamp org custom properties, applies the
 * precedence table + version-skip to every repo, "converges" each due
 * repo (a **stub** — log/no-op this slice), and re-stamps the converged
 * repos with the current release version. Convergence itself (rendering
 * files, GHAS toggles, rulesets) is later slices' scope (#14–#18).
 */
import {
  normalizeOrgDefault,
  type OrgDefault,
} from "./config/selection.js";
import { decideRepo, type RepoAction } from "./stamp/decide.js";
import {
  OrgPropertiesClient,
  type OrgPropertiesClientOptions,
  type RepoPropertyValues,
} from "./github/properties.js";
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
  /** Repos that were (or would have been) converged and stamped. */
  readonly converged: readonly string[];
  readonly skippedUnmanaged: number;
  readonly skippedCurrent: number;
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
   * later slices replace it with the real converger. Returning normally
   * means "converged, safe to stamp"; throwing aborts stamping for that
   * repo (the sweep records it as still behind).
   */
  readonly converge?: (repo: string) => Promise<void> | void;
  /** Injectable logger (defaults to `console`). */
  readonly log?: (message: string) => void;
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
        // Record the failure by downgrading this repo's recorded action
        // so the report does not claim it as converged.
        results[results.length - 1] = {
          repo: repo.repo,
          action: "skip-current",
          reason: `convergence failed: ${msg}`,
        };
      }
    }
  }

  if (toStamp.length > 0 && !dryRun) {
    log(`Stamping ${toStamp.length} repo(s) with ${version}...`);
    await client.stampVersion(toStamp, version);
  } else if (toStamp.length > 0) {
    log(`[dry-run] would stamp ${toStamp.length} repo(s) with ${version}`);
  }

  return {
    org,
    version,
    orgDefault,
    dryRun,
    results,
    converged: toStamp,
    skippedUnmanaged: results.filter((r) => r.action === "skip-unmanaged").length,
    skippedCurrent: results.filter((r) => r.action === "skip-current").length,
  };
}

/**
 * Build a client and run a sweep from environment-provided config. This
 * is the CI entry point the `sweep` CLI subcommand calls.
 *
 * Required env:
 * - `GH_REPO_CONFIG_ORG` — the org to sweep.
 * - `GH_REPO_CONFIG_TOKEN` — a bearer token (the App installation token).
 *
 * Optional env:
 * - `GH_REPO_CONFIG_DRY_RUN` — `true` to decide/log without stamping.
 * - `GITHUB_API_URL` — API base (GitHub Actions sets this).
 */
export async function runSweepFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SweepReport> {
  const org = env.GH_REPO_CONFIG_ORG;
  const token = env.GH_REPO_CONFIG_TOKEN;
  if (!org) {
    throw new Error("GH_REPO_CONFIG_ORG is required");
  }
  if (!token) {
    throw new Error("GH_REPO_CONFIG_TOKEN is required");
  }

  const clientOptions: OrgPropertiesClientOptions = {
    org,
    token,
    ...(env.GITHUB_API_URL ? { apiBase: env.GITHUB_API_URL } : {}),
  };
  const client = new OrgPropertiesClient(clientOptions);

  return runSweep(client, org, CURRENT_VERSION, {
    dryRun: env.GH_REPO_CONFIG_DRY_RUN === "true",
  });
}
