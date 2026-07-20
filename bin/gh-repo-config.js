#!/usr/bin/env node
// CLI entry point, built from src/ (see package.json "bin").
//
// Subcommands:
//   version  — print the converger's current version (slice 1, #12).
//   sweep    — run the selection-loop sweep over an org, reading the
//              three selection/stamp custom properties, applying the
//              precedence table + version-skip, converging each due
//              repo's files (#14) and GHAS/merge-button settings (#15),
//              stamping processed repos (slice 2, #13), and merging the
//              converger's own green open PRs (#24). Reads config from
//              the environment (GH_REPO_CONFIG_ORG, GH_REPO_CONFIG_TOKEN,
//              GH_REPO_CONFIG_APP_SLUG, optional GH_REPO_CONFIG_DRY_RUN);
//              intended to be invoked by the scheduled + workflow_dispatch
//              sweep workflow, which mints the App installation token.
import { CURRENT_VERSION, runSweepFromEnv } from "../dist/index.js";

const [, , command] = process.argv;

switch (command) {
  case "version":
  case undefined:
    console.log(CURRENT_VERSION);
    break;
  case "sweep":
    try {
      const report = await runSweepFromEnv();
      console.log(
        `Sweep complete: ${report.stamped.length} stamped, ` +
          `${report.skippedCurrent} up-to-date, ` +
          `${report.skippedUnmanaged} unmanaged, ` +
          `${report.failed.length} failed, ` +
          `${report.merged.length} PR(s) merged, ` +
          `${report.awaitingChecks.length} PR(s) awaiting checks, ` +
          `${report.rulesetDeferred.length} ruleset(s) deferred` +
          (report.dryRun ? " (dry-run, no stamps or merges written)" : ""),
      );
      for (const { repo, result } of report.convergeResults) {
        if (result.noop) {
          console.log(`  ${repo}: no diff, no PR`);
        } else if (result.pullRequest) {
          console.log(
            `  ${repo}: PR #${result.pullRequest.number} ` +
              `${result.pullRequest.updated ? "updated" : "opened"} ` +
              `(${result.pullRequest.url})`,
          );
        } else {
          console.log(
            `  ${repo}: ${result.changed.length} file(s) would change (dry-run, no PR)`,
          );
        }
      }
      // GHAS / merge-button settings-convergence outcome (issue #15) —
      // changed vs. already-converged vs. skipped-and-why, per repo.
      for (const { repo, result } of report.ghasResults) {
        if (result.noop) {
          console.log(`  ${repo}: settings already converged`);
          continue;
        }
        for (const setting of result.results) {
          if (setting.outcome === "changed") {
            console.log(`  ${repo}: ${setting.setting} changed`);
          } else if (setting.outcome === "skipped") {
            console.log(`  ${repo}: ${setting.setting} skipped — ${setting.reason}`);
          }
        }
      }
      // CodeQL default-setup convergence outcome (issue #16).
      for (const { repo, result } of report.defaultSetupResults) {
        if (result.outcome === "already-converged") continue;
        console.log(`  ${repo}: default-setup ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`);
      }
      // protect-main ruleset convergence outcome (issue #16).
      for (const { repo, result } of report.rulesetResults) {
        const extra = [];
        if (result.changedFields && result.changedFields.length > 0) {
          extra.push(`changed: ${result.changedFields.join(", ")}`);
        }
        if (result.codeQualitySkipped) extra.push("code quality skipped (rule type not available)");
        if (result.uninstalledApps && result.uninstalledApps.length > 0) {
          extra.push(`uninstalled bypass App(s): ${result.uninstalledApps.join(", ")}`);
        }
        if (result.unknownParams && result.unknownParams.length > 0) {
          extra.push(
            `unknown rule param(s) on server, canonical asset needs updating (bump version): ${result.unknownParams.join(", ")}`,
          );
        }
        console.log(
          `  ${repo}: protect-main ruleset ${result.outcome}` +
            (extra.length > 0 ? ` (${extra.join("; ")})` : ""),
        );
      }
      for (const repo of report.rulesetDeferred) {
        console.log(`  ${repo}: protect-main ruleset deferred — file PR not yet merged (retry next tick)`);
      }
      if (report.failed.length > 0) {
        console.error(
          `Sweep had ${report.failed.length} failed repo(s): ${report.failed.join(", ")}`,
        );
        process.exit(1);
      }
    } catch (err) {
      console.error(`Sweep failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: gh-repo-config [version|sweep]");
    process.exit(1);
}
