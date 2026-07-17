#!/usr/bin/env node
// CLI entry point, built from src/ (see package.json "bin").
//
// Subcommands:
//   version  — print the converger's current version (slice 1, #12).
//   sweep    — run the selection-loop sweep over an org, reading the
//              three selection/stamp custom properties, applying the
//              precedence table + version-skip, stubbing convergence,
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
          `${report.awaitingChecks.length} PR(s) awaiting checks` +
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
