# Sweeper template runbook

`template/` is the content of the public template repo
`TheVoskamps/gh-repo-config-sweeper-template`, from which each managed
org copies its private sweeper repo. The release tarball does not carry
it: the template repo receives it from the push under "Publish the
template". The template is bootstrap-only and unmanaged. Once an org
has copied it, the template is out of that org's loop, and the
converger keeps the org's sweep workflow current.

The template repo is never itself a sweeper repo: TheVoskamps adopts it
into a private repo like any other org, so the pin and the update
policy of the org that publishes the template stay private.

## Publish the template

Run once, as a TheVoskamps owner, from a clone of
`TheVoskamps/gh-repo-config` at the `main` commit being published.

1. Stage `template/` as a fresh single-commit repo and create the public
   repo from it:

   ```bash
   src="$(git rev-parse --show-toplevel)"
   rev="$(git rev-parse --short HEAD)"
   stage="$(mktemp -d)"
   cp -R "$src/template/." "$stage/"
   cd "$stage"
   git init -b main
   git add -A
   git commit -m "Add the gh-repo-config sweeper template from gh-repo-config ${rev}"
   gh repo create TheVoskamps/gh-repo-config-sweeper-template --public \
     --description "Template for an org's private gh-repo-config sweeper repo" \
     --source . --remote origin --push
   ```

2. Set the template flag:

   ```bash
   gh api -X PATCH /repos/TheVoskamps/gh-repo-config-sweeper-template -F is_template=true
   ```

   Leave forking as it is. A public repo has no setting that disables
   forking, so adopters copy the template while contributors can still
   fork it and send a PR back.

3. Set the repo's public posture, through settings alone. Every file the
   template repo carries lands in each adopter's copy, so the repo holds
   `template/`'s content and nothing else: no `CODEOWNERS`, no
   community files, no workflows, no `dependabot.yml`. Do not run
   `/github-setup:gh-repo-setup-public`, or any other skill that commits
   into the repo it runs on.

   Issues on, merge commits only, head branches deleted on merge:

   ```bash
   gh repo edit TheVoskamps/gh-repo-config-sweeper-template \
     --enable-issues \
     --enable-merge-commit --enable-squash-merge=false --enable-rebase-merge=false \
     --allow-update-branch --delete-branch-on-merge
   ```

   Dependabot alerts, secret scanning, and push protection:

   ```bash
   gh api -X PUT /repos/TheVoskamps/gh-repo-config-sweeper-template/vulnerability-alerts
   gh api -X PATCH /repos/TheVoskamps/gh-repo-config-sweeper-template \
     -f 'security_and_analysis[secret_scanning][status]=enabled' \
     -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
   ```

   The `protect-main` ruleset on the default branch: no deletion, no
   force push, and a reviewed PR with every conversation resolved. It
   requires no code-owner review and no status check, since either
   would need a file in the repo. Repository admins may merge a PR
   without the approval, which a sole maintainer cannot give their own
   PR:

   ```bash
   gh api -X POST /repos/TheVoskamps/gh-repo-config-sweeper-template/rulesets --input - <<'EOF'
   {
     "name": "protect-main",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [
       { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
     ],
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       {
         "type": "pull_request",
         "parameters": {
           "required_approving_review_count": 1,
           "dismiss_stale_reviews_on_push": true,
           "require_code_owner_review": false,
           "require_last_push_approval": true,
           "required_review_thread_resolution": true,
           "allowed_merge_methods": ["merge"]
         }
       }
     ]
   }
   EOF
   ```

   Check that nobody but the repo's intended maintainers holds write
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

### 1. Copy the template

```bash
gh repo create "$ORG/gh-repo-config-sweeper" --private \
  --template TheVoskamps/gh-repo-config-sweeper-template --clone
cd gh-repo-config-sweeper
```

In the GUI this is **Use this template** → **Create a new repository**
on `TheVoskamps/gh-repo-config-sweeper-template`, owner `$ORG`, name
`gh-repo-config-sweeper`, visibility **Private**. The name is the
convention; the visibility is not optional.

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

Commit it with the two metadata docs the skill wrote, so the working
tree is clean for `bootstrap.sh`:

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

### 5. Run `bootstrap.sh`

From the root of the clone, on the default branch, with a clean working
tree:

```bash
./bootstrap.sh
```

It commits `.github/workflows/sweep.yml` straight to the default branch
and pushes it.

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
