# Sweeper template runbook

The public template repo `TheVoskamps/gh-repo-config-sweeper-template`,
from which each managed org creates its private sweeper repo, is
publish output of this repo's `template/`: on every release,
`.github/workflows/release.yml`'s `publish-template` job pushes the
commit `git subtree split --prefix=template` makes to the template
repo's `main`, so that repo holds `template/`'s contents at its root and
nothing else. Nobody edits it by hand, and the release tarball does not
carry it.

A sweeper repo takes two things from two places. The operator scripts
and the example config come by git from the template repo:
`consumer-init.sh` creates the sweeper repo from it, and
`sync-upstream.sh` later merges it in over the `upstream` remote. The
converger and its payloads come as attested release tarballs from
`TheVoskamps/gh-repo-config`: `consumer-init.sh` places
`.github/workflows/sweep.yml` from one, and from the first sweep on the
converger keeps that file current. The template never tracks
`gh-repo-config.json`, so a template merge never touches the org's
config.

The template repo is never itself a sweeper repo: TheVoskamps adopts it
into a private repo like any other org, so the pin and the update
policy of the org that publishes the template stay private.

## Set up the template repo

Run once, as a TheVoskamps owner. The repo starts empty; the first
release after this procedure fills it.

Every file the template repo carries lands in each adopter's copy, so it
holds `template/`'s content and nothing else: no `CODEOWNERS`, no
community files, no workflows, no `dependabot.yml`, and no protection
files. Everything below is a setting, a key or a ruleset, which an
adopter's copy does not inherit. Do not run
`/github-setup:gh-repo-setup-public`, or any other skill that commits
into the repo it runs on.

1. Create the repo, public with the template flag on, so any org can
   create from it and fetch it:

   ```bash
   gh repo create TheVoskamps/gh-repo-config-sweeper-template --public \
     --description "Template for an org's private gh-repo-config sweeper repo"
   gh api -X PATCH /repos/TheVoskamps/gh-repo-config-sweeper-template -F is_template=true
   ```

2. Set its posture. Issues stay on: an adopter reports a problem where
   they find it, and an owner transfers the issue to
   `TheVoskamps/gh-repo-config`. Forking stays on, since a public repo
   cannot disable it; the repo takes no PRs, and the rulesets below
   block every push but the deploy key's. Actions are disabled, since
   nothing in the repo runs. Secret scanning and push protection are on:

   ```bash
   gh repo edit TheVoskamps/gh-repo-config-sweeper-template --enable-issues
   gh api -X PUT /repos/TheVoskamps/gh-repo-config-sweeper-template/actions/permissions \
     -F enabled=false
   gh api -X PATCH /repos/TheVoskamps/gh-repo-config-sweeper-template \
     -f 'security_and_analysis[secret_scanning][status]=enabled' \
     -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
   ```

3. Give `release.yml` its deploy key. Generate the pair, add the public
   half to the template repo with write access, store the private half
   as the `TEMPLATE_DEPLOY_KEY` Actions secret of
   `TheVoskamps/gh-repo-config`, and delete both local files:

   ```bash
   ssh-keygen -t ed25519 -N '' -f template-deploy-key \
     -C 'TheVoskamps/gh-repo-config release.yml: template/ -> TheVoskamps/gh-repo-config-sweeper-template'
   gh repo deploy-key add template-deploy-key.pub \
     --repo TheVoskamps/gh-repo-config-sweeper-template \
     --allow-write --title 'gh-repo-config release.yml template/ publish'
   gh secret set TEMPLATE_DEPLOY_KEY --repo TheVoskamps/gh-repo-config < template-deploy-key
   rm template-deploy-key template-deploy-key.pub
   ```

   The publish key stays the template repo's only deploy key. The
   `publish-only` ruleset below bypasses for the `DeployKey` actor type,
   which covers every deploy key on the repo, so a second key would
   share the publish key's write path.

4. Add two rulesets on the default branch. A bypass actor skips every
   rule in its ruleset, and the rules of all rulesets on a branch
   aggregate, so the split is what lets the deploy key create and update
   `main` but never delete or rewrite it.

   `publish-only` blocks creation and update of the branch for everyone
   but a deploy key:

   ```bash
   gh api -X POST /repos/TheVoskamps/gh-repo-config-sweeper-template/rulesets --input - <<'EOF'
   {
     "name": "publish-only",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [
       { "actor_id": null, "actor_type": "DeployKey", "bypass_mode": "always" }
     ],
     "rules": [
       { "type": "creation" },
       { "type": "update" }
     ]
   }
   EOF
   ```

   `protect-history` blocks deletion and force-push for everyone, the
   deploy key included. `release.yml` never force-pushes: each publish
   is a fast-forward of the previous one, and this ruleset turns
   anything else into a failed job rather than rewritten history
   consumers have merged:

   ```bash
   gh api -X POST /repos/TheVoskamps/gh-repo-config-sweeper-template/rulesets --input - <<'EOF'
   {
     "name": "protect-history",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [],
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" }
     ]
   }
   EOF
   ```

   Check that the rules of both rulesets apply to `main`:

   ```bash
   gh api repos/TheVoskamps/gh-repo-config-sweeper-template/rules/branches/main
   ```

5. Flag the repo `opt-out` in the org custom property
   `gh-repo-config-mode`, so TheVoskamps' own sweep never manages it:

   ```bash
   gh api -X PATCH /orgs/TheVoskamps/properties/values \
     -f "repository_names[]=gh-repo-config-sweeper-template" \
     -f "properties[][property_name]=gh-repo-config-mode" \
     -f "properties[][value]=opt-out"
   ```

6. Check that nobody but the repo's intended maintainers holds write
   access or above:

   ```bash
   gh api /repos/TheVoskamps/gh-repo-config-sweeper-template/collaborators \
     --jq '.[] | {login, role_name}'
   ```

## Adopt the template in an org

Run as an owner of the adopting org. `acme` stands for that org's login
throughout, including in the Claude Code commands and URLs, where no
shell variable expands. Set `ORG` once, in the shell every command below
runs in:

```bash
ORG=acme
```

### 1. Create the sweeper repo

Fetch `consumer-init.sh` from the template and run it from the
directory the clone should land in:

```bash
gh api -H "Accept: application/vnd.github.raw" \
  repos/TheVoskamps/gh-repo-config-sweeper-template/contents/scripts/consumer-init.sh > consumer-init.sh
bash consumer-init.sh -o "$ORG"
cd gh-repo-config-sweeper
```

It creates `$ORG/gh-repo-config-sweeper` from the template, private,
clones it, adds the template as `upstream` and merges `upstream/main`
once with `--allow-unrelated-histories`, so later template merges have
a merge base, then creates `gh-repo-config.json` from
`gh-repo-config.example.json`, commits it, and pushes. It then
downloads the converger release, verifies its attestation before
unpacking it, commits the release's sweep workflow to
`.github/workflows/sweep.yml` on the default branch, pushes, and
disables the workflow, so no tick runs before the Apps, secrets and
properties are in place. The name is the convention, and `-n` changes it; the visibility is
not optional, and the script offers no flag for it. `-p <tag>` pins a
release, as its `vX.Y.Z` tag: it is written into `gh-repo-config.json`
as `version-pin` and is the release the workflow comes from. Without
it the config carries no pin and the latest release is used. A repo
created from the template by hand, in the GUI or with
`gh repo create --template`, has no `upstream` remote and no merge
base, and `scripts/sync-upstream.sh` refuses it later.

### 2. Register the two Apps

Run each from the root of the clone, in Claude Code. At the install
step, install the App on **All repositories**.

The converger App, with **Custom** permissions `Administration: write`,
`Contents: write`, `Pull requests: write`, `Workflows: write`,
`Code scanning alerts: write`, `Organization administration: write`,
`Organization custom properties: write`, `Metadata: read`:

```text
/github-setup:gh-create-app --scope=org --owner=acme --app-name=acme-repo-config-converger --permissions=custom --secret-scope=organization --app-id-secret=CONVERGER_APP_CLIENT_ID --app-key-secret=CONVERGER_APP_PRIVATE_KEY --metadata-path=docs/github-app-converger.md
```

The PR-automation App, with **Custom** permissions `Contents: write`,
`Pull requests: write`, `Issues: write`, `Workflows: write`,
`Checks: read`, `Commit statuses: read`, `Metadata: read`:

```text
/github-setup:gh-create-app --scope=org --owner=acme --app-name=acme-pr-automations --permissions=custom --secret-scope=organization --app-id-secret=AUTOMERGE_APP_CLIENT_ID --app-key-secret=AUTOMERGE_APP_PRIVATE_KEY --metadata-path=docs/github-app-pr-automation.md
```

The skill stores the numeric App ID in the secret it is given for it.
Step 3 overwrites both Client-ID secrets with the Client ID.

Name the PR-automation App in `gh-repo-config.json`, which then reads:

```json
{
  "sweeper-update-policy": "manual",
  "pr-automation-identity": {
    "app-name": "acme-pr-automations",
    "app-client-id-secret": "AUTOMERGE_APP_CLIENT_ID",
    "app-private-key-secret": "AUTOMERGE_APP_PRIVATE_KEY",
    "bot-slug": "acme-pr-automations[bot]"
  }
}
```

Commit it with the two metadata docs the skill wrote:

```bash
git add gh-repo-config.json docs/github-app-converger.md docs/github-app-pr-automation.md
git commit -m "Name the org's PR-automation App and record both Apps"
git push origin HEAD
```

### 3. Set the four org secrets

Each Client-ID secret holds the App's **Client ID**, read off the App's
settings page at
`https://github.com/organizations/acme/settings/apps/<app slug>`, never
its numeric App ID: every workflow mints through
`actions/create-github-app-token`'s `client-id:` input. Each private-key
secret holds the `.pem` the App's settings page generated.

The converger App's pair, in the Actions store, visible to the sweeper
repo:

```bash
gh secret set CONVERGER_APP_CLIENT_ID --org "$ORG" --app actions \
  --visibility selected --repos gh-repo-config-sweeper \
  --body "<converger App Client ID>"
gh secret set CONVERGER_APP_PRIVATE_KEY --org "$ORG" --app actions \
  --visibility selected --repos gh-repo-config-sweeper \
  < "<path to the converger App .pem>"
```

The PR-automation App's pair must exist in **both** org secret stores,
Actions and Dependabot, each with all-repositories visibility:

```bash
gh secret set AUTOMERGE_APP_CLIENT_ID --org "$ORG" --app actions \
  --visibility all --body "<PR-automation App Client ID>"
gh secret set AUTOMERGE_APP_CLIENT_ID --org "$ORG" --app dependabot \
  --visibility all --body "<PR-automation App Client ID>"
gh secret set AUTOMERGE_APP_PRIVATE_KEY --org "$ORG" --app actions \
  --visibility all < "<path to the PR-automation App .pem>"
gh secret set AUTOMERGE_APP_PRIVATE_KEY --org "$ORG" --app dependabot \
  --visibility all < "<path to the PR-automation App .pem>"
```

### 4. Define the two org custom properties

Define exactly these two; no third property takes part.

`gh-repo-config-mode` is a single-select over `opt-in` / `opt-out`,
defined with `required: true` and a schema `default_value`. It must be
required, for the reason `docs/repo-selection.md` → "Provisioning
contract" gives. And it must carry a default, because without one
every repo lacking a value of its own reads as unmanaged: an
all-unmanaged tick that looks exactly like a healthy one. The sweep exits non-zero on that
state rather than reporting it quietly. The org-wide default lives in
this property's own schema; `opt-out` starts the org with nothing
managed but the repos flagged `opt-in`:

```bash
gh api -X PUT "/orgs/$ORG/properties/schema/gh-repo-config-mode" \
  -f value_type=single_select \
  -F required=true \
  -f default_value=opt-out \
  -f "allowed_values[]=opt-in" \
  -f "allowed_values[]=opt-out"
```

`gh-repo-config-version` is the string stamp the converger writes on
each repo it converges:

```bash
gh api -X PUT "/orgs/$ORG/properties/schema/gh-repo-config-version" \
  -f value_type=string
```

Flag the sweeper repo `opt-in`. The sweep converges only managed repos,
so an unmanaged sweeper repo never has its own sweep workflow
converged:

```bash
gh api -X PATCH "/orgs/$ORG/properties/values" \
  -f "repository_names[]=gh-repo-config-sweeper" \
  -f "properties[][property_name]=gh-repo-config-mode" \
  -f "properties[][value]=opt-in"
```

### 5. Enable the sweep workflow

`consumer-init.sh` left it disabled; with the Apps, secrets and
properties in place it can run:

```bash
gh workflow enable sweep.yml --repo "$ORG/gh-repo-config-sweeper"
```

### 6. Trigger the first sweep

Dry run first, and watch it to the end:

```bash
gh workflow run sweep.yml --repo "$ORG/gh-repo-config-sweeper" -f dry-run=true
gh run watch --repo "$ORG/gh-repo-config-sweeper"
```

Then the real run:

```bash
gh workflow run sweep.yml --repo "$ORG/gh-repo-config-sweeper"
```

The dry run's summary header names the declared default, `opt-out`, and
lists `gh-repo-config-sweeper` as the only converge candidate. A header
reporting `gh-repo-config-mode` undefined or without a default is a
failed step 4.
