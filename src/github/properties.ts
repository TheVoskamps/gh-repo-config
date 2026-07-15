/**
 * A thin GitHub REST client for the three org custom properties the
 * sweep's control plane reads and writes (issue #13, slice 2).
 *
 * Zero runtime dependencies: it uses the built-in `fetch` (Node >=22) so
 * the release asset stays dependency-free. Authentication is by a bearer
 * token — an *installation* access token minted from the converger org
 * App in CI, or a user token when driven interactively. The client does
 * not mint tokens itself; the caller supplies one (the workflow mints it
 * via `actions/create-github-app-token` and passes it through the
 * environment).
 *
 * Custom-property REST shape (verified in the design doc):
 * - Read all repos' values (paginated): `GET /orgs/{org}/properties/values`.
 * - Read a property's schema (for its org-level default value):
 *   `GET /orgs/{org}/properties/schema/{name}`.
 * - Write values in batches of up to 30 repos:
 *   `PATCH /orgs/{org}/properties/values`.
 */

/** Names of the three selection/stamp custom properties, in one place. */
export const PROPERTY_NAMES = {
  /** Per-repo `process`/`ignore`/unset override. */
  mode: "gh-repo-config-mode",
  /** Org-level default applied to repos with no `mode` set. */
  orgDefault: "gh-repo-config-default",
  /** Per-repo applied-release stamp. */
  version: "gh-repo-config-version",
} as const;

/** GitHub's batch-write cap for `PATCH /orgs/{org}/properties/values`. */
export const MAX_REPOS_PER_BATCH = 30;

/** The selection/stamp property values resolved for one repo. */
export interface RepoPropertyValues {
  /** Repo name (without owner), as returned by the values endpoint. */
  readonly repo: string;
  /** `gh-repo-config-mode`, or `undefined` when unset. */
  readonly mode: string | undefined;
  /** `gh-repo-config-version`, or `undefined` when unset. */
  readonly version: string | undefined;
}

interface RawPropertyValue {
  readonly property_name: string;
  readonly value: string | string[] | null;
}

interface RawRepoValues {
  readonly repository_name: string;
  readonly properties: readonly RawPropertyValue[];
}

/** Config for {@link OrgPropertiesClient}. */
export interface OrgPropertiesClientOptions {
  /** The org login (e.g. `TheVoskamps`). */
  readonly org: string;
  /** A bearer token with `organization_custom_properties` access. */
  readonly token: string;
  /** Override the API base (for tests). Defaults to public GitHub. */
  readonly apiBase?: string;
  /** Injectable fetch (for tests). Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * Reads and writes the org custom properties that drive the sweep.
 *
 * The read path collapses the API's per-property array into the two
 * per-repo values the control plane cares about (`mode`, `version`); the
 * org-level default is read separately from the property schema.
 */
export class OrgPropertiesClient {
  private readonly org: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly doFetch: typeof fetch;

  constructor(options: OrgPropertiesClientOptions) {
    this.org = options.org;
    this.token = options.token;
    this.apiBase = options.apiBase ?? "https://api.github.com";
    this.doFetch = options.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "x-github-api-version": "2022-11-28",
    };
  }

  /**
   * Read the org-level default value of `gh-repo-config-default` from its
   * property schema. Returns `undefined` when the property is not defined
   * or has no default (the caller normalizes that to the fail-safe
   * `opt-in`).
   */
  async readOrgDefault(): Promise<string | undefined> {
    const url = `${this.apiBase}/orgs/${this.org}/properties/schema/${PROPERTY_NAMES.orgDefault}`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(
        `Failed to read ${PROPERTY_NAMES.orgDefault} schema: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { default_value?: string | null };
    return body.default_value ?? undefined;
  }

  /**
   * Read every repo's `mode` and `version` values in one paginated sweep
   * of `GET /orgs/{org}/properties/values`. Repos with neither property
   * set still appear (the values endpoint lists all repos), so the sweep
   * sees brand-new/unstamped repos too.
   */
  async readAllRepoValues(): Promise<RepoPropertyValues[]> {
    const perPage = 100;
    const results: RepoPropertyValues[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.apiBase}/orgs/${this.org}/properties/values?per_page=${perPage}&page=${page}`;
      const res = await this.doFetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error(
          `Failed to read org property values (page ${page}): ${res.status} ${res.statusText}`,
        );
      }
      const batch = (await res.json()) as RawRepoValues[];
      for (const repo of batch) {
        results.push(this.projectRepoValues(repo));
      }
      if (batch.length < perPage) {
        break;
      }
    }
    return results;
  }

  private projectRepoValues(raw: RawRepoValues): RepoPropertyValues {
    const find = (name: string): string | undefined => {
      const entry = raw.properties.find((p) => p.property_name === name);
      const value = entry?.value;
      // The values endpoint uses `null` for an unset property, and the
      // selection properties are single-select strings — never arrays —
      // so any array shape is treated as unset defensively.
      return typeof value === "string" ? value : undefined;
    };
    return {
      repo: raw.repository_name,
      mode: find(PROPERTY_NAMES.mode),
      version: find(PROPERTY_NAMES.version),
    };
  }

  /**
   * Stamp a set of repos with a `gh-repo-config-version` value, batching
   * at GitHub's 30-repos-per-call limit for
   * `PATCH /orgs/{org}/properties/values`.
   *
   * @param repoNames repo names (without owner) to stamp.
   * @param version   the value to write to `gh-repo-config-version`.
   */
  async stampVersion(
    repoNames: readonly string[],
    version: string,
  ): Promise<void> {
    for (let i = 0; i < repoNames.length; i += MAX_REPOS_PER_BATCH) {
      const chunk = repoNames.slice(i, i + MAX_REPOS_PER_BATCH);
      const url = `${this.apiBase}/orgs/${this.org}/properties/values`;
      const res = await this.doFetch(url, {
        method: "PATCH",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({
          repository_names: chunk,
          properties: [
            { property_name: PROPERTY_NAMES.version, value: version },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Failed to stamp ${chunk.length} repo(s) with ${PROPERTY_NAMES.version}=${version}: ${res.status} ${res.statusText}`,
        );
      }
    }
  }
}
