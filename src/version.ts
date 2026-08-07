/**
 * Slice 1 of the org-wide repo-configuration fan-out (issue #12).
 *
 * This module exposes the converger's own "current version" — the
 * value later slices (the selection loop, the stamp comparison) read
 * to decide whether a target repo's `gh-repo-config-version` custom
 * property is behind the release that should be applied.
 *
 * The version is read from this package's own `package.json`, the one
 * source of truth for both the npm package version and the value the
 * sweep stamps target repos with. It is bumped in every PR, not at
 * release time: `.github/workflows/sweep.yml` builds and runs the CLI
 * from `main`'s source tree rather than from a release tarball, so a
 * change that ships without a bump leaves every already-stamped repo
 * on the `skip-current` verdict and reaches nobody (CLAUDE.md >
 * Conventions). A `vX.Y.Z` tag is pushed separately and must match
 * whatever value `main` carries at that point
 * (`.github/workflows/release.yml`).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PackageJson {
  readonly name: string;
  readonly version: string;
}

const pkg = require("../package.json") as PackageJson;

/** The converger's own semantic version, as declared in package.json. */
export const CURRENT_VERSION: string = pkg.version;

/** The converger's package name, for use in stamp/property naming. */
export const PACKAGE_NAME: string = pkg.name;
