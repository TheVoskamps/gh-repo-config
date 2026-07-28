---
name: reference-rest-commits-api-raw-git-identity
description: GitHub's REST commits API splits raw git identity (.commit.author/committer.email) from the GitHub-resolved account (.author/.committer.login) — and this repo's own history holds a worked auto-rebase example to check a bot-identity guard against.
metadata:
  type: reference
---

# REST commits API: raw git identity vs resolved account

`GET /repos/{owner}/{repo}/commits/{sha}` returns two different
notions of identity, and workflow guards in this repo key on the
first:

- `.commit.author.email` / `.commit.committer.email` — the **raw git
  identity off the commit object**, byte-for-byte, not normalised by
  GitHub.
- `.author.login` / `.committer.login` — the GitHub **account**
  GitHub resolved that identity to, or `null` when it resolves to
  nothing (a bot identity like
  `gh-repo-config-auto-rebase[bot]@users.noreply.github.com` resolves
  to `null`).

**Where to find a live worked example instead of building a sandbox.**
This repo's history contains commits that went through
`auto-rebase-prs.yml`'s rebase-and-force-push, so they demonstrate
"rebase rewrites the committer and preserves the author" against real
GitHub data. Find one with:

```bash
git log --all --format='%ae | %ce | %H' | sort -u -t'|' -k1,1
```

then compare the row against
`gh api repos/TheVoskamps/gh-repo-config/commits/<sha> --jq '{a: .commit.author.email, c: .commit.committer.email}'`.

**Why this matters here:** `.github/workflows/assets-pin-bump.yml`'s
bot-authorship guard, and `assets/auto-rebase-prs.yml`'s
Dependabot-author exclusion, both depend on the author surviving a
rebase while the committer does not. A PR review of either should
settle that empirically, and this is the cheapest way — stronger than
a sandbox, because it is the real API on real data. See
[[feedback-sandbox-git-replay-constraints]] for when a sandbox is
still needed.
