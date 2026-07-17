/**
 * The per-repo file-convergence write path (issue #14): compare the
 * desired files against the target repo's current state, and — only when
 * something differs — commit the changed files onto a fixed work branch
 * via the git-data API and open (or update) a single PR to the default
 * branch.
 *
 * Invariants enforced here (from the issue):
 *
 * - **Never push to the default branch.** All writes land on the fixed
 *   {@link CONVERGE_BRANCH}; changes reach the default branch only by
 *   merging the PR (which is issue #24's job, not this one's).
 * - **One branch + PR per repo per sweep run**, shared by all
 *   file-rendering concerns. A prior run's still-open branch is *reset*
 *   onto the current default-branch head with the newly rendered files
 *   (force-update the ref) rather than opening a second PR.
 * - **Whole-file compare.** A file differs when its content differs OR
 *   (for a script) its content matches but its mode is not `100755`.
 * - **No diff → no branch, no PR.** An already-converged repo is a
 *   complete no-op.
 */
import { buildDesiredFiles, type DesiredFile } from "./files.js";
import type { RepoContext } from "./render.js";
import {
  ContentsClient,
  FILE_MODE,
  type ExistingBlob,
  type PullRequestResult,
} from "../github/contents.js";

/** The fixed work-branch name the converger owns on every target repo. */
export const CONVERGE_BRANCH = "gh-repo-config/converge";

/** Outcome of converging one repo's files. */
export interface ConvergeResult {
  /** Files that differed from the target and were written (may be empty). */
  readonly changed: readonly string[];
  /**
   * The PR that carries the changes, or `undefined` when nothing
   * differed (no branch, no PR) or under `dryRun`.
   */
  readonly pullRequest?: PullRequestResult;
  /** `true` when nothing differed — a complete no-op. */
  readonly noop: boolean;
}

/**
 * Decide whether a desired file differs from the target's current state.
 *
 * A file differs when it is absent, its content differs, or — for an
 * executable script — its content matches but the target's mode is not
 * `100755` (a right-content-wrong-mode file counts as differing, so a
 * script committed non-executable by some other path is corrected).
 */
function fileDiffers(
  desired: DesiredFile,
  existing: ExistingBlob | undefined,
  existingContent: string | undefined,
): boolean {
  if (!existing || existingContent === undefined) {
    return true;
  }
  if (existingContent !== desired.content) {
    return true;
  }
  if (desired.executable && existing.mode !== FILE_MODE.executable) {
    return true;
  }
  return false;
}

/**
 * Converge one repo's files. Reads the target's default branch and
 * current tree, compares against the desired file set, and (when
 * anything differs and not `dryRun`) commits the changed files onto
 * {@link CONVERGE_BRANCH} and opens/updates the PR.
 *
 * The commit's base is always the **current default-branch head**, so a
 * stale prior-run branch is reset onto the latest default head rather
 * than stacked on an outdated base — the "update the existing branch"
 * path the issue calls for.
 *
 * @param client the git-data/PR client (already authenticated).
 * @param owner the target repo's owner (org/user).
 * @param repo the target repo's name (without owner).
 * @param dryRun when `true`, decide and report diffs without writing.
 */
export async function convergeRepoFiles(
  client: ContentsClient,
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<ConvergeResult> {
  const defaultBranch = await client.getDefaultBranch(owner, repo);
  const ctx: RepoContext = { org: owner, repo, defaultBranch };
  const desired = buildDesiredFiles(ctx);

  const baseSha = await client.getBranchHeadSha(owner, repo, defaultBranch);
  const existingTree = await client.readTree(owner, repo, baseSha);

  // Determine which desired files differ. Read the existing blob content
  // only for paths that exist (so a large tree with no matching paths
  // costs no blob reads).
  const changed: DesiredFile[] = [];
  for (const file of desired) {
    const existing = existingTree.get(file.path);
    const existingContent = existing
      ? await client.readBlob(owner, repo, existing.sha)
      : undefined;
    if (fileDiffers(file, existing, existingContent)) {
      changed.push(file);
    }
  }

  if (changed.length === 0) {
    return { changed: [], noop: true };
  }

  const changedPaths = changed.map((f) => f.path);
  if (dryRun) {
    return { changed: changedPaths, noop: false };
  }

  // Create a blob per changed file, then one tree overlaying them on the
  // default-branch head's tree, then a commit, then point the work
  // branch at it. The git-data flow lets each tree entry carry an
  // explicit mode, so scripts land 100755.
  const entries: { path: string; mode: string; sha: string }[] = [];
  for (const file of changed) {
    const sha = await client.createBlob(owner, repo, file.content);
    entries.push({
      path: file.path,
      mode: file.executable ? FILE_MODE.executable : FILE_MODE.regular,
      sha,
    });
  }
  const treeSha = await client.createTree(owner, repo, baseSha, entries);
  const commitSha = await client.createCommit(
    owner,
    repo,
    commitMessage(changedPaths),
    treeSha,
    baseSha,
  );

  // Reset the fixed work branch onto the new commit (force-update when a
  // prior-run branch is still around), then open the PR unless one is
  // already open for that branch (in which case the branch update above
  // already carries the new files into the existing PR).
  const existingPr = await client.findOpenPullRequest(
    owner,
    repo,
    CONVERGE_BRANCH,
  );
  await client.setBranchRef(
    owner,
    repo,
    CONVERGE_BRANCH,
    commitSha,
    existingPr !== undefined,
  );

  if (existingPr) {
    return {
      changed: changedPaths,
      pullRequest: { ...existingPr, updated: true },
      noop: false,
    };
  }

  const created = await client.createPullRequest(
    owner,
    repo,
    CONVERGE_BRANCH,
    defaultBranch,
    "Converge repo configuration",
    pullRequestBody(changedPaths),
  );
  return {
    changed: changedPaths,
    pullRequest: { ...created, updated: false },
    noop: false,
  };
}

/** The commit message for a converge commit, listing the changed paths. */
function commitMessage(paths: readonly string[]): string {
  return (
    "Converge repo configuration\n\n" +
    paths.map((p) => `- ${p}`).join("\n") +
    "\n"
  );
}

/** The PR body for a converge PR, listing the changed paths. */
function pullRequestBody(paths: readonly string[]): string {
  return (
    "Automated repo-configuration convergence by the gh-repo-config sweep.\n\n" +
    "Changed files:\n\n" +
    paths.map((p) => `- \`${p}\``).join("\n") +
    "\n"
  );
}
