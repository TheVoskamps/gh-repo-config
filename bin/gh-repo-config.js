#!/usr/bin/env node
// CLI entry point, built from src/ (see package.json "bin").
//
// Subcommands:
//   version  — print the converger's current version (slice 1, #12).
//   sweep    — run the selection-loop sweep over an org, reading the
//              three selection/stamp custom properties, applying the
//              precedence table + version-skip, stubbing convergence,
//              and stamping processed repos (slice 2, #13). Reads config
//              from the environment (GH_REPO_CONFIG_ORG,
//              GH_REPO_CONFIG_TOKEN, optional GH_REPO_CONFIG_DRY_RUN);
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
        `Sweep complete: ${report.converged.length} converged, ` +
          `${report.skippedCurrent} up-to-date, ` +
          `${report.skippedUnmanaged} unmanaged` +
          (report.dryRun ? " (dry-run, no stamps written)" : ""),
      );
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
