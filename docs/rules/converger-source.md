# Converger source

## Both locks on a sweeper-repo PR stay

A converger PR touching a path `sweeperHumanApprovalPaths` reserves is
held twice: `src/converge/writer.ts` puts it in draft state, which binds
every merge mechanism including GitHub-native auto-merge, and the merge
pass's `humanApprovalPaths` refuses it, which holds it while a human has
marked it ready without merging. Neither lock is removed as redundant
with the other.

## The sweeper hold policy has one definition

`sweeperHumanApprovalPaths` and `sweeperPolicyReleasesHold` in
`src/converge/files.ts` are the only statement of which paths are held
and when the hold is released. Every enforcement site calls them and
never carries its own copy of the rule, so no two sites can disagree
about what an absent `sweeper-update-policy` means.

## App permission levels have one comparison

`findMissingPermissions` in `src/converge/app-permissions.ts` is the
only comparison of a granted App permission level against a required
one, for the converger App preflight and the PR-automation preflight
alike. A new App permission check passes it its own required map and
words its own failure from the shortfall it returns, never ordering
levels itself, so no two checks can disagree about which grant
satisfies which requirement.

## The sweep merges its own PRs

The merge pass in `src/sweep.ts` merges green converger PRs, and is
never handed to the fanned-out PR-automation workflows. A newly managed
repo's first converger PR is the one that installs those workflows, so
they are not on its default branch yet, and `auto-rebase-prs.yml`'s
REST-merge pass runs, on its `workflow_run` and `schedule` triggers,
only the default branch's copy. The `protect-main` ruleset step waits
on that PR reaching the default branch.

## The two Apps stay separate

`PR_AUTOMATION_REQUIRED_PERMISSIONS` never gains a scope only the
converger holds — Administration, Organization administration, or
Organization custom properties — and the converger and PR-automation
Apps are never folded into one. The PR-automation App's token is minted
by workflows on every managed repo; the converger's only by the sweeper
workflow.
