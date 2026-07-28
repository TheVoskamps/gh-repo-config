# Memory Index

- [Self-review blocks request-changes](feedback_self_review_blocks_request_changes.md) — gh blocks --request-changes on your own PR too, not just --approve; downgrade to --comment with a CHANGES REQUESTED verdict line.
- [Sandbox git-replay constraints](feedback_sandbox_git_replay_constraints.md) — `git config user.*` is blocked; use GIT_AUTHOR_*/GIT_COMMITTER_* env vars and put the replay in a script file.
- [REST commits API identity fields](reference_rest_commits_api_raw_git_identity.md) — `.commit.*.email` is raw git, `.author.login` is the resolved account; this repo's history has a live rebase example.
