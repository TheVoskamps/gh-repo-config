/**
 * The file-convergence payload set (issue #14) — which assets render to
 * which target-repo paths, and how each is produced.
 *
 * This slice ships the first payload set: `dependabot.yml` plus the two
 * dependency gates and the back-merge guard. Later slices (#17, #18,
 * #25) add their files to {@link buildDesiredFiles} — the write path
 * (`writer.ts`) and the render pipeline (`render.ts`) are shared, so a
 * later slice only adds entries here, not a new PR-per-concern.
 *
 * Two production modes:
 *
 * - **rendered `.yml` workflows / config** — the asset is a template
 *   with `__…__` placeholders; it is rendered per repo and asserted free
 *   of unresolved tokens. Workflows land under `.github/workflows/`;
 *   `dependabot.yml` under `.github/`.
 * - **verbatim `.sh` scripts** — shipped byte-for-byte and executable
 *   (mode `100755`) under `.github/scripts/`. Scripts are never token-
 *   asserted (a shell script may legitimately contain `__`-words).
 */
import { readAssetText } from "./assets.js";
import {
  assertNoUnresolvedTokens,
  renderDependabotYml,
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
];

/**
 * A rendered `.yml` workflow: asset name (also its target basename) → it
 * renders per repo and lands under `.github/workflows/`.
 */
const RENDERED_WORKFLOWS: readonly string[] = [
  "dependency-install-gate.yml",
  "dependency-pinned-gate.yml",
  "no-back-merging-guard.yml",
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
