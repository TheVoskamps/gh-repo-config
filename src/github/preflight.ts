/**
 * The converger App's permission preflight: check the App
 * installation's granted permissions against what the sweep needs,
 * before the sweep starts.
 *
 * App permissions are UI-gated, with no API to write them, so the sweep
 * cannot converge a missing one. Without this check a shortfall surfaces
 * as a per-repo `403` part-way through a sweep that has already opened
 * PRs and converged settings on other repos.
 *
 * Zero runtime dependencies: the App JWT is signed with `node:crypto`,
 * and the one API call goes through built-in `fetch`.
 *
 * REST surface used:
 * - `GET /app/installations/{installation_id}` — the installation's
 *   granted `permissions` map, authenticated with the App JWT.
 */
import { createPrivateKey, sign } from "node:crypto";

import {
  findMissingPermissions,
  type MissingPermission,
  type PermissionLevel,
} from "../converge/app-permissions.js";

/** One permission the sweep requires of the converger App. */
export interface ConvergerPermission {
  readonly level: PermissionLevel;
  /** The name the App settings page shows for it. */
  readonly name: string;
  /** The settings-page section it sits in. */
  readonly scope: "repository" | "organization";
}

/**
 * Every permission an endpoint called from `src/github/*.ts` requires,
 * at the highest level any of those endpoints requires it.
 */
export const CONVERGER_REQUIRED_PERMISSIONS: Readonly<
  Record<string, ConvergerPermission>
> = {
  // GET /repos/{o}/{r}, GET …/rules/branches/{b}, GET …/rulesets.
  metadata: { level: "read", name: "Metadata", scope: "repository" },
  // The git-data writes (blobs, trees, commits, refs) and PUT …/pulls/{n}/merge.
  contents: { level: "write", name: "Contents", scope: "repository" },
  // Creating or moving a ref onto a commit that touches .github/workflows/.
  workflows: { level: "write", name: "Workflows", scope: "repository" },
  // POST …/pulls, and the GraphQL draft / ready-for-review mutations.
  pull_requests: { level: "write", name: "Pull requests", scope: "repository" },
  // GET …/commits/{ref}/check-runs.
  checks: { level: "read", name: "Checks", scope: "repository" },
  // GET …/commits/{ref}/status.
  statuses: { level: "read", name: "Commit statuses", scope: "repository" },
  // PATCH /repos/{o}/{r}, the ruleset writes, vulnerability-alerts,
  // automated-security-fixes, and code-scanning default setup.
  administration: { level: "write", name: "Administration", scope: "repository" },
  // GET /orgs/{org}/installations.
  organization_administration: {
    level: "read",
    name: "Administration",
    scope: "organization",
  },
  // PATCH /orgs/{org}/properties/values.
  organization_custom_properties: {
    level: "write",
    name: "Custom properties",
    scope: "organization",
  },
};

const LEVEL_LABEL: Readonly<Record<string, string>> = {
  read: "Read-only",
  write: "Read and write",
  admin: "Admin",
};

const SCOPE_LABEL: Readonly<Record<ConvergerPermission["scope"], string>> = {
  repository: "Repository permissions",
  organization: "Organization permissions",
};

/** A level as the App settings page words it; `none` and an unknown level pass through. */
function levelLabel(level: string): string {
  return Object.hasOwn(LEVEL_LABEL, level) ? LEVEL_LABEL[level] : level;
}

/**
 * The operator-facing failure for a converger App installation whose
 * grant falls short of {@link CONVERGER_REQUIRED_PERMISSIONS}, or
 * `undefined` when it falls short of nothing.
 *
 * @param granted the installation's `permissions` map.
 * @param org the org the App is installed on.
 * @param appSlug the converger App's slug.
 */
export function checkConvergerPermissions(
  granted: Readonly<Record<string, string>>,
  org: string,
  appSlug: string,
): string | undefined {
  const required = Object.fromEntries(
    Object.entries(CONVERGER_REQUIRED_PERMISSIONS).map(([key, p]) => [key, p.level]),
  );
  const missing = findMissingPermissions(granted, required);
  if (missing.length === 0) {
    return undefined;
  }
  return describeShortfall(missing, org, appSlug);
}

function describeShortfall(
  missing: readonly MissingPermission[],
  org: string,
  appSlug: string,
): string {
  const lines = missing.map(({ permission, required, granted }) => {
    const { name, scope } = CONVERGER_REQUIRED_PERMISSIONS[permission];
    const needs = levelLabel(required);
    return `  ${SCOPE_LABEL[scope]} > ${name}: ${needs} (needs ${needs}, granted ${levelLabel(granted)})`;
  });
  return [
    `The converger App ${appSlug} lacks permissions the sweep needs on ${org}:`,
    ...lines,
    `Grant them at https://github.com/organizations/${org}/settings/apps/${appSlug}/permissions`,
    "After saving, an org owner must accept the updated permissions on the App's installation; " +
      "until then the minted token keeps the old grant and this check keeps failing.",
  ].join("\n");
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * An RS256 App JWT: `iss` is the App's Client ID, `iat` is backdated
 * 60 s against clock drift, and `exp` is 9 min out, inside GitHub's
 * 10-min ceiling.
 *
 * @param nowSeconds the current Unix time, injectable for tests.
 */
export function signAppJwt(
  clientId: string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: clientId }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), createPrivateKey(privateKeyPem));
  return `${signingInput}.${base64url(signature)}`;
}

/** What {@link readInstallationPermissions} needs. */
export interface InstallationReadOptions {
  readonly installationId: string;
  readonly clientId: string;
  readonly privateKey: string;
  /** Override the API base (for tests). Defaults to public GitHub. */
  readonly apiBase?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * `GET /app/installations/{installation_id}` under an App JWT, returning
 * the installation's `permissions` map. Throws on a non-2xx with the
 * status and GitHub's message.
 */
export async function readInstallationPermissions(
  options: InstallationReadOptions,
): Promise<Readonly<Record<string, string>>> {
  const apiBase = options.apiBase ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;
  const url = `${apiBase}/app/installations/${options.installationId}`;
  const res = await doFetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${signAppJwt(options.clientId, options.privateKey)}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    let message = "";
    try {
      message = ((await res.json()) as { message?: string }).message ?? "";
    } catch {
      // A body that is not JSON leaves the status line to speak for itself.
    }
    throw new Error(
      `Failed to read installation ${options.installationId}: ${res.status} ${res.statusText}` +
        (message ? ` — ${message}` : ""),
    );
  }
  const body = (await res.json()) as { permissions?: Readonly<Record<string, string>> };
  return body.permissions ?? {};
}

/**
 * Run the converger App preflight from environment-provided config. This
 * is the entry point the `preflight` CLI subcommand calls.
 *
 * Returns the shortfall message, or `undefined` when the grant covers
 * every required permission. Throws on missing config or a failed read.
 *
 * Required env:
 * - `GH_REPO_CONFIG_ORG` — the org the App is installed on.
 * - `GH_REPO_CONFIG_APP_SLUG` — the converger App's slug.
 * - `GH_REPO_CONFIG_INSTALLATION_ID` — the App's installation id on the org.
 * - `GH_REPO_CONFIG_APP_CLIENT_ID` — the App's Client ID, the JWT's `iss`.
 * - `GH_REPO_CONFIG_APP_PRIVATE_KEY` — the App's PEM private key.
 *
 * Optional env:
 * - `GITHUB_API_URL` — API base (GitHub Actions sets this).
 */
export async function runPreflightFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  doFetch?: typeof fetch,
): Promise<string | undefined> {
  const required = [
    "GH_REPO_CONFIG_ORG",
    "GH_REPO_CONFIG_APP_SLUG",
    "GH_REPO_CONFIG_INSTALLATION_ID",
    "GH_REPO_CONFIG_APP_CLIENT_ID",
    "GH_REPO_CONFIG_APP_PRIVATE_KEY",
  ] as const;
  for (const name of required) {
    if (!env[name]) {
      throw new Error(`${name} is required`);
    }
  }
  const org = env.GH_REPO_CONFIG_ORG!;
  const appSlug = env.GH_REPO_CONFIG_APP_SLUG!;
  const apiBase = env.GITHUB_API_URL;
  const granted = await readInstallationPermissions({
    installationId: env.GH_REPO_CONFIG_INSTALLATION_ID!,
    clientId: env.GH_REPO_CONFIG_APP_CLIENT_ID!,
    privateKey: env.GH_REPO_CONFIG_APP_PRIVATE_KEY!,
    ...(apiBase ? { apiBase } : {}),
    ...(doFetch ? { fetch: doFetch } : {}),
  });
  return checkConvergerPermissions(granted, org, appSlug);
}
