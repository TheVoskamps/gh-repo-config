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
 * mutations, no files, no PR. Slice (issue #16, absorbing #17)
 * completes the protection convergence: the CodeQL payload set
 * (`src/converge/files.ts`, rendered through the #14 pipeline), the
 * server-side CodeQL default-setup off (`src/converge/default-setup.ts`,
 * `src/github/code-scanning.ts`), and the `protect-main` ruleset
 * (`src/converge/ruleset.ts`, `src/github/rulesets.ts`) — the latter two
 * pure API mutations, with the ruleset asserted only after the repo's
 * file convergence has reached the default branch (the #91/#230
 * ordering gate in `src/sweep.ts`).
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
  type SweepDefaultSetupResult,
  type SweepRulesetResult,
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
  renderPrAutomationTemplate,
  assertNoUnresolvedTokens,
  DEPENDABOT_ECOSYSTEMS,
  NAMED_DEPENDABOT_GROUPS,
  PR_AUTOMATION_CONSTANTS,
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

export {
  CodeScanningClient,
  type CodeScanningClientOptions,
  type DefaultSetupState,
  type DefaultSetupStatus,
  type DefaultSetupReadResult,
} from "./github/code-scanning.js";

export {
  convergeDefaultSetup,
  type DefaultSetupOutcome,
  type DefaultSetupConvergeResult,
} from "./converge/default-setup.js";

export {
  RulesetsClient,
  type RulesetsClientOptions,
  type RulesetSummary,
  type RulesetBody,
  type ExistingRuleset,
  type BypassActor,
  type RulesetRule,
  type RefNameCondition,
  type RulesetWriteResult,
} from "./github/rulesets.js";

export {
  convergeProtectMainRuleset,
  buildDesiredRuleset,
  unionBypassActors,
  orgRulesetGoverns,
  rulesetSemanticDiff,
  RULESET_NAME,
  AUTOMERGE_APP_SLUG,
  type AppBypass,
  type RulesetOutcome,
  type RulesetConvergeResult,
  type RulesetSemanticDiffResult,
} from "./converge/ruleset.js";
