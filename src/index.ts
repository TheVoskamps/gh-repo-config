/**
 * Public entry point for the converger package.
 *
 * Slice 1 (issue #12) only needs to expose a readable "current
 * version" — the actual convergence logic (rendering dependabot.yml,
 * GHAS toggles, ruleset management, etc.) is later slices' scope
 * (issues #13-#18) and is intentionally not implemented here.
 */
export { CURRENT_VERSION, PACKAGE_NAME } from "./version.js";
