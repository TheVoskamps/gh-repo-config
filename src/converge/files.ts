/**
 * The file-convergence payload set (issue #14, extended by issue #16) —
 * which assets render to which target-repo paths, and how each is
 * produced.
 *
 * Issue #14 shipped the first payload set: `dependabot.yml` plus the two
 * dependency gates and the back-merge guard. Issue #16 (absorbing #17)
 * adds the CodeQL payload set — the advanced-setup workflow, its sibling
 * config, and the runtime language-detection script (+ its self-test).
 * Issue #25 adds the PR-automation payload set — the auto-merge and
 * auto-rebase workflows plus the lockfile-regen script (+ its
 * self-test), rendered via {@link renderPrAutomationTemplate} for their
 * extra fixed-constant and App-identity placeholders. The write path
 * (`writer.ts`) and the render pipeline (`render.ts`) are shared, so a
 * slice only adds entries here, not a new PR-per-concern. Issue #18 adds
 * the community/governance-files payload set — literal, verbatim
 * copies (never rendered) that seed **only when the target repo has no
 * copy of its own** anywhere GitHub honors that file kind (see
 * {@link COMMUNITY_FILES} and `writer.ts`'s seed-if-absent branch);
 * issue #90 moves their content out of `assets/` and into the target
 * org's own `.github` repo, read at sweep time (see
 * {@link DesiredFilesOptions.communityFiles} and `community.ts`).
 * Issue #39 adds the `codeartifact-auth` composite action — the first
 * payload that is verbatim (no placeholders) yet lands at a bespoke
 * non-workflow path (see {@link VERBATIM_AT_PATH}). Issue #92 adds the
 * sweeper workflow — the first payload that is **conditional on which
 * repo is being converged**: it lands only on the org's sweeper repo,
 * and only when the org's `sweeper-update-policy` is not `off` (see
 * {@link SWEEPER_WORKFLOW_PATH}).
 *
 * Production modes:
 *
 * - **rendered `.yml` workflows** — the asset is a template with `__…__`
 *   placeholders; it is rendered per repo and asserted free of
 *   unresolved tokens. Workflows land under `.github/workflows/`.
 * - **rendered `.yml` config at a fixed non-workflow path** — the same
 *   render + token assertion, but landing at a bespoke path (the CodeQL
 *   config lands at `.github/codeql/codeql-config.yml`, the path the
 *   workflow's `config-file:` line references). `dependabot.yml` under
 *   `.github/` is the other bespoke-path rendered file.
 * - **verbatim `.yml` at a fixed non-workflow path** — shipped
 *   byte-for-byte, non-executable, at a bespoke path. The composite
 *   action `.github/actions/codeartifact-auth/action.yml` is the only
 *   one today: it carries nothing per-repo (everything repo-specific
 *   arrives at call time in its `role` input), so there is nothing to
 *   render.
 * - **verbatim `.sh` scripts** — shipped byte-for-byte and executable
 *   (mode `100755`) under `.github/scripts/`. Scripts are never token-
 *   asserted (a shell script may legitimately contain `__`-words).
 * - **verbatim community/governance files** — shipped byte-for-byte,
 *   non-executable, and — unlike every other payload above — never
 *   overwritten: they seed only when the target repo has no copy of
 *   its own (see {@link DesiredFile.honoredLocations}). Also unlike
 *   every other payload, their content is not an asset of this repo:
 *   it is the target org's own, looked up in the org's `.github` repo at
 *   sweep time and passed in via {@link DesiredFilesOptions.communityFiles}
 *   (issue #90) — a deliberate, narrow exception to the
 *   no-external-source-of-truth contract, confined to this payload kind.
 */
import { readAssetText } from "./assets.js";
import {
  DEFAULT_SWEEPER_UPDATE_POLICY,
  type SweeperUpdatePolicy,
} from "../config/org-config.js";
import {
  assertNoUnresolvedTokens,
  renderDependabotYml,
  renderPrAutomationTemplate,
  renderTemplate,
  type OrgRenderOptions,
  type RepoContext,
} from "./render.js";

/** One file the converger wants present in the target repo. */
export interface DesiredFile {
  /** Path in the target repo, relative to its root (POSIX separators). */
  readonly path: string;
  /** Full desired content. */
  readonly content: string;
  /**
   * Whether the file must be executable in the target repo. Scripts ship
   * `100755`; rendered YAML ships `100644`. A right-content-wrong-mode
   * script counts as *differing* (see `writer.ts`).
   */
  readonly executable: boolean;
  /**
   * When set, this file is a **seed-if-absent** community/governance
   * file (issue #18): the converger writes it only when the target
   * repo has no copy of its own at {@link DesiredFile.path} **or** at
   * any of these other basenames-locations GitHub honors for the same
   * file kind. A target's existing copy is never overwritten, byte-
   * different or not. Every other `DesiredFile` (this field absent) is
   * converge-and-overwrite: written whenever its content/mode differs
   * from the target, per {@link DesiredFile.path} only.
   */
  readonly honoredLocations?: readonly string[];
}

/**
 * A verbatim `.sh` script: asset name (also its target basename) → it
 * lands under `.github/scripts/` executable, byte-for-byte.
 */
const VERBATIM_SCRIPTS: readonly string[] = [
  "dependency-install-gate.sh",
  "dependency-pinned-gate.sh",
  "test-dependency-pinned-gate.sh",
  "no-back-merging-guard.sh",
  "test-no-back-merging-guard.sh",
  // CodeQL runtime language-detection script + its self-test (issue #16).
  "codeql-language-present.sh",
  "test-codeql-language-present.sh",
  // PR-automation lockfile-regen script + its self-test (issue #25).
  "auto-rebase-lockfile-regen.sh",
  "test-auto-rebase-lockfile-regen.sh",
  // Shell half of the codeartifact-auth composite action + its self-test
  // (issue #39). All of the action's logic lives here so it is testable
  // without a runner; the action.yml is thin glue (see
  // {@link VERBATIM_AT_PATH}) and reaches this script relatively, via
  // `$GITHUB_ACTION_PATH/../../scripts/`.
  "codeartifact-auth.sh",
  "test-codeartifact-auth.sh",
];

/**
 * A rendered `.yml` workflow: asset name (also its target basename) → it
 * renders per repo and lands under `.github/workflows/`.
 */
const RENDERED_WORKFLOWS: readonly string[] = [
  "dependency-install-gate.yml",
  "dependency-pinned-gate.yml",
  "no-back-merging-guard.yml",
  // The CodeQL advanced-setup workflow (issue #16). Carries only the
  // `__DEFAULT_BRANCH__` placeholder; its runtime detect step narrows
  // the analyzed set to the languages actually in the tracked tree
  // (with `actions` as an unconditional floor, so the set is never
  // empty), so it ships unconditionally like the guards.
  "codeql.yml",
];

/**
 * The PR-automation workflows (issue #25). Rendered separately from
 * {@link RENDERED_WORKFLOWS} because they carry the extra
 * {@link PR_AUTOMATION_CONSTANTS} and per-org App-identity placeholders
 * (via {@link renderPrAutomationTemplate}), not just the three plain
 * per-repo tokens `renderTemplate` handles.
 */
const RENDERED_PR_AUTOMATION_WORKFLOWS: readonly string[] = [
  "auto-enable-automerge.yml",
  "auto-rebase-prs.yml",
];

/**
 * The sweeper workflow's asset name (issue #92). Rendered through the
 * plain three-token {@link renderTemplate} path even though it carries
 * no placeholder today: a zero-placeholder template renders
 * byte-identical and trivially passes the unresolved-token assertion,
 * so adding a per-repo value later needs no plumbing change.
 */
const SWEEPER_WORKFLOW_ASSET = "sweeper-sweep.yml";

/**
 * Where the rendered sweeper workflow lands on the sweeper repo (issue
 * #92). Exported because the merge pass reads it too: under
 * `sweeper-update-policy: manual` a converger PR whose changed files
 * include this path is left for a human to merge (`src/sweep.ts`).
 */
export const SWEEPER_WORKFLOW_PATH = ".github/workflows/sweep.yml";

/**
 * A rendered `.yml` asset that lands at a fixed non-workflow path (not
 * under `.github/workflows/`): the asset name maps to an explicit target
 * path. Rendered and token-asserted the same as a workflow — the only
 * difference is the destination.
 *
 * The CodeQL config must land at exactly the path the workflow's
 * `config-file:` line references (`./.github/codeql/codeql-config.yml`);
 * the mapping below is the single source keeping the two consistent.
 * `dependabot.yml` is handled separately (its composite ecosystem
 * expansion is not a plain render), so it is not listed here.
 */
const RENDERED_AT_PATH: readonly { asset: string; path: string }[] = [
  { asset: "codeql-config.yml", path: ".github/codeql/codeql-config.yml" },
];

/**
 * A **verbatim** asset that lands at a fixed non-workflow path (issue
 * #39): shipped byte-for-byte and non-executable, with no render and no
 * token assertion. Distinct from {@link RENDERED_AT_PATH} because there
 * is genuinely nothing to substitute — routing a placeholder-free file
 * through the render path would advertise a per-repo variability it does
 * not have.
 *
 * The `codeartifact-auth` composite action is the only entry today.
 * Consumers call it as `uses: ./.github/actions/codeartifact-auth`, so
 * the directory name is part of its contract; the asset is stored under
 * the distinguishing flat name `codeartifact-auth-action.yml` because
 * `assets/` is a flat directory (see `assets.ts`'s `readAssetText`) and
 * a bare `action.yml` there would say nothing about which action it is.
 * The action deliberately carries no per-repo values: everything
 * repo-specific arrives at call time in its `role` input, fed from the
 * `CODEARTIFACT_ROLE` variable (org-level default, repo-level override).
 */
const VERBATIM_AT_PATH: readonly { asset: string; path: string }[] = [
  {
    asset: "codeartifact-auth-action.yml",
    path: ".github/actions/codeartifact-auth/action.yml",
  },
];

/**
 * One community/governance file the converger seeds when the target repo
 * has none of its own (issue #18): its target path (a basename, landing
 * at repo root — also the path it is looked up under in the org's
 * `.github` repo, issue #90), plus every other basename-location GitHub
 * honors for that file kind. `writer.ts`'s seed-if-absent branch skips
 * the file entirely — never overwrites — when the target already has a
 * copy at `path` **or** at any of `honoredLocations`.
 *
 * Adding a further community file (e.g. `CODE_OF_CONDUCT.md`,
 * `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `GOVERNANCE.md`,
 * `FUNDING.yml`) is a matter of adding one entry here — no change to
 * the seeding logic in `writer.ts` or the lookup in `community.ts`; an
 * org that wants it seeded then puts its copy in its `.github` repo.
 *
 * GitHub's honored locations for these top-level community files are
 * repo root, `.github/`, and `docs/`, except `FUNDING.yml` (root and
 * `.github/` only — GitHub does not honor a `docs/FUNDING.yml`).
 */
const COMMUNITY_FILES: readonly {
  path: string;
  honoredLocations: readonly string[];
}[] = [
  {
    path: "CONTRIBUTORS",
    honoredLocations: [".github/CONTRIBUTORS", "docs/CONTRIBUTORS"],
  },
  {
    path: "LICENSE",
    honoredLocations: [".github/LICENSE", "docs/LICENSE"],
  },
  {
    path: "PATENTS",
    honoredLocations: [".github/PATENTS", "docs/PATENTS"],
  },
  {
    path: "PRIOR_ART.md",
    honoredLocations: [".github/PRIOR_ART.md", "docs/PRIOR_ART.md"],
  },
];

/**
 * The community-file paths the converger seeds, in payload order — the
 * set `community.ts` looks up in the org's `.github` repo and the only
 * keys {@link DesiredFilesOptions.communityFiles} is consulted for.
 */
export const COMMUNITY_FILE_PATHS: readonly string[] = COMMUNITY_FILES.map(
  (f) => f.path,
);

/**
 * Community-file seed content by target path (issue #90): the org's own
 * copy of each {@link COMMUNITY_FILE_PATHS} entry, as found in its
 * `.github` repo. A path with no entry is one the org does not carry,
 * and produces no payload — the "nothing to seed" case.
 */
export type CommunityFileContent = Readonly<Record<string, string>>;

/**
 * Everything {@link buildDesiredFiles} takes besides the per-repo
 * context: the per-org render inputs ({@link OrgRenderOptions}, each
 * with a baked default) plus the community-file content, which has NO
 * baked default — its source is the target org's `.github` repo, read
 * at sweep time (`community.ts`), and an absent or empty map simply
 * seeds nothing.
 */
export interface DesiredFilesOptions extends OrgRenderOptions {
  /**
   * The org's community-file content by path (issue #90). Only the
   * paths in {@link COMMUNITY_FILE_PATHS} are consulted; a path absent
   * from the map yields no `DesiredFile`. Absent altogether means no
   * community file is seeded on this pass.
   */
  readonly communityFiles?: CommunityFileContent;
  /**
   * The org's sweeper repo as `owner/repo` (issue #92), exactly as the
   * invoking workflow stated it in `GH_REPO_CONFIG_SWEEPER_REPO`. The
   * sweeper workflow is a payload for that one repo and no other, so
   * this is compared against the converging repo's own `owner/repo`.
   * Absent means no repo is the sweeper this tick and the workflow is
   * not a payload anywhere.
   */
  readonly sweeperRepo?: string;
  /**
   * The org's `sweeper-update-policy` (issue #92). `off` drops the
   * sweeper workflow from the payload set entirely; `manual` and `auto`
   * both render it, and differ only in whether the merge pass may merge
   * the resulting PR (see {@link SWEEPER_WORKFLOW_PATH}). Absent takes
   * {@link DEFAULT_SWEEPER_UPDATE_POLICY}, matching what the org config
   * parse applies to an absent key.
   */
  readonly sweeperUpdatePolicy?: SweeperUpdatePolicy;
}

/**
 * Whether the repo being converged gets the sweeper workflow: it must
 * be the repo named by `sweeperRepo`, and the policy must not be `off`.
 *
 * The `gh-repo-config.json` the workflow reads is org-owned content and
 * is deliberately absent from every payload under every policy — this
 * decides the workflow only.
 */
function shipsSweeperWorkflow(
  ctx: RepoContext,
  options: DesiredFilesOptions,
): boolean {
  const policy = options.sweeperUpdatePolicy ?? DEFAULT_SWEEPER_UPDATE_POLICY;
  if (policy === "off") {
    return false;
  }
  return options.sweeperRepo === `${ctx.org}/${ctx.repo}`;
}

/**
 * Build the full set of files the converger wants present in a target
 * repo, for the given per-repo context. Rendered templates are asserted
 * free of unresolved tokens (an unresolved token throws, failing the
 * repo's converge); verbatim scripts are shipped as-is.
 *
 * The returned list is stable-ordered (dependabot, then workflows, then
 * the sweeper workflow when this repo is the sweeper, then
 * rendered-at-path config, then verbatim-at-path YAML, then scripts,
 * then community files, each in declaration order) so a diff / commit is
 * deterministic.
 *
 * @param ctx the per-repo substitution values.
 * @param options the per-org inputs (issue #87's multi-org fanout):
 *   the render inputs pass through to the render pipeline, every one
 *   optional with a baked default, so omitting them yields the
 *   single-org rendered payload byte-for-byte; `communityFiles` is the
 *   org's own seed content and has no default — omit it and no
 *   community file is emitted.
 */
export function buildDesiredFiles(
  ctx: RepoContext,
  options: DesiredFilesOptions = {},
): DesiredFile[] {
  const files: DesiredFile[] = [];

  // dependabot.yml — composite ecosystem expansion under .github/.
  const dependabot = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    ctx,
    options,
  );
  assertNoUnresolvedTokens(dependabot, ".github/dependabot.yml");
  files.push({
    path: ".github/dependabot.yml",
    content: dependabot,
    executable: false,
  });

  // Rendered workflows under .github/workflows/.
  for (const name of RENDERED_WORKFLOWS) {
    const rendered = renderTemplate(readAssetText(name), ctx);
    assertNoUnresolvedTokens(rendered, `.github/workflows/${name}`);
    files.push({
      path: `.github/workflows/${name}`,
      content: rendered,
      executable: false,
    });
  }

  // PR-automation workflows under .github/workflows/ (issue #25):
  // extra fixed-constant + per-org App-identity substitution via
  // renderPrAutomationTemplate, not the plain three-token render.
  for (const name of RENDERED_PR_AUTOMATION_WORKFLOWS) {
    const rendered = renderPrAutomationTemplate(
      readAssetText(name),
      ctx,
      options,
    );
    assertNoUnresolvedTokens(rendered, `.github/workflows/${name}`);
    files.push({
      path: `.github/workflows/${name}`,
      content: rendered,
      executable: false,
    });
  }

  // The sweeper workflow (issue #92): a payload for the org's sweeper
  // repo only, and only when the policy is `manual` or `auto`.
  if (shipsSweeperWorkflow(ctx, options)) {
    const rendered = renderTemplate(
      readAssetText(SWEEPER_WORKFLOW_ASSET),
      ctx,
    );
    assertNoUnresolvedTokens(rendered, SWEEPER_WORKFLOW_PATH);
    files.push({
      path: SWEEPER_WORKFLOW_PATH,
      content: rendered,
      executable: false,
    });
  }

  // Rendered config/YAML at fixed non-workflow paths (e.g. the CodeQL
  // config at .github/codeql/codeql-config.yml — the path the CodeQL
  // workflow's config-file: line references).
  for (const { asset, path } of RENDERED_AT_PATH) {
    const rendered = renderTemplate(readAssetText(asset), ctx);
    assertNoUnresolvedTokens(rendered, path);
    files.push({ path, content: rendered, executable: false });
  }

  // Verbatim YAML at fixed non-workflow paths (the codeartifact-auth
  // composite action at .github/actions/codeartifact-auth/action.yml —
  // the exact path its `uses: ./.github/actions/codeartifact-auth`
  // callers reference). No render, nothing per-repo to substitute.
  for (const { asset, path } of VERBATIM_AT_PATH) {
    files.push({ path, content: readAssetText(asset), executable: false });
  }

  // Verbatim scripts under .github/scripts/, executable.
  for (const name of VERBATIM_SCRIPTS) {
    files.push({
      path: `.github/scripts/${name}`,
      content: readAssetText(name),
      executable: true,
    });
  }

  // Verbatim community/governance files (issue #18): seed-if-absent,
  // never rendered, never overwritten. Content is the org's own (issue
  // #90); a file the org does not carry is silently not a payload.
  for (const { path, honoredLocations } of COMMUNITY_FILES) {
    const content = options.communityFiles?.[path];
    if (content === undefined) {
      continue;
    }
    files.push({ path, content, executable: false, honoredLocations });
  }

  return files;
}
