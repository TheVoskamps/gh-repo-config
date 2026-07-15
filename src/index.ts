/**
 * Public entry point for the converger package.
 *
 * Slice 1 (issue #12) exposed a readable "current version." Slice 2
 * (issue #13) adds the selection-loop walking skeleton: the sweep that
 * reads the three selection/stamp org custom properties, applies the
 * precedence table + version-skip, and stamps processed repos.
 * Convergence itself is still a stub — the real convergence logic
 * (rendering dependabot.yml, GHAS toggles, ruleset management, etc.) is
 * later slices' scope (issues #14-#18).
 */
export { CURRENT_VERSION, PACKAGE_NAME } from "./version.js";

export {
  resolveManaged,
  normalizeMode,
  normalizeOrgDefault,
  type SelectionMode,
  type OrgDefault,
} from "./config/selection.js";

export { isBehind } from "./version-compare.js";

export {
  decideRepo,
  decideRepoFromRaw,
  type RepoAction,
  type RepoDecision,
  type RepoProperties,
} from "./stamp/decide.js";

export {
  OrgPropertiesClient,
  PartialStampError,
  PROPERTY_NAMES,
  MAX_REPOS_PER_BATCH,
  type OrgPropertiesClientOptions,
  type RepoPropertyValues,
} from "./github/properties.js";

export {
  runSweep,
  runSweepFromEnv,
  type SweepReport,
  type SweepRepoResult,
  type SweepOptions,
} from "./sweep.js";
