# gh-repo-config
GitHub Organization-wide Repo configuration for fan-out of rulesets, actions, and workflows to protect and automate

## Development

```bash
npm ci
npm run build
npm test
```

Releases are published as immutable, attested GitHub Releases from
`.github/workflows/release.yml` on `v*` tag push — see
`docs/org-repo-configuration-fanout-design.md` for the distribution
design.

## Contributing

This is a public repository. Contributions are welcome:

- **Fork** the repository and create a feature branch from the default
  branch.
- **Open a pull request** from your fork. PRs require a passing CI run,
  code-owner review (`@evoskamp`), and all review conversations
  resolved before they can merge.
- **File an issue** to report a bug or propose a change. Any logged-in
  GitHub user can open and comment on issues.

Outside contributors have read access: you can fork, open PRs from your
fork, and file/comment on issues. Push access, merging, and issue
triage are reserved for maintainers.
