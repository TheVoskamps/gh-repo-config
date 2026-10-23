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
