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
 * nine extra fixed placeholders. The write path (`writer.ts`) and the
 * render pipeline (`render.ts`) are shared, so a slice only adds entries
 * here, not a new PR-per-concern.
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
 * - **verbatim `.sh` scripts** — shipped byte-for-byte and executable
 *   (mode `100755`) under `.github/scripts/`. Scripts are never token-
 *   asserted (a shell script may legitimately contain `__`-words).
 */
import { readAssetText } from "./assets.js";
import {
  assertNoUnresolvedTokens,
  renderDependabotYml,
  renderPrAutomationTemplate,
  renderTemplate,
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
  // `__DEFAULT_BRANCH__` placeholder; its runtime detect job handles
  // language-less repos, so it ships unconditionally like the guards.
  "codeql.yml",
];

/**
 * The two PR-automation workflows (issue #25). Rendered separately from
 * {@link RENDERED_WORKFLOWS} because they carry the extra
 * {@link PR_AUTOMATION_CONSTANTS} placeholders (via
 * {@link renderPrAutomationTemplate}), not just the three plain
 * per-repo tokens `renderTemplate` handles.
 */
const RENDERED_PR_AUTOMATION_WORKFLOWS: readonly string[] = [
  "auto-enable-automerge.yml",
  "auto-rebase-prs.yml",
];

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
 * Build the full set of files the converger wants present in a target
 * repo, for the given per-repo context. Rendered templates are asserted
 * free of unresolved tokens (an unresolved token throws, failing the
 * repo's converge); verbatim scripts are shipped as-is.
 *
 * The returned list is stable-ordered (dependabot, then workflows, then
 * scripts, each in declaration order) so a diff / commit is
 * deterministic.
 */
export function buildDesiredFiles(ctx: RepoContext): DesiredFile[] {
  const files: DesiredFile[] = [];

  // dependabot.yml — composite ecosystem expansion under .github/.
  const dependabot = renderDependabotYml(
    readAssetText("dependabot.yml"),
    readAssetText("ecosystem-block.yml"),
    ctx,
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
  // extra fixed-constant + __BOT_SLUG__ substitution via
  // renderPrAutomationTemplate, not the plain three-token render.
  for (const name of RENDERED_PR_AUTOMATION_WORKFLOWS) {
    const rendered = renderPrAutomationTemplate(readAssetText(name), ctx);
    assertNoUnresolvedTokens(rendered, `.github/workflows/${name}`);
    files.push({
      path: `.github/workflows/${name}`,
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

  // Verbatim scripts under .github/scripts/, executable.
  for (const name of VERBATIM_SCRIPTS) {
    files.push({
      path: `.github/scripts/${name}`,
      content: readAssetText(name),
      executable: true,
    });
  }

  return files;
}
