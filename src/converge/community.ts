/**
 * The community-file seed source (issue #90): the target org's own
 * `.github` repository.
 *
 * The community/governance files the converger seeds (`CONTRIBUTORS`,
 * `LICENSE`, `PATENTS`, `PRIOR_ART.md` — see `files.ts`'s
 * `COMMUNITY_FILES`) are org-specific content: another org's license
 * and contributor policy are its own, and a private org's content
 * should not have to live in this public repo. So instead of shipping
 * static copies from `assets/`, the sweep looks each file up at the root
 * of the org's `.github` repo — the repo GitHub itself treats as the
 * org-wide default for community health files — and seeds whatever it
 * finds there.
 *
 * This is a **deliberate, narrow exception** to the converger's
 * no-external-source-of-truth contract, confined to community files.
 * Workflows, scripts, gates, and the ruleset stay canonical in
 * `assets/`.
 *
 * Absence composes with the seed-if-absent semantics in `writer.ts`: a
 * file missing from the org's `.github` repo — or an org with no
 * `.github` repo at all — is simply "nothing to seed", not an error.
 * The converger App's org-wide installation already grants the read.
 */
import { COMMUNITY_FILE_PATHS, type CommunityFileContent } from "./files.js";
import type { ContentsClient } from "../github/contents.js";

/** The org repo the community-file seed content is read from. */
export const COMMUNITY_SOURCE_REPO = ".github";

/**
 * Read the org's community-file seed content: one lookup per
 * {@link COMMUNITY_FILE_PATHS} entry at the root of the org's
 * {@link COMMUNITY_SOURCE_REPO} repo. Files present there are returned
 * by path; files absent — including every file when the org has no
 * `.github` repo — are left out. Never throws for absence; a non-404
 * read failure (auth, rate limit) propagates, since a converge that
 * silently seeded nothing because a read broke would be wrong.
 *
 * The result is per-org, not per-repo: `runSweepFromEnv` reads it once
 * and passes it to every repo's converge, rather than re-reading per
 * repo.
 */
export async function readOrgCommunityFiles(
  client: ContentsClient,
  org: string,
): Promise<CommunityFileContent> {
  const found: Record<string, string> = {};
  for (const path of COMMUNITY_FILE_PATHS) {
    const content = await client.readFileIfPresent(
      org,
      COMMUNITY_SOURCE_REPO,
      path,
    );
    if (content !== undefined) {
      found[path] = content;
    }
  }
  return found;
}
