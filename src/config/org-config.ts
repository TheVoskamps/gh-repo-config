/**
 * The per-org config file (issue #91): the seam that lets one released
 * converger tarball serve every managed org without forking.
 *
 * Each org runs the sweep from its own private sweeper repo, which
 * carries this file as org-owned content the converger never converges.
 * The sweep reads its path from `GH_REPO_CONFIG_FILE` and feeds the
 * parsed values into the pipeline seams that already exist
 * (`OrgRenderOptions.namedDependabotGroups`,
 * `OrgRenderOptions.prAutomationIdentity`).
 *
 * The format is JSON, not YAML, because the release tarball is
 * dependency-free and runs under bare `node bin/gh-repo-config.js
 * sweep`: no YAML parser exists at runtime and none is added. The
 * sweeper workflow — later work, no payload exists yet — must also read
 * the version pin out of this same file in bash before the tarball
 * exists, and `jq` is on every runner where YAML tooling is not.
 *
 * Every validation failure is a thrown `Error` naming the offending key
 * and what was expected. The sweep runs this parse before its first API
 * call, so a malformed pin or policy fails the tick outright rather than
 * being silently ignored — a silently-ignored pin is worse than a failed
 * tick.
 *
 * Editing this file does not on its own re-converge a repo the sweep
 * already stamped at `CURRENT_VERSION`: the version skip reads only the
 * `gh-repo-config-version` stamp, which no config-file change moves.
 * Delivering a new group or a new identity to already-current repos
 * needs the converger's own `version` bumped, or those repos'
 * `gh-repo-config-version` cleared. It is the same hazard an un-bumped
 * `assets/` change carries.
 */
import { readFile } from "node:fs/promises";
import type {
  NamedDependabotGroups,
  PrAutomationIdentity,
} from "../converge/render.js";

/**
 * The `sweeper-update-policy` values. Controls how the sweeper repo
 * handles its own converger-version updates; the policy's consumer is
 * the sweeper-workflow payload, which is later work — this module only
 * parses, validates, and exposes it.
 */
export const SWEEPER_UPDATE_POLICIES = ["manual", "auto", "off"] as const;

/** One of {@link SWEEPER_UPDATE_POLICIES}. */
export type SweeperUpdatePolicy = (typeof SWEEPER_UPDATE_POLICIES)[number];

/**
 * The `sweeper-update-policy` applied when the key is absent. `manual`
 * is the conservative middle: the sweeper is told about an update but
 * does not take it on its own.
 */
export const DEFAULT_SWEEPER_UPDATE_POLICY: SweeperUpdatePolicy = "manual";

/**
 * The resolved per-org configuration. Every render input is optional —
 * absent means the baked default applies, exactly as a sweep with no
 * config file behaves — while `sweeperUpdatePolicy` always carries a
 * value because its default is applied here rather than at its (still
 * unwritten) consumer.
 */
export interface OrgConfig {
  /**
   * A **full replacement** of `DEFAULT_NAMED_DEPENDABOT_GROUPS`, never a
   * merge: an org that sets `named-dependabot-groups` gets exactly that
   * map, and `{}` renders no named groups at all.
   */
  readonly namedDependabotGroups?: NamedDependabotGroups;
  /**
   * The org's own PR-automation App. Every sub-key is required together
   * with the rest — mixing one org's App with another's secret names is
   * a footgun, not a default.
   */
  readonly prAutomationIdentity?: PrAutomationIdentity;
  /**
   * A converger release tag of the form `vX.Y.Z`, leading `v` included.
   * Absent means latest. Its intended primary consumer is the sweeper
   * workflow, which downloads the pinned tarball (later work); the
   * converger enforces it as defense-in-depth via
   * {@link assertVersionPinSatisfied}, which is the only enforcement
   * that exists today.
   */
  readonly versionPin?: string;
  readonly sweeperUpdatePolicy: SweeperUpdatePolicy;
}

/** The config a sweep runs with when `GH_REPO_CONFIG_FILE` is unset. */
export const DEFAULT_ORG_CONFIG: OrgConfig = {
  sweeperUpdatePolicy: DEFAULT_SWEEPER_UPDATE_POLICY,
};

/**
 * Where an unknown-key warning goes. The parse calls this the moment it
 * finds the key, rather than returning the warnings at the end, because
 * a validation failure elsewhere in the same file throws before any
 * return value exists — an unknown key alongside, say, a partial
 * `pr-automation-identity` would otherwise be reported nowhere.
 */
export type OrgConfigWarningSink = (warning: string) => void;

/** The sink a caller gets when it names none: one line per warning on stderr. */
const warnOnStderr: OrgConfigWarningSink = (warning) => {
  console.error(warning);
};

/** Top-level keys this converger version understands. */
const KNOWN_KEYS = [
  "named-dependabot-groups",
  "pr-automation-identity",
  "version-pin",
  "sweeper-update-policy",
] as const;

/**
 * `pr-automation-identity`'s sub-keys. All of them are required
 * whenever the object is present.
 */
const IDENTITY_KEYS = [
  "app-name",
  "app-id-secret",
  "app-private-key-secret",
  "bot-slug",
] as const;

/** A release tag: `v` then a bare `MAJOR.MINOR.PATCH` core. */
const VERSION_PIN_PATTERN = /^v\d+\.\d+\.\d+$/;

/** `owner/repo`: exactly one slash, non-empty halves, no whitespace. */
const SWEEPER_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNamedGroups(raw: unknown): NamedDependabotGroups {
  if (!isPlainObject(raw)) {
    throw new Error(
      'org config "named-dependabot-groups": must be an object mapping group name to a pattern array',
    );
  }
  const groups: Record<string, string[]> = {};
  for (const [name, patterns] of Object.entries(raw)) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(
        `org config "named-dependabot-groups.${name}": must be a non-empty array of patterns`,
      );
    }
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error(
          `org config "named-dependabot-groups.${name}": every pattern must be a non-empty string`,
        );
      }
    }
    groups[name] = [...(patterns as string[])];
  }
  return groups;
}

/**
 * Report every key this converger version does not understand, at the
 * top level and inside `pr-automation-identity`.
 *
 * This runs as its own pass before any value is validated, so an
 * unknown key is reported even when another key's malformed value then
 * fails the whole parse.
 */
function warnUnknownKeys(
  parsed: Record<string, unknown>,
  onWarning: OrgConfigWarningSink,
): void {
  for (const key of Object.keys(parsed)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      onWarning(`org config: unknown key "${key}" (ignored)`);
    }
  }
  const identity = parsed["pr-automation-identity"];
  if (!isPlainObject(identity)) {
    return;
  }
  for (const key of Object.keys(identity)) {
    if (!(IDENTITY_KEYS as readonly string[]).includes(key)) {
      onWarning(
        `org config: unknown key "pr-automation-identity.${key}" (ignored)`,
      );
    }
  }
}

function parseIdentity(raw: unknown): PrAutomationIdentity {
  if (!isPlainObject(raw)) {
    throw new Error(
      'org config "pr-automation-identity": must be an object carrying app-name, app-id-secret, app-private-key-secret, and bot-slug',
    );
  }
  return {
    appName: requireIdentityString(raw, "app-name"),
    appIdSecret: requireIdentityString(raw, "app-id-secret"),
    appPrivateKeySecret: requireIdentityString(raw, "app-private-key-secret"),
    botSlug: requireIdentityString(raw, "bot-slug"),
  };
}

function requireIdentityString(
  raw: Record<string, unknown>,
  key: string,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `org config "pr-automation-identity.${key}": required, must be a non-empty string`,
    );
  }
  return value;
}

function parseVersionPin(raw: unknown): string {
  if (typeof raw !== "string" || !VERSION_PIN_PATTERN.test(raw)) {
    throw new Error(
      `org config "version-pin": must be a release tag of the form vX.Y.Z, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function parsePolicy(raw: unknown): SweeperUpdatePolicy {
  if (
    typeof raw !== "string" ||
    !(SWEEPER_UPDATE_POLICIES as readonly string[]).includes(raw)
  ) {
    throw new Error(
      `org config "sweeper-update-policy": must be one of ${SWEEPER_UPDATE_POLICIES.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw as SweeperUpdatePolicy;
}

/**
 * Parse and validate an org config file's text.
 *
 * @param text the file's contents, expected to be a JSON object.
 * @param onWarning where each unknown key's warning goes; defaults to
 *   stderr, so a caller that names no sink still cannot lose one.
 * @returns the resolved config.
 * @throws Error naming the offending key when any value has the wrong
 *   shape, or when the text is not a JSON object.
 */
export function parseOrgConfig(
  text: string,
  onWarning: OrgConfigWarningSink = warnOnStderr,
): OrgConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `org config: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error("org config: the top level must be a JSON object");
  }

  warnUnknownKeys(parsed, onWarning);

  const config: OrgConfig = {
    ...("named-dependabot-groups" in parsed
      ? { namedDependabotGroups: parseNamedGroups(parsed["named-dependabot-groups"]) }
      : {}),
    ...("pr-automation-identity" in parsed
      ? { prAutomationIdentity: parseIdentity(parsed["pr-automation-identity"]) }
      : {}),
    ...("version-pin" in parsed
      ? { versionPin: parseVersionPin(parsed["version-pin"]) }
      : {}),
    sweeperUpdatePolicy:
      "sweeper-update-policy" in parsed
        ? parsePolicy(parsed["sweeper-update-policy"])
        : DEFAULT_SWEEPER_UPDATE_POLICY,
  };
  return config;
}

/**
 * Read an org config file and parse it. A missing or unreadable file is
 * a hard error: the path was stated explicitly by the invoker, so its
 * absence is a misconfiguration rather than "no config".
 *
 * @param path the file path `GH_REPO_CONFIG_FILE` named.
 * @param onWarning where each unknown key's warning goes; defaults to
 *   stderr, as in {@link parseOrgConfig}.
 */
export async function readOrgConfig(
  path: string,
  onWarning: OrgConfigWarningSink = warnOnStderr,
): Promise<OrgConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `org config file ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseOrgConfig(text, onWarning);
}

/**
 * Enforce a `version-pin` against the running converger's own version.
 *
 * The pin's intended primary consumer is the sweeper workflow, which
 * downloads the pinned tarball (later work). This check is
 * defense-in-depth: a workflow that failed to honor the pin cannot then
 * run the wrong converger version against the org's repos.
 *
 * @param pin the configured pin (`vX.Y.Z`), or `undefined` for no pin.
 * @param currentVersion the running converger's version, bare (no `v`).
 * @throws Error naming both values when they disagree.
 */
export function assertVersionPinSatisfied(
  pin: string | undefined,
  currentVersion: string,
): void {
  if (pin === undefined) {
    return;
  }
  const pinned = pin.slice(1);
  if (pinned !== currentVersion) {
    throw new Error(
      `org config "version-pin" is ${pin} but this converger is ${currentVersion}`,
    );
  }
}

/**
 * Validate the sweeper repo the invoking workflow named in
 * `GH_REPO_CONFIG_SWEEPER_REPO`.
 *
 * The sweeper repo's identity reaches the sweep via environment rather
 * than the config file: the workflow passes its own
 * `$GITHUB_REPOSITORY`, so the converger learns which repo is the
 * sweeper without an org Actions variable (which would need a scope the
 * converger App does not hold) and the identity cannot drift.
 *
 * @param raw the env value. `undefined` or empty — the shape an unset
 *   Actions expression renders as — means no repo is the sweeper.
 * @throws Error when present but not `owner/repo`.
 */
export function parseSweeperRepo(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (!SWEEPER_REPO_PATTERN.test(raw)) {
    throw new Error(
      `GH_REPO_CONFIG_SWEEPER_REPO must be owner/repo, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}
