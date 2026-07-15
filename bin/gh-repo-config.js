#!/usr/bin/env node
// CLI entry point, built from src/ (see package.json "bin").
//
// Slice 1 (issue #12) supports exactly one subcommand: `version`,
// which prints the converger's current version so the sweep (a later
// slice) and humans running `gh release download` can read what they
// got. Further subcommands (the selection loop, convergence) are
// later slices' scope.
import { CURRENT_VERSION } from "../dist/index.js";

const [, , command] = process.argv;

switch (command) {
  case "version":
  case undefined:
    console.log(CURRENT_VERSION);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: gh-repo-config [version]");
    process.exit(1);
}
