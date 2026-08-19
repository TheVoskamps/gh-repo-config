/**
 * The template render pipeline (issue #14) — `__PLACEHOLDER__` string
 * substitution plus the composite `dependabot.yml` ecosystem expansion.
 *
 * Later file-rendering slices reuse this pipeline (issue #16's CodeQL
 * payload already does; issue #25 next), so its contract is deliberately
 * small:
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
 * - {@link renderPrAutomationTemplate} (issue #25) substitutes the
 *   PR-automation payload's placeholders: the three per-repo tokens
 *   {@link renderTemplate} already handles, {@link PR_AUTOMATION_CONSTANTS}
 *   (the org-agnostic contract constants), the App-identity slice
 *   ({@link PrAutomationIdentity} — per-org, defaulting to
 *   {@link DEFAULT_PR_AUTOMATION_IDENTITY}), and `__BOT_SLUG__` (per-repo,
 *   derived from the identity's `botSlug` pattern and the repo name).
 *
 * Org-specific content is injected through {@link OrgRenderOptions}
 * (issue #87's multi-org fanout): every field is optional, and an
 * absent field renders the baked TheVoskamps default byte-for-byte, so
 * a caller that passes nothing gets exactly the single-org output.
 */

/**
 * Optional per-org inputs to the render pipeline. Each field defaults
 * to the value baked into this module when absent, so `{}` (or no
 * options at all) renders exactly as the single-org converger did. The
 * per-org sweeper's config file is the intended source of these values;
 * this module only defines the seam.
 */
export interface OrgRenderOptions {
  /**
   * The org's named Dependabot groups (issue #88), rendered into every
   * armed ecosystem's `groups:` map ahead of the `*-minor-and-patch`
   * catch-all. Defaults to {@link DEFAULT_NAMED_DEPENDABOT_GROUPS}. An
   * empty map renders no named groups at all (the placeholder line is
   * dropped, like any other empty block).
   */
  readonly namedDependabotGroups?: NamedDependabotGroups;
  /**
   * The org's PR-automation App identity (issue #89): the App the
   * rendered `auto-enable-automerge.yml` / `auto-rebase-prs.yml` run as,
   * the repo secrets that carry its credentials, and the git identity
   * its rebase commits use. Defaults to
   * {@link DEFAULT_PR_AUTOMATION_IDENTITY}. Every org that runs its own
   * PR-automation App (which is every org other than the default's
   * owner — an App's owner holds its private key) must supply this.
   */
  readonly prAutomationIdentity?: PrAutomationIdentity;
}

/**
 * The App-identity slice of the PR-automation templates' placeholders
 * (issue #89): the values that name WHICH GitHub App the rendered
 * workflows act as. Each managed org registers and owns its own App, so
 * these differ per org — unlike {@link PR_AUTOMATION_CONSTANTS}, which
 * are the converger's contract with its own gates and stay fixed.
 */
export interface PrAutomationIdentity {
  /** The App's slug — substitutes `__APP_NAME__`. */
  readonly appName: string;
  /** Repo secret holding the App ID — substitutes `__APP_ID_SECRET__`. */
  readonly appIdSecret: string;
  /**
   * Repo secret holding the App private key — substitutes
   * `__APP_PRIVATE_KEY_SECRET__`.
   */
  readonly appPrivateKeySecret: string;
  /**
   * The git identity the rebase sweep commits as — substitutes
   * `__BOT_SLUG__`. This is a PATTERN, not a literal: it may carry the
   * per-repo tokens {@link renderTemplate} resolves (`__GH_ORG__`,
   * `__GH_REPO__`, `__DEFAULT_BRANCH__`), which are substituted after
   * it is spliced in. The default, `__GH_REPO__-auto-rebase[bot]`, is
   * how the historical `<repo>-auto-rebase[bot]` per-repo derivation is
   * expressed; an org whose bot identity is fixed supplies a plain
   * string with no token. Any other `__…__` token in it fails the
   * rendered template's unresolved-token assertion, as it should.
   */
  readonly botSlug: string;
}

/**
 * The default {@link PrAutomationIdentity} — the App identity baked in
 * before issue #89 made it a per-org input. Renders byte-for-byte what
 * the old `PR_AUTOMATION_CONSTANTS` identity entries and the hardcoded
 * `<repo>-auto-rebase[bot]` did.
 */
export const DEFAULT_PR_AUTOMATION_IDENTITY: PrAutomationIdentity = {
  appName: "thevoskamps-pr-automations",
  appIdSecret: "AUTOMERGE_APP_ID",
  appPrivateKeySecret: "AUTOMERGE_APP_PRIVATE_KEY",
  botSlug: "__GH_REPO__-auto-rebase[bot]",
};

/**
 * The placeholder → value map a {@link PrAutomationIdentity} substitutes.
 * The `__BOT_SLUG__` value is the identity's pattern, still carrying any
 * per-repo tokens; {@link renderPrAutomationTemplate} resolves those in
 * its final {@link renderTemplate} pass.
 */
export function prAutomationIdentityTokens(
  identity: PrAutomationIdentity,
): Readonly<Record<string, string>> {
  return {
    __APP_NAME__: identity.appName,
    __APP_ID_SECRET__: identity.appIdSecret,
    __APP_PRIVATE_KEY_SECRET__: identity.appPrivateKeySecret,
    __BOT_SLUG__: identity.botSlug,
  };
}

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
 * The fixed, org-agnostic constants the PR-automation templates
 * (`auto-enable-automerge.yml`, `auto-rebase-prs.yml`) substitute,
 * pinned by issue #25's placeholder table: merge method, do-not-merge
 * label, and the names of the gate/guard workflows and check the
 * automation keys off. These are the converger's contract with its own
 * gates — the converged standard across every managed repo in every
 * org — so nothing here is per-repo, per-org, or open to
 * interpretation, and there is deliberately no way to override them.
 *
 * No single template carries every constant: `auto-rebase-prs.yml` owns
 * the sweep-side ones and `auto-enable-automerge.yml` the
 * native-auto-merge `__MERGE_METHOD__`. `test/render.test.js` therefore
 * asserts substitution over the UNION of the two templates, and asserts
 * that union is complete — a constant used by neither template is a
 * dead entry here, not a silently-skipped assertion.
 *
 * NOT in this map: the App-identity slice (`__APP_NAME__`,
 * `__APP_ID_SECRET__`, `__APP_PRIVATE_KEY_SECRET__`, `__BOT_SLUG__`),
 * which issue #89 split out into {@link PrAutomationIdentity} because
 * each org owns its own App; and `__DEFAULT_BRANCH__`, which is per-repo
 * (handled by {@link renderTemplate}'s `RepoContext`).
 */
export const PR_AUTOMATION_CONSTANTS: Readonly<Record<string, string>> = {
  __MERGE_METHOD__: "MERGE",
  __REST_MERGE_METHOD__: "merge",
  __DO_NOT_MERGE_LABEL__: "do-not-merge",
  __REQUIRED_CHECK_WORKFLOW__: "no-back-merging-guard",
  __INSTALL_GATE_WORKFLOW__: "dependency-install-gate",
  // The install gate's single required-check job. It was the per-PM
  // matrix leg's check until issue #77 collapsed that workflow to one
  // job, at which point no per-PM check run exists to key on. Widening
  // the pre-filter is safe: the lockfile-regen script that consumes it
  // re-confirms the failure is a lockfile-only npm desync before it
  // changes anything.
  __INSTALL_GATE_CHECK__: "install-gate-required",
};

/**
 * Render a PR-automation template (`auto-enable-automerge.yml` or
 * `auto-rebase-prs.yml`): substitute the fixed
 * {@link PR_AUTOMATION_CONSTANTS}, the org's {@link PrAutomationIdentity}
 * (including its `__BOT_SLUG__` pattern), and — last, so a token inside
 * the bot-slug pattern resolves too — the three tokens
 * {@link renderTemplate} already resolves
 * (`__GH_ORG__`/`__GH_REPO__`/`__DEFAULT_BRANCH__`).
 *
 * The full surface always renders — no conditional-drop logic (unlike
 * the interactive `gh-repo-setup-pr-automation` skill, which drops the
 * `workflow_run` trigger / REST-merge job / regen scripts when a repo
 * lacks the workflows they key off). On a managed repo the gates and
 * guards are guaranteed present in the same per-repo converger PR, so
 * every placeholder always resolves.
 *
 * @param options per-org inputs; `prAutomationIdentity` defaults to
 *   {@link DEFAULT_PR_AUTOMATION_IDENTITY} when absent.
 */
export function renderPrAutomationTemplate(
  template: string,
  ctx: RepoContext,
  options: OrgRenderOptions = {},
): string {
  const identity = options.prAutomationIdentity ?? DEFAULT_PR_AUTOMATION_IDENTITY;
  let rendered = template;
  for (const [token, value] of Object.entries({
    ...PR_AUTOMATION_CONSTANTS,
    ...prAutomationIdentityTokens(identity),
  })) {
    rendered = rendered.split(token).join(value);
  }
  return renderTemplate(rendered, ctx);
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

/**
 * A registry of named Dependabot groups: group name → the
 * `patterns:` list Dependabot matches dependencies against, in the
 * order the groups are rendered (first-match-wins, see
 * {@link DEFAULT_NAMED_DEPENDABOT_GROUPS}).
 */
export type NamedDependabotGroups = Readonly<
  Record<string, readonly string[]>
>;

/**
 * The default registry of named Dependabot groups (issue #36):
 * lockstep/stack families whose members must move together because they
 * share a runtime compatibility contract (same-repo sub-actions/packages
 * exchanging versioned state, a framework + its plugin family, or an SDK
 * core + pinned transitives). Exact definitions and precedence taken
 * verbatim from `Fablegate/fablegate_quasar_fastapi`'s live production
 * `dependabot.yml`, the repo that incurred the motivating incident
 * (`github/codeql-action/init`/`analyze` version skew broke the
 * required CodeQL check on `main`).
 *
 * This is org-specific content (issue #88): a different org supplies
 * its own registry through {@link OrgRenderOptions.namedDependabotGroups}
 * and this default is what renders when it does not.
 *
 * Rendered as ONE union block, identically, into every armed ecosystem's
 * `groups:` — not scoped per ecosystem. This mirrors the
 * arm-everything-unconditionally principle {@link DEPENDABOT_ECOSYSTEMS}
 * itself follows: uniform payload everywhere is what guarantees
 * repo-identity. A group whose patterns match nothing in a given
 * ecosystem is inert there (no PR, no error).
 *
 * Named groups cover ALL update types (a lockstep family must move
 * together on majors too, unlike the `*-minor-and-patch` catch-alls).
 * Listed before the catch-all in the rendered `groups:` map so
 * Dependabot's first-match-wins group resolution puts a dependency that
 * matches both a named group and the catch-all into the named group.
 */
export const DEFAULT_NAMED_DEPENDABOT_GROUPS: NamedDependabotGroups = {
  "codeql-action": ["github/codeql-action/*"],
  "aws-cdk": ["aws-cdk", "aws-cdk-lib", "@aws-cdk/*", "constructs"],
  "vite-toolchain": [
    "vite",
    "@vitejs/*",
    "rollup",
    "typescript",
    "vue",
    "@vue/*",
    "@vitest/*",
    "vitest",
  ],
  "fastapi-stack": [
    "fastapi",
    "starlette",
    "pydantic",
    "pydantic-*",
    "pydantic_*",
    "uvicorn",
    "uvicorn-*",
  ],
  "sqlalchemy-stack": [
    "sqlalchemy",
    "alembic",
    "asyncpg",
    "psycopg",
    "psycopg2",
    "psycopg2-binary",
  ],
  "auth-stack": [
    "authlib",
    "python-jose",
    "python-jose[*]",
    "pyjwt",
    "cryptography",
  ],
  "aws-sdk": ["boto3", "botocore", "aiobotocore", "s3transfer"],
  "test-stack": ["pytest", "pytest-*"],
};

/**
 * Render a {@link NamedDependabotGroups} registry into the multi-line
 * value `__NAMED_GROUPS_BLOCK__` substitutes to. Group keys sit at the
 * `groups:` map's key indent (6 spaces under `updates:` — siblings of
 * `*-minor-and-patch`), `patterns:` at 8, list items at 10. Per the
 * block-placeholder convention ({@link renderEcosystemBlock}), the
 * first line carries no leading indent — the template's placeholder
 * line supplies it — and continuation lines carry their own absolute
 * indent. An empty registry renders the empty string.
 */
export function renderNamedGroupsBlock(groups: NamedDependabotGroups): string {
  return Object.entries(groups)
    .map(([name, patterns], i) => {
      const key = `${i === 0 ? "" : "      "}${name}:`;
      const items = patterns.map((p) => `          - ${JSON.stringify(p)}`);
      return [key, "        patterns:", ...items].join("\n");
    })
    .join("\n");
}

/**
 * The rendered form of {@link DEFAULT_NAMED_DEPENDABOT_GROUPS} — the
 * exact text every ecosystem block carries when no per-org registry is
 * supplied. Kept as an export so a caller can compare against the
 * default without re-rendering it.
 */
export const NAMED_DEPENDABOT_GROUPS: string = renderNamedGroupsBlock(
  DEFAULT_NAMED_DEPENDABOT_GROUPS,
);

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
 *
 * The source assets are ordinary text files and so end with a trailing
 * newline; a bare `split("\n")` on such a file yields a trailing empty
 * element, which would otherwise surface as an extra blank line at the
 * end of the returned body. Strip exactly one trailing newline (never
 * more — callers care whether the body genuinely ends in a blank line
 * vs. just the file's own terminator) so both {@link renderEcosystemBlock}
 * and the outer-template body it feeds render without that artifact.
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
  const body = lines.slice(start).join("\n");
  return body.endsWith("\n") ? body.slice(0, -1) : body;
}

/**
 * Render one ecosystem's `updates:` block from the (comment-stripped)
 * `ecosystem-block.yml` body, resolving the class-varying placeholders.
 *
 * The block placeholders (`__DIRECTORY_BLOCK__`,
 * `__VERSIONING_STRATEGY_BLOCK__`, `__COOLDOWN_BLOCK__`,
 * `__NAMED_GROUPS_BLOCK__`) each sit alone on an indented line. The
 * substituted value's first line carries no leading indent (the
 * template's own indent supplies it) and continuation lines carry their
 * own absolute indent. When a block is empty for a class
 * (`__VERSIONING_STRATEGY_BLOCK__` off npm/pip, or
 * `__NAMED_GROUPS_BLOCK__` for an org whose registry is empty), the
 * whole placeholder line is dropped so no whitespace-only line remains.
 * `__NAMED_GROUPS_BLOCK__` renders the same `namedGroupsBlock` (already
 * rendered by {@link renderNamedGroupsBlock}) into every ecosystem.
 */
function renderEcosystemBlock(
  blockTemplate: string,
  ecosystem: string,
  ctx: RepoContext,
  namedGroupsBlock: string,
): string {
  const cls = ecosystemClass(ecosystem);

  // __SCHEDULE_INTERVAL__: every ecosystem class runs daily. The
  // cooldown (`__COOLDOWN_BLOCK__`) is what governs which versions are
  // eligible; the schedule interval only governs how often Dependabot
  // looks, so there is no reason for github-actions to look less often.
  const scheduleInterval = "daily";

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
    if (trimmed === "__NAMED_GROUPS_BLOCK__") {
      // Same empty-block collapse as the versioning strategy: an org
      // with no named groups gets no whitespace-only line.
      if (namedGroupsBlock !== "") {
        out.push(substituteBlockLine(line, namedGroupsBlock));
      }
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
 * @param options per-org inputs; `namedDependabotGroups` defaults to
 *   {@link DEFAULT_NAMED_DEPENDABOT_GROUPS} when absent.
 */
export function renderDependabotYml(
  outerTemplate: string,
  blockTemplate: string,
  ctx: RepoContext,
  options: OrgRenderOptions = {},
): string {
  const namedGroupsBlock = renderNamedGroupsBlock(
    options.namedDependabotGroups ?? DEFAULT_NAMED_DEPENDABOT_GROUPS,
  );
  const blockBody = stripLeadingComments(blockTemplate);
  const renderedBlocks = DEPENDABOT_ECOSYSTEMS.map((eco) =>
    renderEcosystemBlock(blockBody, eco, ctx, namedGroupsBlock),
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
