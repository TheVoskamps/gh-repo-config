/**
 * The template render pipeline (issue #14) — `__PLACEHOLDER__` string
 * substitution plus the composite `dependabot.yml` ecosystem expansion.
 *
 * Every later file-rendering slice (#17, #18, #25) reuses this pipeline,
 * so its contract is deliberately small:
 *
 * - {@link renderTemplate} does whole-string `__TOKEN__` replacement of
 *   the three per-repo tokens (`__GH_ORG__`, `__GH_REPO__`,
 *   `__DEFAULT_BRANCH__`). A template with zero tokens is a valid
 *   identity render.
 * - {@link assertNoUnresolvedTokens} enforces that a **rendered
 *   template** carries no remaining `__…__` tokens; it is called on
 *   rendered templates only, never on verbatim scripts (a shell script
 *   may legitimately contain `__`-delimited words).
 * - {@link renderDependabotYml} performs the composite expansion of
 *   `__DEPENDABOT_ECOSYSTEMS__` documented in the `github-setup`
 *   plugin's `gh-repo-setup-protection` SKILL.md "Step 3": one rendered
 *   copy of `ecosystem-block.yml` per armed ecosystem, with the variant
 *   parts resolved per ecosystem *class*.
 */

/** Per-target-repo values the `__…__` tokens substitute to. */
export interface RepoContext {
  /** Owning org/user — substitutes `__GH_ORG__`. */
  readonly org: string;
  /** Repo name without owner — substitutes `__GH_REPO__`. */
  readonly repo: string;
  /** Default branch — substitutes `__DEFAULT_BRANCH__`. */
  readonly defaultBranch: string;
}

/**
 * Substitute the three per-repo tokens in a template string. Every
 * occurrence of each token is replaced (a template may carry a token
 * more than once, e.g. `__DEFAULT_BRANCH__` in both `on:` and a
 * comment). A template with none of the tokens renders to itself.
 */
export function renderTemplate(template: string, ctx: RepoContext): string {
  return template
    .split("__GH_ORG__")
    .join(ctx.org)
    .split("__GH_REPO__")
    .join(ctx.repo)
    .split("__DEFAULT_BRANCH__")
    .join(ctx.defaultBranch);
}

/**
 * Assert a **rendered template** contains no unresolved `__…__` tokens.
 * Throws with the offending token names when any remain, which fails the
 * repo's converge (per the issue's "assert and fail otherwise" rule).
 *
 * The token shape mirrors the payload convention (double-underscore
 * delimited UPPER_SNAKE_CASE): `__` + one-or-more of `[A-Z0-9_]` + `__`.
 * This is only ever applied to rendered `.yml` templates — never to the
 * verbatim `.sh` scripts, whose contents are shipped byte-for-byte and
 * may legitimately contain `__`-delimited identifiers.
 *
 * @param rendered the post-substitution template content.
 * @param label a human-readable name for the template, for the error.
 */
export function assertNoUnresolvedTokens(
  rendered: string,
  label: string,
): void {
  const matches = rendered.match(/__[A-Z0-9_]+__/g);
  if (matches && matches.length > 0) {
    const unique = [...new Set(matches)];
    throw new Error(
      `Template ${label} has unresolved placeholder(s) after render: ${unique.join(
        ", ",
      )}`,
    );
  }
}

/**
 * The full Dependabot ecosystem set the converger arms, unconditionally,
 * on every managed repo. Kept sorted so the rendered blocks are
 * deterministic (a re-run is a byte-for-byte no-op, not a reorder
 * churn). `github-actions` is the always-armed floor.
 *
 * Source of the set: the `gh-repo-setup-protection` SKILL.md Step 2/3
 * supported list.
 */
export const DEPENDABOT_ECOSYSTEMS: readonly string[] = [
  "bundler",
  "cargo",
  "composer",
  "docker",
  "github-actions",
  "gomod",
  "gradle",
  "maven",
  "npm",
  "pip",
  "terraform",
] as const;

/** The three ecosystem classes that drive the block-variant resolution. */
type EcosystemClass = "npm-pip" | "github-actions" | "other";

function ecosystemClass(ecosystem: string): EcosystemClass {
  if (ecosystem === "npm" || ecosystem === "pip") {
    return "npm-pip";
  }
  if (ecosystem === "github-actions") {
    return "github-actions";
  }
  return "other";
}

/**
 * Strip the leading comment block from a payload template. Both
 * `ecosystem-block.yml` and the outer `dependabot.yml` carry a leading
 * comment header that documents the placeholders; only the YAML body is
 * rendered. The body begins at the first line that is neither blank nor
 * a `#` comment.
 */
function stripLeadingComments(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      start++;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n");
}

/**
 * Render one ecosystem's `updates:` block from the (comment-stripped)
 * `ecosystem-block.yml` body, resolving the class-varying placeholders.
 *
 * The block placeholders (`__DIRECTORY_BLOCK__`,
 * `__VERSIONING_STRATEGY_BLOCK__`, `__COOLDOWN_BLOCK__`) each sit alone
 * on a 4-space-indented line. The substituted value's first line carries
 * no leading indent (the template's 4 spaces supply it) and continuation
 * lines carry their own absolute indent. When a block is empty for a
 * class (`__VERSIONING_STRATEGY_BLOCK__` off npm/pip), the whole
 * placeholder line is dropped so no whitespace-only line remains.
 */
function renderEcosystemBlock(
  blockTemplate: string,
  ecosystem: string,
  ctx: RepoContext,
): string {
  const cls = ecosystemClass(ecosystem);

  const scheduleInterval = cls === "github-actions" ? "weekly" : "daily";

  // __DIRECTORY_BLOCK__: github-actions uses a singular fixed directory;
  // every other ecosystem uses a recursing root globstar.
  const directoryBlock =
    cls === "github-actions"
      ? 'directory: "/"'
      : 'directories:\n      - "**/*"';

  // __VERSIONING_STRATEGY_BLOCK__: npm/pip only; empty (line dropped)
  // elsewhere.
  const versioningBlock =
    cls === "npm-pip" ? "versioning-strategy: increase" : null;

  // __COOLDOWN_BLOCK__: npm/pip get per-semver tiers; every other
  // ecosystem gets default-days only (semver tiers are rejected there).
  const cooldownBlock =
    cls === "npm-pip"
      ? "cooldown:\n      semver-major-days: 14\n      semver-minor-days: 7\n      semver-patch-days: 7\n      default-days: 7"
      : "cooldown:\n      default-days: 7";

  const lines = blockTemplate.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "__VERSIONING_STRATEGY_BLOCK__") {
      // Empty-block collapse: drop the whole line when there is no value.
      if (versioningBlock !== null) {
        out.push(substituteBlockLine(line, versioningBlock));
      }
      continue;
    }
    if (trimmed === "__DIRECTORY_BLOCK__") {
      out.push(substituteBlockLine(line, directoryBlock));
      continue;
    }
    if (trimmed === "__COOLDOWN_BLOCK__") {
      out.push(substituteBlockLine(line, cooldownBlock));
      continue;
    }
    // Scalar placeholders on ordinary lines.
    out.push(
      line
        .split("__ECOSYSTEM__")
        .join(ecosystem)
        .split("__SCHEDULE_INTERVAL__")
        .join(scheduleInterval)
        .split("__DEFAULT_BRANCH__")
        .join(ctx.defaultBranch),
    );
  }
  return out.join("\n");
}

/**
 * Replace a lone block-placeholder line with a multi-line value,
 * preserving the placeholder line's leading indent for the value's
 * first line. Continuation lines in `value` already carry their own
 * absolute indent.
 */
function substituteBlockLine(placeholderLine: string, value: string): string {
  const indent = placeholderLine.slice(
    0,
    placeholderLine.length - placeholderLine.trimStart().length,
  );
  const valueLines = value.split("\n");
  return valueLines
    .map((vl, i) => (i === 0 ? indent + vl : vl))
    .join("\n");
}

/**
 * Render the full `dependabot.yml` for a repo: expand
 * `__DEPENDABOT_ECOSYSTEMS__` in the outer template into one rendered
 * `ecosystem-block.yml` copy per armed ecosystem (sorted for
 * determinism), then substitute any per-repo tokens in the outer
 * template. The result is asserted free of unresolved tokens by the
 * caller (via {@link assertNoUnresolvedTokens}).
 *
 * @param outerTemplate raw `dependabot.yml` payload (with comment header).
 * @param blockTemplate raw `ecosystem-block.yml` payload (with header).
 * @param ctx per-repo substitution values.
 */
export function renderDependabotYml(
  outerTemplate: string,
  blockTemplate: string,
  ctx: RepoContext,
): string {
  const blockBody = stripLeadingComments(blockTemplate);
  const renderedBlocks = DEPENDABOT_ECOSYSTEMS.map((eco) =>
    renderEcosystemBlock(blockBody, eco, ctx),
  );
  // Each block body already ends without a trailing newline; join with a
  // newline so the blocks concatenate cleanly under `updates:`.
  const ecosystems = renderedBlocks.join("\n");

  const outerBody = stripLeadingComments(outerTemplate);
  const withEcosystems = outerBody
    .split("__DEPENDABOT_ECOSYSTEMS__")
    .join(ecosystems);
  // The outer template may also carry the plain per-repo tokens.
  const rendered = renderTemplate(withEcosystems, ctx);
  // Guarantee a single trailing newline.
  return rendered.endsWith("\n") ? rendered : rendered + "\n";
}
