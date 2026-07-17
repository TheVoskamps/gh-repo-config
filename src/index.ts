/**
 * Public entry point for the converger package.
 *
 * Slice 1 (issue #12) exposed a readable "current version." Slice 2
 * (issue #13) added the selection-loop walking skeleton: the sweep
 * that reads the three selection/stamp org custom properties, applies
 * the precedence table + version-skip, and stamps processed repos.
 * Slice 3 (issue #14) adds the real convergence pipeline
 * (`src/converge/`): rendering `dependabot.yml` plus the gate/guard
 * workflows and scripts from `assets/`, and writing them via the
 * git-data API (`src/github/contents.ts`). Slice (issue #15) adds the
 * GHAS / repo-security and merge-button settings convergence step
 * (`src/converge/ghas.ts`, `src/github/settings.ts`) — pure API
 * mutations, no files, no PR. Ruleset management remains a later
 * slice's scope (issue #18).
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
  MergeClient,
  type MergeClientOptions,
  type OpenPullRequest,
  type CheckState,
  type RequiredCheckResult,
  type MergeOutcome,
  type MergeAttemptResult,
} from "./github/merge.js";

export {
  runSweep,
  runSweepFromEnv,
  type SweepReport,
  type SweepRepoResult,
  type SweepConvergeResult,
  type SweepGhasResult,
  type SweepOptions,
} from "./sweep.js";

export {
  ContentsClient,
  FILE_MODE,
  type ContentsClientOptions,
  type TreeFile,
  type ExistingBlob,
  type PullRequestResult,
} from "./github/contents.js";

export {
  renderTemplate,
  renderDependabotYml,
  assertNoUnresolvedTokens,
  DEPENDABOT_ECOSYSTEMS,
  type RepoContext,
} from "./converge/render.js";

export { buildDesiredFiles, type DesiredFile } from "./converge/files.js";

export { ASSETS_DIR, readAssetText } from "./converge/assets.js";

export {
  convergeRepoFiles,
  CONVERGE_BRANCH,
  type ConvergeResult,
} from "./converge/writer.js";

export {
  RepoSettingsClient,
  SettingsWriteError,
  type RepoSettingsClientOptions,
  type RepoSecuritySettings,
  type SecurityAnalysisStatus,
} from "./github/settings.js";

export {
  convergeGhasSettings,
  type GhasConvergeResult,
  type SettingResult,
  type SettingOutcome,
} from "./converge/ghas.js";
