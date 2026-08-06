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

**npm, pnpm, and yarn Berry only.** A CodeArtifact-backed PyPI registry
is out of scope: the endpoint is validated by host, so a `/pypi/<repo>/`
path parses, but nothing configures pip and the install gate skips the
action entirely on a repo whose only package manager is pip (its detect
step's `node` output guards the auth step). Do not set
`CODEARTIFACT_ROLE` to a pypi endpoint and expect it to work.

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
`id-token: write` on its single `install-gate-required` job for **every**
managed repo, including repos that do not use CodeArtifact. `permissions:` is static YAML and
cannot be made conditional, and converge-time detection was rejected: the
converger reads the *default branch* while the gate runs against *PR
head*, and the gate is a required check, so a repo that adopted
CodeArtifact between sweeps would have every PR blocked until the next
scheduled run. The grant is therefore latent everywhere, and the trust
policy is the control that keeps it inert.

Adding a consuming repo is an edit to this list **and** an edit to the
`CODEARTIFACT_ROLE` variable's repository-access list (§4) — two edits
that must be made together. There is still no converger-side step.

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

### The organization variable's repository access is a hard requirement

An organization variable created with **All repositories** access is
visible to every repo in the organization. The action arms purely on the
variable being non-empty, so that setting arms it **everywhere** —
including on repos the §3 trust policy deliberately does not name.

When you create or edit the organization variable, set its repository
access to **Selected repositories** and select **exactly the
repositories named in the §3 trust policy `sub` condition**. The two
lists are one list maintained in two places; keep them in lockstep.

What happens when they drift:

| Drift | Consequence |
| --- | --- |
| Repo has the **variable** but is **not** in the trust policy | The action arms, `AssumeRoleWithWebIdentity` is denied, the role-assumption step fails (there is no `continue-on-error`), and since the auth step runs inside `install-gate-required` itself — a **required check** — that check fails. **Every PR on that repo is blocked, with no mechanism by which it could go green.** |
| Repo is in the **trust policy** but does **not** have the variable | The action no-ops. Installs resolve from the public registry and fail on any private package. Nothing is blocked spuriously, and nothing is granted that was not already grantable. |

The first row is the failure this whole payload exists to eliminate,
reproduced in mirror image, so it is the one to guard against. If your
plan tier cannot scope an organization variable to selected
repositories, do **not** use an organization variable: put
`CODEARTIFACT_ROLE` at **repository** level on each consuming repo
instead. Repository-level placement makes the arming list and the trust
policy list the same enumeration by construction.

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

## 5. Nothing to provision — the credential is job-scoped

There is no repo-side prerequisite for the credential itself. **The
action writes nothing into the working tree.** Every mechanism is
job-scoped and reached by environment variable:

| Package manager | Mechanism |
| --- | --- |
| npm, pnpm | `$RUNNER_TEMP/.npmrc` (mode 600), with `NPM_CONFIG_USERCONFIG` exported through `$GITHUB_ENV` to point at it |
| yarn Berry | `YARN_NPM_REGISTRY_SERVER` / `YARN_NPM_AUTH_TOKEN` in `$GITHUB_ENV`, no file at all |

`$RUNNER_TEMP` is created and wiped per job, so the token cannot be
committed and does not outlive the run. You do **not** need to add
`.npmrc` to the repo's `.gitignore` for this action's sake.

### Why not the repo-root `.npmrc`

Because installs do not run from the repo root. `npm` resolves a project
`.npmrc` relative to the **nearest package directory** and never walks up
to the git root; `pnpm` walks up only as far as a covering
`pnpm-workspace.yaml`. The install gate discovers lockfiles at any depth
and installs with the working directory set to **each lockfile's own
directory** — and a lockfile below the repo root exists precisely when no
workspace root covers it, since a workspace consolidates to a single
lockfile at its own root.

So a repo-root file would be invisible to exactly the installs that need
it. That is not an exotic shape: a Python or Go service at the repo root
with `frontend/` carrying the only JS manifest, an `infra/` CDK app kept
deliberately independent of the app, per-function Lambda manifests that
each deploy in isolation. All are legitimate, and none may be left with a
permanently red required check.

Job-scoped storage reached by environment variable is the only shape
where the action does not have to know or guess which directory the
installer will `cd` into. It is also symmetric with how yarn Berry was
already handled.

`$HOME/.npmrc` was considered and rejected for the same class of reason
the working tree was: on a machine running more than one repo it pools
every repo's token into one file that any repo's install reads — a
cross-boundary credential hole, and the opposite of the
endpoint-as-allowlist property this design rests on.

A yarn file was rejected on every available path — the project
`.yarnrc.yml` is tracked (token-commit risk), a home-level file is not
repo-local and depends on runner directory layout, and
`YARN_RC_FILENAME` overrides the filename rather than the path, so a
subdirectory is never consulted.

### Coexisting with other registries

Only the lines the action owns are replaced in `$RUNNER_TEMP/.npmrc`:
the bare `registry=` line and the `//<host><path>:` auth namespace for
the configured endpoint. Another registry's `@scope:registry=` line and
its matching `//<other-host>/:_authToken=` line both survive, so a repo
that resolves its default registry from CodeArtifact while pulling one
scope from (say) GitHub Packages keeps working. The path is the same one
`actions/setup-node` uses for its own `registry-url` output, so the two
converge on one file instead of each pointing `NPM_CONFIG_USERCONFIG`
somewhere different and winning by step order.

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
  line, and never enters the working tree at all — it lives in
  `$RUNNER_TEMP`, which the runner creates and wipes per job. The
  can't-be-committed property is therefore structural, not asserted:
  there is no in-tree path to get it wrong.
- The `role` input reaches the shell as an environment variable, never
  interpolated into a `run:` body, so a crafted variable value cannot
  inject shell.
- Ephemeral GitHub-hosted runners are assumed. On a **self-hosted**
  runner, `$RUNNER_TEMP` is cleaned per job by the runner itself, but
  the machine is shared across jobs and repos in a way a hosted runner
  is not; a self-hosted fleet needs its own review of who can read the
  work directory while a job is live.

## Verifying

`.github/scripts/test-codeartifact-auth.sh` is a self-test that runs the
script's `parse` and `configure` subcommands against throwaway git repos
with a stubbed `aws` binary — no AWS account and no runner needed:

```bash
bash .github/scripts/test-codeartifact-auth.sh
```
