# Memory Index

- [Self-review blocks request-changes](feedback_self_review_blocks_request_changes.md) — gh blocks --request-changes on your own PR too, not just --approve; downgrade to --comment with a CHANGES REQUESTED verdict line.
- [Sandbox constraints under .claude/tmp](feedback_sandbox_git_replay_constraints.md) — `git config user.*` blocked; use GIT_AUTHOR_*/GIT_COMMITTER_* + a script file; `lint:md` also lints scratch .md parked there.
- [REST commits API identity fields](reference_rest_commits_api_raw_git_identity.md) — `.commit.*.email` is raw git, `.author.login` is the resolved account; this repo's history has a live rebase example.
- [Verify GitHub semantics from raw upstream](reference_verify_github_semantics_from_raw_upstream.md) — curl github/docs and the pinned action SHA instead of answering context/annotation questions from memory.
- [Exercise workflow run blocks](reference_exercise_workflow_run_blocks.md) — no pyyaml (yq is present); extract the block verbatim, build scratch git trees, stub the script to observe argv.
- [code_scanning rule blocks on the tool](reference_code_scanning_rule_blocks_on_tool.md) — a CodeQL job losing its required-check name does NOT lose alert enforcement; read protect-main-ruleset.json before grading such a gap.
