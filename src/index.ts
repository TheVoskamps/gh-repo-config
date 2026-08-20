/**
 * Public entry point for the converger package.
 *
 * Slice 1 (issue #12) exposed a readable "current version." Slice 2
 * (issue #13) added the selection-loop walking skeleton: the sweep
 * that reads the selection/stamp org custom properties, applies
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
  normalizeDefaultMode,
  type SelectionMode,
  type DefaultMode,
} from "./config/selection.js";

export {
  parseOrgConfig,
  readOrgConfig,
  assertVersionPinSatisfied,
  parseSweeperRepo,
  SWEEPER_UPDATE_POLICIES,
  DEFAULT_SWEEPER_UPDATE_POLICY,
  DEFAULT_ORG_CONFIG,
  type OrgConfig,
  type OrgConfigWarningSink,
  type SweeperUpdatePolicy,
} from "./config/org-config.js";

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
  type DefaultModeProvenance,
  type DefaultModeRead,
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
  type EvaluateAndMergeOptions,
} from "./github/merge.js";

export {
  runSweep,
  runSweepFromEnv,
  describeDefaultModeProvenanceFailure,
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
  type OpenPullRequestRef,
} from "./github/contents.js";

export {
  renderTemplate,
  renderDependabotYml,
  renderPrAutomationTemplate,
  assertNoUnresolvedTokens,
  renderNamedGroupsBlock,
  prAutomationIdentityTokens,
  DEPENDABOT_ECOSYSTEMS,
  DEFAULT_NAMED_DEPENDABOT_GROUPS,
  DEFAULT_PR_AUTOMATION_IDENTITY,
  NAMED_DEPENDABOT_GROUPS,
  PR_AUTOMATION_CONSTANTS,
  type NamedDependabotGroups,
  type OrgRenderOptions,
  type PrAutomationIdentity,
  type RepoContext,
} from "./converge/render.js";

export {
  buildDesiredFiles,
  COMMUNITY_FILE_PATHS,
  SWEEPER_WORKFLOW_PATH,
  sweeperHumanApprovalPaths,
  type DesiredFile,
  type DesiredFilesOptions,
  type SweeperOptions,
  type CommunityFileContent,
} from "./converge/files.js";

export {
  readOrgCommunityFiles,
  COMMUNITY_SOURCE_REPO,
} from "./converge/community.js";

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
  type AppBypass,
  type RulesetOutcome,
  type RulesetConvergeResult,
  type RulesetSemanticDiffResult,
} from "./converge/ruleset.js";
