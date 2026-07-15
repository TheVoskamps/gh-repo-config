/**
 * Slice 1 of the org-wide repo-configuration fan-out (issue #12).
 *
 * This module exposes the converger's own "current version" — the
 * value later slices (the selection loop, the stamp comparison) read
 * to decide whether a target repo's `gh-repo-config-version` custom
 * property is behind the release that should be applied.
 *
 * The version is read from this package's own `package.json` so a
 * single edit (bumped alongside a git tag at release time) is the one
 * source of truth for both the npm package version and the value the
 * release workflow tags and stamps with.
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
