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

## The ruleset compare is driven by the canonical asset alone

The `protect-main` compare in `src/converge/ruleset.ts` iterates only
the rules and parameter keys `assets/protect-main-ruleset.json` carries.
It never iterates the server's rules or keys and never names a rule or
parameter in a hardcoded list, and a parameter the asset does not model
is neither drift nor a warning.

## The PR-automation App slug has one source

The PR-automation App's slug, wherever it is needed (the `protect-main`
bypass actor included), is derived from the resolved
`PrAutomationIdentity`'s `appName`. No module holds a baked slug
constant beside it, since a second source drifts from the identity the
rendered workflows use.
