# Memory Index

- [Self-review blocks request-changes](feedback_self_review_blocks_request_changes.md) — gh blocks --request-changes on your own PR too, not just --approve; but compare `gh api user` against `author.login` first, since the Claude App identity usually differs from the PR author.
- [Sandbox constraints under .claude/tmp](feedback_sandbox_git_replay_constraints.md) — `git config user.*` blocked; script file, not compound Bash; scratch `.md` belongs in the harness scratchpad, which is writable.
- [REST commits API identity fields](reference_rest_commits_api_raw_git_identity.md) — `.commit.*.email` is raw git, `.author.login` is the resolved account; this repo's history has a live rebase example.
- [Verify GitHub semantics from raw upstream](reference_verify_github_semantics_from_raw_upstream.md) — curl github/docs and the pinned action SHA instead of answering context/annotation questions from memory.
- [Exercise workflow run blocks](reference_exercise_workflow_run_blocks.md) — no pyyaml (use yq, or js-yaml from node_modules — undeclared, review-only); extract the block verbatim, build scratch git trees, stub the script to observe argv.
- [code_scanning rule blocks on the tool](reference_code_scanning_rule_blocks_on_tool.md) — a CodeQL job losing its required-check name does NOT lose alert enforcement; read protect-main-ruleset.json before grading such a gap.
- [Shell linters are CI-only](reference_shell_linters_are_ci_only.md) — shellcheck/actionlint are not on the host and not project deps; substitute `bash -n` + self-tests and say plainly the gap is unclosed.
- [Job-shape changes orphan script outputs](reference_job_shape_changes_orphan_script_outputs.md) — a retired `detect` job leaves `GITHUB_OUTPUT` writes nothing reads; grep the scripts and diff consumers against origin/main.
- [Renamed constant falsifies distant prose](reference_renamed_constant_falsifies_distant_prose.md) — a rename that changes MEANING falsifies comments carrying neither name; grep `origin/main:<file>` for the OLD semantic word.
- [Verify a test actually bites](reference_verify_a_test_actually_bites.md) — replay against `git archive origin/main`; cross-check hand-rolled helpers against a real parser; inject at the runtime source (often `package.json`, not `dist/`).
- [PR-body deferrals go stale](reference_pr_body_deferrals_go_stale.md) — re-read `stateReason` on deferred-to issues every round, and re-read the body itself: the cleanup the brief says landed usually only half-landed.
