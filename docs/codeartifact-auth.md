# CodeArtifact auth: operator prerequisites

The converger fans out a `codeartifact-auth` composite action to every
managed repo:

| Path in the target repo | Kind |
| --- | --- |
| `.github/actions/codeartifact-auth/action.yml` | verbatim composite action |
| `.github/scripts/codeartifact-auth.sh` | verbatim script (all of the logic) |
| `.github/scripts/test-codeartifact-auth.sh` | its self-test |

The action authenticates npm, pnpm, and yarn Berry against an AWS
CodeArtifact repository using GitHub OIDC, so that real installs — the
converger's own `dependency-install-gate` first among them — can resolve
against a CodeArtifact-backed registry. It is **inert, with zero
configuration, on every managed repo that does not use CodeArtifact**.

Everything below is provisioned by an operator in the target AWS account
and in GitHub. None of it is built by this repo, in the same way the
three org custom properties the sweep requires
(`gh-repo-config-mode`, `gh-repo-config-default`,
`gh-repo-config-version`) are an operator-provisioning step.

## 1. The GitHub OIDC identity provider

Create the GitHub Actions OIDC provider in the AWS account that owns the
CodeArtifact domain, if it does not already exist:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

One provider per account serves every repo in every organization.

## 2. A role with `ReadFromRepository`

Create an IAM role whose permission policy grants read access to the one
CodeArtifact repository the consuming repos resolve from, plus the
domain-scoped token call:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GetDomainScopedToken",
      "Effect": "Allow",
      "Action": "codeartifact:GetAuthorizationToken",
      "Resource": "arn:aws:codeartifact:us-west-2:111122223333:domain/my_domain"
    },
    {
      "Sid": "ReadFromRepository",
      "Effect": "Allow",
      "Action": [
        "codeartifact:ReadFromRepository",
        "codeartifact:GetRepositoryEndpoint",
        "codeartifact:DescribePackageVersion",
        "codeartifact:DescribeRepository",
        "codeartifact:GetPackageVersionReadme",
        "codeartifact:ListPackages",
        "codeartifact:ListPackageVersions",
        "codeartifact:ListPackageVersionAssets",
        "codeartifact:GetPackageVersionAsset"
      ],
      "Resource": [
        "arn:aws:codeartifact:us-west-2:111122223333:repository/my_domain/releases",
        "arn:aws:codeartifact:us-west-2:111122223333:package/my_domain/releases/*/*/*"
      ]
    },
    {
      "Sid": "StsGetTokenForCodeArtifact",
      "Effect": "Allow",
      "Action": "sts:GetServiceBearerToken",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "sts:AWSServiceName": "codeartifact.amazonaws.com" }
      }
    }
  ]
}
```

The CodeArtifact authorization token is **domain-scoped** — the API call
takes no `--repository` argument — so per-repository restriction comes
from this policy, not from the token.

## 3. A trust policy naming concrete repositories

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:MyOrg/first-consuming-repo:*",
            "repo:MyOrg/second-consuming-repo:*"
          ]
        }
      }
    }
  ]
}
```

**This is a hard requirement, not a recommendation.** The `sub`
condition must name concrete repositories. A wildcard such as
`repo:MyOrg/*:*` would let **any** repo in the organization assume the
role.

That matters because the rendered `dependency-install-gate.yml` grants
`id-token: write` on its `gate` job for **every** managed repo, including
repos that do not use CodeArtifact. `permissions:` is static YAML and
cannot be made conditional, and converge-time detection was rejected: the
converger reads the *default branch* while the gate runs against *PR
head*, and the gate is a required check, so a repo that adopted
CodeArtifact between sweeps would have every PR blocked until the next
scheduled run. The grant is therefore latent everywhere, and the trust
policy is the control that keeps it inert.

Adding a consuming repo is an edit to this list. There is no
converger-side step.

## 4. The `CODEARTIFACT_ROLE` variable

A GitHub Actions **variable** (not a secret — role ARNs are not secrets;
the trust policy is the control) holding a single line: the CodeArtifact
npm endpoint, whitespace, and the role ARN.

```text
my_domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/releases/  arn:aws:iam::111122223333:role/gh-actions-ca-releases-read
```

Set it at **organization** level for the CodeArtifact repository most
repos consume; set it at **repository** level on a repo that consumes a
different one. GitHub resolves a variable at the lowest level it is
defined, so the repository value replaces the organization value — the
override is GitHub's own precedence, and the action contains no merge
logic. Unset at both levels means the action no-ops.

The endpoint encodes the domain, the domain-owner account, and the
region, so none of the three is configured separately. The `https://`
scheme prefix and the trailing slash are both optional.

### Exactly one endpoint

A value naming more than one endpoint fails the run with a clear message.
This is a constraint of the package managers, not a simplification of
convenience: npm, pnpm, and yarn each resolve a package to exactly one
registry — the default `registry`, or `@scope:registry` when scoped —
with no fallback chain. Two CodeArtifact repositories holding the same
npm scope therefore cannot both be consumed; `@scope:registry` cannot
separate them because the scope is identical on both sides. Use
CodeArtifact **upstream** relationships to reach a second repository;
that solves the problem at the CodeArtifact layer rather than the
package-manager layer.

## 5. `.npmrc` must be gitignored and untracked

The action writes the registry and the authorization token to the
repo-root `.npmrc` — the same file and shape developers get from
`aws codeartifact login` locally. Before writing, it asserts that
`.npmrc` is **both** gitignored **and** untracked, and fails loudly
otherwise: it must never write a token into a file git will keep. Add
`.npmrc` to the repo's `.gitignore`.

Yarn Berry needs no file: the action exports
`YARN_NPM_REGISTRY_SERVER` and `YARN_NPM_AUTH_TOKEN` through
`$GITHUB_ENV`. A file was rejected on every available path — the project
`.yarnrc.yml` is tracked (token-commit risk), a home-level file is not
repo-local and depends on runner directory layout, and
`YARN_RC_FILENAME` overrides the filename rather than the path, so a
subdirectory is never consulted.

## Using the action from a repo-owned workflow

Any workflow in a managed repo can call the same action. It must grant
`id-token: write` on the job that calls it, and call it between checkout
and install:

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: ./.github/actions/codeartifact-auth
        with:
          role: ${{ vars.CODEARTIFACT_ROLE }}
      - run: pnpm install --frozen-lockfile
```

The action exposes two outputs: `enabled` (`'true'` when CodeArtifact
was configured, `'false'` when it no-opped) and `registry` (the URL the
package managers were pointed at).

## Threat model

Target repos are private, in a GitHub Team or Enterprise/EMU
organization, and every PR comes from an organization member. Public
repos that accept fork PRs do not use CodeArtifact.

- The configured endpoint is the allowlist: the action authenticates to
  that endpoint and no other, so a PR that redirects the registry to an
  attacker-controlled host receives no credentials.
- Role ARNs are not secrets; the IAM trust policy is the control.
- The minted token is masked in the log before it can reach any output
  line, and is written only to a `.npmrc` that git provably ignores.
- The `role` input reaches the shell as an environment variable, never
  interpolated into a `run:` body, so a crafted variable value cannot
  inject shell.

## Verifying

`.github/scripts/test-codeartifact-auth.sh` is a self-test that runs the
script's `parse` and `configure` subcommands against throwaway git repos
with a stubbed `aws` binary — no AWS account and no runner needed:

```bash
bash .github/scripts/test-codeartifact-auth.sh
```
