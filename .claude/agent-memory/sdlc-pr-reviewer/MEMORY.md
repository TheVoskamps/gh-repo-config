# Memory Index

- [Self-review blocks request-changes](feedback_self_review_blocks_request_changes.md) — gh blocks --request-changes on your own PR too, not just --approve; downgrade to --comment with a CHANGES REQUESTED verdict line.
- [Sandbox git-replay constraints](feedback_sandbox_git_replay_constraints.md) — `git config user.*` is blocked; use GIT_AUTHOR_*/GIT_COMMITTER_* env vars and put the replay in a script file.
- [REST commits API identity fields](reference_rest_commits_api_raw_git_identity.md) — `.commit.*.email` is raw git, `.author.login` is the resolved account; this repo's history has a live rebase example.
- [Verify GitHub semantics from raw upstream](reference_verify_github_semantics_from_raw_upstream.md) — curl github/docs and the pinned action SHA instead of answering context/annotation questions from memory.
- [Exercise workflow run blocks](reference_exercise_workflow_run_blocks.md) — no pyyaml (yq is present); extract the block verbatim, build scratch git trees, stub the script to observe argv.
