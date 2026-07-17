/**
 * Locate and read the template payloads shipped in `assets/` (issue
 * #14).
 *
 * The converger runs from an **unpacked GitHub Release** tarball, which
 * packs `dist`, `bin`, `package.json`, and `assets` at the same top
 * level (see `.github/workflows/release.yml`). This module resolves the
 * `assets/` directory **relative to the built module** (`import.meta.url`)
 * rather than `process.cwd()`, so the templates are found regardless of
 * where the sweep process was launched from. `dist/` mirrors `src/`, so
 * this compiled module lives at `dist/converge/assets.js` and reaches
 * the sibling `assets/` via `../../assets`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Absolute path to the `assets/` directory that ships alongside the
 * built module. Resolved from `import.meta.url` (this file's own URL),
 * not `process.cwd()`, so it is correct in an unpacked release.
 */
export const ASSETS_DIR: string = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
);

/** Read a named asset file as UTF-8 text. */
export function readAssetText(name: string): string {
  return readFileSync(join(ASSETS_DIR, name), "utf8");
}
