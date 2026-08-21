/**
 * A thin GitHub REST client for the org custom properties the sweep's
 * control plane reads and writes (issue #13, slice 2).
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

/** Names of the selection/stamp custom properties, in one place. */
export const PROPERTY_NAMES = {
  /**
   * Selection, at both levels: a repo's own `opt-in`/`opt-out`/unset
   * value, and — in this same property's schema — the `default_value` an
   * unset repo falls back to.
   */
  mode: "gh-repo-config-mode",
  /** Per-repo applied-release stamp. */
  version: "gh-repo-config-version",
} as const;

/** GitHub's batch-write cap for `PATCH /orgs/{org}/properties/values`. */
export const MAX_REPOS_PER_BATCH = 30;

/**
 * Thrown by {@link OrgPropertiesClient.stampVersion} when a batch write
 * fails partway through a multi-batch stamp. `stamped` carries the repo
 * names from the batches that *did* succeed before the failing one, so
 * the caller can report accurate partial progress instead of losing
 * track of which repos were actually written.
 */
export class PartialStampError extends Error {
  /** Repo names successfully stamped before the failing batch. */
  readonly stamped: readonly string[];
  /** Repo names in the batch that failed (not stamped). */
  readonly failedBatch: readonly string[];
  /** Repo names never attempted because an earlier batch failed first. */
  readonly notAttempted: readonly string[];

  constructor(
    message: string,
    stamped: readonly string[],
    failedBatch: readonly string[],
    notAttempted: readonly string[],
  ) {
    super(message);
    this.name = "PartialStampError";
    this.stamped = stamped;
    this.failedBatch = failedBatch;
    this.notAttempted = notAttempted;
  }
}

/** The selection/stamp property values resolved for one repo. */
export interface RepoPropertyValues {
  /** Repo name (without owner), as returned by the values endpoint. */
  readonly repo: string;
  /** `gh-repo-config-mode`, or `undefined` when unset. */
  readonly mode: string | undefined;
  /** `gh-repo-config-version`, or `undefined` when unset. */
  readonly version: string | undefined;
}

/**
 * Where the `gh-repo-config-mode` schema's `default_value` came from, as
 * distinct from the value the sweep resolves it to.
 *
 * `normalizeDefaultMode` collapses a missing, empty, or unrecognized
 * value to the fail-safe `opt-out`, so a genuine `opt-out` default and an
 * org whose control plane was never provisioned resolve identically. That
 * collapse is deliberate for *selection*, but it once masked a real
 * outage: the selection custom properties had never been created on the
 * org, and every scheduled sweep reported "all repos unmanaged" —
 * indistinguishable from a correctly-configured org with nobody opted in.
 * Provenance is what the sweep reports so an operator can tell the two
 * apart.
 *
 * Both `defined-no-value` and `not-defined` are anomalous under the
 * required-with-default provisioning contract (issue #68): GitHub accepts
 * a schema `default_value` only on a `required: true` property, so a
 * property carrying no default was not provisioned as the contract
 * requires.
 */
export type DefaultModeProvenance = "set" | "defined-no-value" | "not-defined";

/**
 * The result of reading the `gh-repo-config-mode` property schema: the
 * provenance, plus the raw (unvalidated) `default_value` when there is
 * one.
 *
 * `raw` is deliberately not normalized here. An unrecognized value such
 * as `"optin"` still lands in the `set` arm and still normalizes to
 * `opt-out`, but the sweep's log carries the raw string, so a typo'd
 * default is visible rather than reading as a clean `opt-out`.
 */
export type DefaultModeRead =
  | { readonly provenance: "set"; readonly raw: string }
  | { readonly provenance: "defined-no-value" }
  | { readonly provenance: "not-defined" };

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
 * fallback default is read separately from the `mode` property's schema.
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
   * Read the `gh-repo-config-mode` schema's `default_value` — the value
   * every repo with no value of its own falls back to — reporting
   * {@link DefaultModeProvenance} alongside the raw value rather than
   * collapsing both no-value cases to `undefined`.
   *
   * The read-through is applied in the sweep's own code rather than
   * assumed of the API: whether GitHub materializes the schema default
   * into each repo's own value read is irrelevant, since a repo whose
   * read returns the default resolves to the same verdict either way.
   *
   * Callers normalize `set`'s `raw` and nothing else through
   * `normalizeDefaultMode`, so selection behaviour is identical across
   * all three provenances; the two no-value provenances additionally fail
   * the run loudly (see `describeDefaultModeProvenanceFailure`).
   */
  async readDefaultMode(): Promise<DefaultModeRead> {
    const url = `${this.apiBase}/orgs/${this.org}/properties/schema/${PROPERTY_NAMES.mode}`;
    const res = await this.doFetch(url, { headers: this.headers() });
    if (res.status === 404) {
      return { provenance: "not-defined" };
    }
    if (!res.ok) {
      throw new Error(
        `Failed to read ${PROPERTY_NAMES.mode} schema: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { default_value?: string | null };
    const raw = body.default_value;
    return typeof raw === "string"
      ? { provenance: "set", raw }
      : { provenance: "defined-no-value" };
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
   * A mid-batch failure does not lose track of the batches that already
   * succeeded: if any batch's `PATCH` fails, this throws a
   * {@link PartialStampError} carrying the repo names already stamped by
   * prior batches, the names in the failing batch, and the names never
   * attempted — rather than a plain `Error` that discards which repos
   * were actually written.
   *
   * @param repoNames repo names (without owner) to stamp.
   * @param version   the value to write to `gh-repo-config-version`.
   */
  async stampVersion(
    repoNames: readonly string[],
    version: string,
  ): Promise<void> {
    const stamped: string[] = [];
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
        const notAttempted = repoNames.slice(i + chunk.length);
        throw new PartialStampError(
          `Failed to stamp ${chunk.length} repo(s) with ${PROPERTY_NAMES.version}=${version}: ${res.status} ${res.statusText}`,
          stamped,
          chunk,
          notAttempted,
        );
      }
      stamped.push(...chunk);
    }
  }
}
