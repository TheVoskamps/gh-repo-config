/**
 * The selection-loop walking skeleton (issue #13, slice 2), plus the
 * merge pass that makes fan-out runs unattended end to end (issue #24).
 *
 * Reads the three selection/stamp org custom properties, applies the
 * precedence table + version-skip to every repo, converges each due
 * repo, and re-stamps the converged repos with the current release
 * version. `runSweep`'s `converge` step is an injectable callback — the
 * function itself stays convergence-agnostic and tests supply their own
 * stub. `runSweepFromEnv` wires in the real converge step (issue #14,
 * `convergeRepoFiles` in `./converge/writer.js`), which renders this
 * slice's payload set and opens/updates one PR per repo. GHAS toggles
 * (issue #15), CodeQL default-setup, and the `protect-main` ruleset
 * (issue #16) all wire in the same way.
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
 *
 * The GHAS / merge-button settings convergence step (issue #15) is
 * pure API mutations (no files, no PR) and runs alongside the file
 * converge step, in the same `converge`-decision branch: both are
 * gated on the same version-skip decision, since both are things this
 * release's convergence is responsible for landing. The CodeQL
 * default-setup convergence step (issue #16) is a third such
 * pure-API concern in that same branch.
 *
 * The `protect-main` ruleset convergence step (issue #16) is different:
 * it runs in a SEPARATE pass AFTER the merge pass, because it must not
 * require a status-check context whose producing workflow is not yet on
 * the target's default branch (the #91/#230 phantom-check guard). Per
 * repo per tick: file render/PR -> merge pass -> the ruleset step runs
 * only once the repo's file convergence has reached the default branch
 * (file convergence was a no-op, or its converger PR merged this tick).
 * A repo whose file PR is still open is DEFERRED (ruleset skipped) and
 * NOT stamped this tick; the next tick retries. This ordering gate
 * applies only when a ruleset step is injected — without one, stamping
 * is gated on the file/GHAS/default-setup converge steps alone, exactly
 * as before issue #16.
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
import { convergeRepoFiles, type ConvergeResult } from "./converge/writer.js";
import {
  RepoSettingsClient,
  type RepoSettingsClientOptions,
} from "./github/settings.js";
import { convergeGhasSettings, type GhasConvergeResult } from "./converge/ghas.js";
import {
  CodeScanningClient,
  type CodeScanningClientOptions,
} from "./github/code-scanning.js";
import {
  convergeDefaultSetup,
  type DefaultSetupConvergeResult,
} from "./converge/default-setup.js";
import {
  RulesetsClient,
  type RulesetsClientOptions,
} from "./github/rulesets.js";
import {
  convergeProtectMainRuleset,
  AUTOMERGE_APP_SLUG,
  type AppBypass,
  type RulesetConvergeResult,
} from "./converge/ruleset.js";
import { CURRENT_VERSION } from "./version.js";

/** One repo's outcome in a sweep run. */
export interface SweepRepoResult {
  readonly repo: string;
  readonly action: RepoAction;
  readonly reason: string;
}

/** One repo's file-convergence outcome, keyed by repo name. */
export interface SweepConvergeResult {
  readonly repo: string;
  readonly result: ConvergeResult;
}

/** One repo's GHAS/merge-button settings-convergence outcome, keyed by repo name. */
export interface SweepGhasResult {
  readonly repo: string;
  readonly result: GhasConvergeResult;
}

/** One repo's CodeQL default-setup convergence outcome, keyed by repo name. */
export interface SweepDefaultSetupResult {
  readonly repo: string;
  readonly result: DefaultSetupConvergeResult;
}

/** One repo's `protect-main` ruleset convergence outcome, keyed by repo name. */
export interface SweepRulesetResult {
  readonly repo: string;
  readonly result: RulesetConvergeResult;
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
   * Per-repo file-convergence outcome (which files changed, whether a PR
   * was opened/updated and its number/url, or `noop: true` when there
   * was no diff to write) for every repo whose `converge` step returned
   * a {@link ConvergeResult} — i.e. every repo in `converged` whose
   * injected `converge` callback reported one. `runSweepFromEnv`'s real
   * converge step (issue #14, {@link convergeRepoFiles}) always returns
   * one; a test stub that returns nothing simply contributes no entry
   * here. This is what lets a sweep run's report surface which
   * converger PR was opened or updated per repo, rather than only
   * whether convergence succeeded.
   */
  readonly convergeResults: readonly SweepConvergeResult[];
  /**
   * Per-repo GHAS / merge-button settings-convergence outcome (issue
   * #15) — which settings changed, were already converged, or were
   * skipped (and why) — for every repo whose `convergeGhas` step ran.
   * Mirrors `convergeResults`' per-repo shape but for the pure-API
   * settings concern rather than the file-write concern.
   */
  readonly ghasResults: readonly SweepGhasResult[];
  /**
   * Per-repo CodeQL default-setup convergence outcome (issue #16) — a
   * pure-API mutation run alongside the file/GHAS converge steps: driven
   * to `not-configured`, already-converged, or skipped (feature/plan
   * unavailable). Only present for repos whose `convergeDefaultSetup`
   * step ran.
   */
  readonly defaultSetupResults: readonly SweepDefaultSetupResult[];
  /**
   * Per-repo `protect-main` ruleset convergence outcome (issue #16) —
   * created / updated / unchanged / org-governed, plus any uninstalled
   * bypass Apps, whether `code_quality` was skipped, and any unknown
   * server-side rule-parameter keys surfaced (an operator action cue —
   * never drift, never affects the outcome; see
   * `RulesetConvergeResult.unknownParams`). Only present for repos whose
   * ruleset step ran this tick — a repo whose file PR did not merge yet
   * is deferred (see {@link SweepReport.rulesetDeferred}), so it
   * contributes no entry here.
   */
  readonly rulesetResults: readonly SweepRulesetResult[];
  /**
   * Repos whose `protect-main` ruleset step was deferred this tick
   * because their file convergence PR had not yet reached the default
   * branch (opened this tick but not merged — checks pending). Per the
   * #91/#230 ordering gate, the ruleset (which requires the file PR's
   * status-check contexts) must not be asserted until its producing
   * workflows are on the default branch. These repos are also NOT
   * stamped this tick — the next tick retries once the PR merges. Not a
   * failure.
   */
  readonly rulesetDeferred: readonly string[];
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

/**
 * One-line human-readable summary of a repo's {@link ConvergeResult}, for
 * the sweep's per-repo log line — e.g. "PR #12 opened", "PR #12 updated",
 * or "no diff, no PR".
 */
function describeConvergeResult(result: ConvergeResult): string {
  if (result.noop) {
    return "no diff, no PR";
  }
  const pr = result.pullRequest;
  if (!pr) {
    // dryRun with a diff: files would change but no PR is opened.
    return `${result.changed.length} file(s) would change (dry-run, no PR)`;
  }
  return `PR #${pr.number} ${pr.updated ? "updated" : "opened"} (${pr.url})`;
}

/**
 * One-line human-readable summary of a repo's {@link GhasConvergeResult},
 * for the sweep's per-repo log line — e.g. "3 changed, 2 already
 * converged, 1 skipped".
 */
function describeGhasResult(result: GhasConvergeResult): string {
  if (result.noop) {
    return "settings already converged";
  }
  const changed = result.results.filter((r) => r.outcome === "changed").length;
  const alreadyConverged = result.results.filter(
    (r) => r.outcome === "already-converged",
  ).length;
  const skipped = result.results.filter((r) => r.outcome === "skipped");
  const parts = [`${changed} changed`, `${alreadyConverged} already converged`];
  if (skipped.length > 0) {
    parts.push(
      `${skipped.length} skipped (${skipped.map((s) => s.setting).join(", ")})`,
    );
  }
  return parts.join(", ");
}

/**
 * One-line human-readable summary of a repo's
 * {@link DefaultSetupConvergeResult}.
 */
function describeDefaultSetupResult(result: DefaultSetupConvergeResult): string {
  switch (result.outcome) {
    case "changed":
      return `default setup: ${result.reason ?? "changed"}`;
    case "already-converged":
      return "default setup: already not-configured";
    case "skipped":
      return `default setup: skipped (${result.reason ?? "unavailable"})`;
  }
}

/**
 * One-line human-readable summary of a repo's
 * {@link RulesetConvergeResult}.
 */
function describeRulesetResult(result: RulesetConvergeResult): string {
  const extras: string[] = [];
  if (result.codeQualitySkipped) {
    extras.push("code quality: skipped (rule type not available)");
  }
  if (result.uninstalledApps && result.uninstalledApps.length > 0) {
    extras.push(`uninstalled bypass App(s): ${result.uninstalledApps.join(", ")}`);
  }
  if (result.unknownParams && result.unknownParams.length > 0) {
    extras.push(
      `unknown rule param(s) on server, canonical asset needs updating: ${result.unknownParams.join(", ")}`,
    );
  }
  let head: string;
  switch (result.outcome) {
    case "created":
      head = "protect-main ruleset: created";
      break;
    case "updated":
      head = `protect-main ruleset: updated (changed: ${(result.changedFields ?? []).join(", ")})`;
      break;
    case "unchanged":
      head = "protect-main ruleset: unchanged";
      break;
    case "org-governed":
      head = `protect-main ruleset: ${result.reason ?? "org-governed"}`;
      break;
  }
  return [head, ...extras].join("; ");
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
   * Injectable converge step. `runSweep` has no built-in default and
   * stays convergence-agnostic; `runSweepFromEnv` supplies the real
   * (throwing-on-failure) converger (issue #14,
   * {@link convergeRepoFiles} in `./converge/writer.js`), and tests
   * supply their own stub. Returning normally means "converged, safe to
   * stamp"; throwing records that repo's outcome as `failed` in the
   * report (not stamped, not treated as up to date) and causes the
   * sweep as a whole to be reported as failed — see
   * {@link SweepReport.failed}. The callback may optionally return a
   * {@link ConvergeResult} describing what it wrote (or would have
   * written, under `dryRun`); when it does, `runSweep` carries it into
   * {@link SweepReport.convergeResults} so the report can surface which
   * converger PR was opened or updated per repo. A stub that returns
   * nothing (the common case in tests that don't care about file
   * convergence) simply contributes no `convergeResults` entry.
   */
  readonly converge?: (
    repo: string,
  ) => Promise<ConvergeResult | void> | ConvergeResult | void;
  /**
   * Injectable GHAS/merge-button settings-convergence step (issue #15).
   * Like {@link converge}, stays convergence-agnostic here — tests
   * supply their own stub, `runSweepFromEnv` wires in the real
   * {@link convergeGhasSettings}. Runs in the same `converge`-decision
   * branch, alongside the file converge step: a thrown error is caught
   * independently (so a GHAS-settings failure doesn't also discard an
   * otherwise-successful file convergence result, and vice versa) but
   * either failure still marks the repo `failed` and skips stamping.
   * Returning normally with a {@link GhasConvergeResult} surfaces it in
   * {@link SweepReport.ghasResults}; a stub that returns nothing
   * contributes no entry.
   */
  readonly convergeGhas?: (
    repo: string,
  ) => Promise<GhasConvergeResult | void> | GhasConvergeResult | void;
  /**
   * Injectable CodeQL default-setup convergence step (issue #16). A pure
   * API mutation run alongside {@link converge} and {@link convergeGhas}
   * in the same `converge`-decision branch, in its own try/catch: a
   * thrown error marks the repo `failed` and skips stamping, but does not
   * discard the other steps' results. `runSweepFromEnv` wires in the real
   * {@link convergeDefaultSetup}. A stub returning nothing contributes no
   * {@link SweepReport.defaultSetupResults} entry.
   */
  readonly convergeDefaultSetup?: (
    repo: string,
  ) => Promise<DefaultSetupConvergeResult | void> | DefaultSetupConvergeResult | void;
  /**
   * Injectable `protect-main` ruleset convergence step (issue #16). Runs
   * in a **separate pass after the merge pass**, gated by the ordering
   * rule: for each due repo, the ruleset step runs only once the repo's
   * file convergence has reached the default branch this tick — i.e. its
   * file convergence was a no-op (nothing to merge) OR its converger PR
   * merged in the merge pass this tick. When the file PR is still open
   * (opened this tick, checks pending), the ruleset is **deferred** and
   * the repo is not stamped (see {@link SweepReport.rulesetDeferred}); the
   * next tick retries. `runSweepFromEnv` wires in the real
   * {@link convergeProtectMainRuleset}.
   *
   * When this option is **omitted**, there is no ruleset pass and no
   * ordering gate: stamping is gated on the file/GHAS/default-setup
   * converge steps alone, exactly as before issue #16. A thrown error
   * marks the repo `failed` and skips stamping.
   */
  readonly convergeRuleset?: (
    repo: string,
  ) => Promise<RulesetConvergeResult | void> | RulesetConvergeResult | void;
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
  const convergeGhas = options.convergeGhas ?? (() => {});
  const convergeDefaultSetupStep = options.convergeDefaultSetup ?? (() => {});
  const convergeRulesetStep = options.convergeRuleset;
  const dryRun = options.dryRun ?? false;

  const orgDefault = normalizeOrgDefault(await client.readOrgDefault());
  const repos = await client.readAllRepoValues();

  log(
    `Sweep of ${org}: version=${version}, org default=${orgDefault}, ${repos.length} repo(s)`,
  );

  const results: SweepRepoResult[] = [];
  const convergeResults: SweepConvergeResult[] = [];
  const ghasResults: SweepGhasResult[] = [];
  const defaultSetupResults: SweepDefaultSetupResult[] = [];
  const rulesetResults: SweepRulesetResult[] = [];
  const rulesetDeferred: string[] = [];
  // Repos whose per-repo converge steps (file + GHAS + default-setup) all
  // succeeded this tick — the stamp candidates, pending the ruleset
  // ordering gate below. Kept as an ordered list plus a per-repo record
  // of whether the file convergence was a no-op (no PR to merge), which
  // the ordering gate reads.
  const convergedOk: string[] = [];
  const fileConvergeNoop = new Map<string, boolean>();
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
      // File convergence and GHAS/merge-button settings convergence are
      // independent concerns, each in its own try/catch: a failure in
      // one must not swallow or skip the other, so both are always
      // attempted. Either failure still marks the repo `failed` overall
      // (via `markFailed`, which never clobbers an already-recorded
      // failure) and excludes it from `toStamp`.
      let fileConvergeOk = true;
      // Default to no-op-true so a repo whose injected converge step
      // returns nothing (the common test stub) is treated as "no PR to
      // wait on" by the ordering gate, matching prior stamp-immediately
      // behavior for such stubs.
      let repoFileNoop = true;
      try {
        const convergeResult = await converge(repo.repo);
        if (convergeResult) {
          convergeResults.push({ repo: repo.repo, result: convergeResult });
          repoFileNoop = convergeResult.noop;
          log(`  ${repo.repo}: ${describeConvergeResult(convergeResult)}`);
        }
      } catch (err) {
        fileConvergeOk = false;
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ${repo.repo}: convergence failed, not stamping — ${msg}`);
        // A convergence failure is its own outcome — distinct from
        // "already up to date" (skip-current) — so the report can't be
        // misread as a clean run. It is not stamped and must be retried.
        markFailed(results, repo.repo, `convergence failed: ${msg}`);
      }

      let ghasConvergeOk = true;
      try {
        const ghasResult = await convergeGhas(repo.repo);
        if (ghasResult) {
          ghasResults.push({ repo: repo.repo, result: ghasResult });
          log(`  ${repo.repo}: ${describeGhasResult(ghasResult)}`);
        }
      } catch (err) {
        ghasConvergeOk = false;
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ${repo.repo}: GHAS settings convergence failed, not stamping — ${msg}`);
        markFailed(results, repo.repo, `GHAS settings convergence failed: ${msg}`);
      }

      // CodeQL default-setup convergence (issue #16): a pure API mutation,
      // independent concern in its own try/catch alongside file + GHAS.
      let defaultSetupOk = true;
      try {
        const dsResult = await convergeDefaultSetupStep(repo.repo);
        if (dsResult) {
          defaultSetupResults.push({ repo: repo.repo, result: dsResult });
          log(`  ${repo.repo}: ${describeDefaultSetupResult(dsResult)}`);
        }
      } catch (err) {
        defaultSetupOk = false;
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ${repo.repo}: default-setup convergence failed, not stamping — ${msg}`);
        markFailed(results, repo.repo, `default-setup convergence failed: ${msg}`);
      }

      if (fileConvergeOk && ghasConvergeOk && defaultSetupOk) {
        convergedOk.push(repo.repo);
        fileConvergeNoop.set(repo.repo, repoFileNoop);
      }
    }
  }

  // The merge pass (issue #24) runs BEFORE stamping and before the
  // ruleset pass, so the ordering gate below can observe which repos'
  // converger PRs merged this tick.
  const merged: MergeAttemptResult[] = [];
  const awaitingChecks: MergeAttemptResult[] = [];
  // Repos that had at least one converger PR merged this tick — the
  // ordering gate's "file convergence reached the default branch" signal.
  const mergedThisTick = new Set<string>();
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
            mergedThisTick.add(repo.repo);
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

  // The `protect-main` ruleset pass (issue #16) runs AFTER the merge pass
  // so the #91/#230 ordering gate can observe which repos' file
  // convergence reached the default branch this tick. For each repo whose
  // per-repo converge steps all succeeded:
  //   - file convergence was a no-op (nothing to merge) OR its converger
  //     PR merged this tick  -> assert the ruleset now (stamp-eligible),
  //   - file PR opened this tick but not yet merged                 -> DEFER
  //     the ruleset AND skip stamping (retried next tick).
  // The gate applies only when a ruleset step is injected. Without one,
  // there is no ruleset pass and stamping is gated on the converge steps
  // alone (pre-#16 behavior), so `convergedOk` is the stamp set directly.
  const toStamp: string[] = [];
  if (convergeRulesetStep) {
    for (const repo of convergedOk) {
      const fileLandedOnDefault =
        (fileConvergeNoop.get(repo) ?? true) || mergedThisTick.has(repo);
      if (!fileLandedOnDefault) {
        // Ordering gate: file PR not on the default branch yet. Defer the
        // ruleset and do not stamp — the next tick retries once it merges.
        rulesetDeferred.push(repo);
        log(
          `  ${repo}: protect-main ruleset deferred — file convergence PR not yet merged (retry next tick, not stamping)`,
        );
        continue;
      }
      try {
        const rulesetResult = await convergeRulesetStep(repo);
        if (rulesetResult) {
          rulesetResults.push({ repo, result: rulesetResult });
          log(`  ${repo}: ${describeRulesetResult(rulesetResult)}`);
        }
        toStamp.push(repo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ${repo}: ruleset convergence failed, not stamping — ${msg}`);
        markFailed(results, repo, `ruleset convergence failed: ${msg}`);
      }
    }
  } else {
    toStamp.push(...convergedOk);
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

  // Computed after the merge pass loop and ruleset pass (not before) so a
  // merge-pass or ruleset failure recorded above is reflected in `failed`
  // too — the same `results` array the convergence loop's failures already
  // flow through.
  const failed = results.filter((r) => r.action === "failed").map((r) => r.repo);

  return {
    org,
    version,
    orgDefault,
    dryRun,
    results,
    converged: toStamp,
    convergeResults,
    ghasResults,
    defaultSetupResults,
    rulesetResults,
    rulesetDeferred,
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

  const settingsClientOptions: RepoSettingsClientOptions = {
    token,
    ...(apiBase ? { apiBase } : {}),
  };
  const settingsClient = new RepoSettingsClient(settingsClientOptions);

  const codeScanningClientOptions: CodeScanningClientOptions = {
    token,
    ...(apiBase ? { apiBase } : {}),
  };
  const codeScanningClient = new CodeScanningClient(codeScanningClientOptions);

  const rulesetsClientOptions: RulesetsClientOptions = {
    token,
    ...(apiBase ? { apiBase } : {}),
  };
  const rulesetsClient = new RulesetsClient(rulesetsClientOptions);

  const dryRun = env.GH_REPO_CONFIG_DRY_RUN === "true";

  // Resolve every installed App's slug -> app_id once for the whole
  // sweep (the installation set is org-wide, not per-repo). Memoized so
  // the ruleset step reuses the same lookup across all repos. An App
  // absent from the map is not installed in the org — its bypass entry is
  // omitted and reported, never failed (per issue #16 §3.4).
  let appIdsBySlug: Map<string, number> | undefined;
  const resolveAppBypass = async (): Promise<AppBypass[]> => {
    if (!appIdsBySlug) {
      appIdsBySlug = await rulesetsClient.readAppIdsBySlug(org);
    }
    return [appSlug, AUTOMERGE_APP_SLUG].map((slug) => ({
      slug,
      appId: appIdsBySlug!.get(slug),
    }));
  };

  // The real converge step (issue #14): render this slice's payload set
  // and open/update one PR per repo. It throws on any convergence
  // failure (unresolved token, git-data write error), which
  // `runSweep` records as that repo's `failed` outcome — the repo is
  // not stamped and is retried next tick. Under `dryRun` it computes the
  // file diff without writing. Its return value (which files changed,
  // and the PR that was opened/updated, or `noop: true`) flows back into
  // `runSweep`, which carries it into `SweepReport.convergeResults`.
  return runSweep(client, org, CURRENT_VERSION, {
    dryRun,
    converge: (repo: string) =>
      convergeRepoFiles(contentsClient, org, repo, dryRun),
    // The real GHAS/merge-button settings-convergence step (issue #15):
    // pure API mutations, no files, no PR. Throws on an unexpected
    // (non-422) write failure, which `runSweep` records as that repo's
    // `failed` outcome. Its per-setting result flows back into
    // `SweepReport.ghasResults`.
    convergeGhas: (repo: string) =>
      convergeGhasSettings(settingsClient, org, repo, dryRun),
    // The real CodeQL default-setup convergence step (issue #16): drive
    // server-side default setup to `not-configured` (mutually exclusive
    // with the advanced workflow). Read-then-write, report-and-skip on a
    // 403/404 (feature/plan unavailable). Throws only on an unexpected
    // (auth/scope) failure.
    convergeDefaultSetup: (repo: string) =>
      convergeDefaultSetup(codeScanningClient, org, repo, dryRun),
    // The real `protect-main` ruleset convergence step (issue #16). Runs
    // in the ordering-gated pass after the merge pass: create/converge
    // the ruleset (or delete-and-defer when an org ruleset governs).
    // Resolves the repo's default branch and the App bypass app_ids at
    // call time; a `code_quality` 422 is retried without that rule.
    convergeRuleset: async (repo: string) => {
      const defaultBranch = await contentsClient.getDefaultBranch(org, repo);
      const appBypass = await resolveAppBypass();
      return convergeProtectMainRuleset(
        rulesetsClient,
        org,
        repo,
        defaultBranch,
        appBypass,
        dryRun,
      );
    },
    mergeClient,
    appSlug,
  });
}
