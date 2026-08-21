# Repo selection: the `gh-repo-config-mode` property

Whether the converger touches a repo at all is decided by exactly one
org custom property, `gh-repo-config-mode`. The property carries both
levels of the decision: a repo's own value, and — in the same property's
schema — the `default_value` every repo without a value of its own falls
back to.

The other selection-adjacent property, `gh-repo-config-version`, is the
per-repo applied-release stamp and is unrelated to this decision. It is
unchanged.

## Provisioning contract

`gh-repo-config-mode` must be defined on the org as:

- `value_type`: `single_select`
- `allowed_values`: `opt-in`, `opt-out`
- `required`: `true`
- `default_value`: `opt-in` or `opt-out`

`required: true` is not decoration. GitHub rejects a `default_value` on
an optional property:

```text
422 Validation failed: Default value must be empty
```

That 422 is why the org-level value could not simply live on the
optional per-repo property, and why the two levels were once split
across two properties speaking two different vocabularies. Making the
property required is GitHub's own mechanism for "org value, repo
override, absent reads through", and it costs the effective value
becoming visible on every repo's custom-properties surface. That cost is
a display of an inherited value, not a value written onto the repo, and
it is cosmetic and accepted — GitHub recomputes the inheritance whenever
the default changes, which "Truth table" below documents and shows how
to re-check.

## Truth table

The value always describes **the repo's state**, at both levels. `opt-in`
means managed; `opt-out` means not managed.

| Repo value           | Schema `default_value` | Managed? |
| -------------------- | ---------------------- | -------- |
| `opt-in`             | (any)                  | yes      |
| `opt-out`            | (any)                  | no       |
| unset / unrecognized | `opt-in`               | yes      |
| unset / unrecognized | `opt-out`              | no       |

Fail-safe collapses feed that table, each biased toward "don't touch":

- A repo value that is not exactly `opt-in` or `opt-out` — missing,
  empty, or a typo — normalizes to unset, and then follows the default.
- A missing or unrecognized `default_value` resolves as `opt-out`, so an
  unprovisioned org manages nothing.

Read-through is implemented in the sweep's own code, not assumed of the
API: the sweep reads the schema's `default_value` once per tick and each
repo's own value through the bulk values read, then applies the table.
That makes a resolution at a fixed default indifferent to how the API
renders an inheriting repo — a repo whose read returns the default
resolves exactly as an unset repo does, since both arms of the table
agree there.

A *change* of default, which the runbook's step-8 flip is, would not be
indifferent, so it was measured rather than assumed. GitHub
**recomputes** inheritance when a property's `default_value` changes: it
never writes the outgoing default onto repos as an explicit value. A
repo's own explicit value is stored independently of the default and
survives a change of default in either direction.

That was established on the TheVoskamps org on 2026-08-20 with a
throwaway `x-materialization-probe` property (`single_select`, allowed
values `alpha` / `beta`, deleted afterwards). Re-run it against your own
org rather than trusting this paragraph — read the resulting per-repo
values with the same listing the runbook's step 1 uses, substituting the
probe's name:

```bash
# a. Define the probe: required, default alpha. Every repo in the org
#    (36 at the time) then reads alpha.
gh api -X PUT /orgs/<org>/properties/schema/x-materialization-probe \
  -f value_type=single_select \
  -F required=true \
  -f default_value=alpha \
  -f "allowed_values[]=alpha" \
  -f "allowed_values[]=beta"

# b. Change ONLY the default. Every repo now reads beta, so the outgoing
#    default was never written onto them.
gh api -X PUT /orgs/<org>/properties/schema/x-materialization-probe \
  -f value_type=single_select \
  -F required=true \
  -f default_value=beta \
  -f "allowed_values[]=alpha" \
  -f "allowed_values[]=beta"

# c. Put the default back to alpha, flag ONE repo explicitly alpha, then
#    change the default to beta. That repo keeps alpha while every other
#    repo reads beta, so an explicit value is stored independently of the
#    default and survives a change of it.
gh api -X PUT /orgs/<org>/properties/schema/x-materialization-probe \
  -f value_type=single_select \
  -F required=true \
  -f default_value=alpha \
  -f "allowed_values[]=alpha" \
  -f "allowed_values[]=beta"
gh api -X PATCH /orgs/<org>/properties/values \
  -f "repository_names[]=<repo>" \
  -f "properties[][property_name]=x-materialization-probe" \
  -f "properties[][value]=alpha"
gh api -X PUT /orgs/<org>/properties/schema/x-materialization-probe \
  -f value_type=single_select \
  -F required=true \
  -f default_value=beta \
  -f "allowed_values[]=alpha" \
  -f "allowed_values[]=beta"

# d. Read the values back after each step above
gh api /orgs/<org>/properties/values --paginate \
  --jq '.[] | [.repository_name, (.properties[] | select(.property_name == "x-materialization-probe") | .value // "(unset)")] | @tsv'

# e. Delete the probe
gh api -X DELETE /orgs/<org>/properties/schema/x-materialization-probe
```

Two things follow for the runbook. Step 8's flip converts every repo
still unset, exactly as written, so the ordinary step order 3 → 7 → 8
is correct and needs no intermediate value-clearing pass. And step 7's
per-repo `opt-out` flagging is durable across that flip: those values
are explicit, so the step-8 default change leaves them alone and their
repos stay unmanaged.

## Semantic inversion from the retired vocabulary

Selection used to read two properties: the per-repo mode spoke
`process` / `ignore`, and a separate org-level property spoke `opt-in` /
`opt-out` naming the org's **regime** rather than a repo's state. The
new vocabulary reuses those two tokens with the opposite sense:

| Retired org-level value | Meaning                    | Equivalent `default_value` |
| ----------------------- | -------------------------- | -------------------------- |
| `opt-in`                | unset repos are unmanaged  | `opt-out`                  |
| `opt-out`               | unset repos are managed    | `opt-in`                   |

A mapping ported mechanically from the old property inverts. The
per-repo tokens changed outright: `process` became `opt-in` and `ignore`
became `opt-out`, and neither retired token is recognized any more — a
repo still carrying `process` reads as unset and follows the default.

## Provenance: what the sweep reports and exits on

The sweep reads the `gh-repo-config-mode` schema and reports where the
default came from:

- **`default_value` present** — the sweep summary header names the
  declared default, and the tick exits zero (absent other failures).
- **Property defined with no `default_value`, or not defined at all** —
  the tick still runs fail-safe (nothing managed by default) and the CLI
  exits non-zero with a message naming the property and this contract.

"Defined with no value" used to be the legitimate steady state, forced
by the 422 on an optional property. Under the required-with-default
contract it can only mean provisioning drift, so it fails exactly like
"not defined".

The loud failure exists because the fail-safe collapse is otherwise
indistinguishable from a correctly-configured org with nobody opted in.
That ambiguity once masked a real outage: the selection properties did
not exist on the org at all, and every scheduled tick reported all repos
unmanaged.

## Operator runbook

Ordering: merge the code change first, then run the migration
immediately. A scheduled tick that lands between merge and migration
fails loudly (the new code finds `gh-repo-config-mode` without a
`default_value`) and manages nothing — that is the provenance contract
working, not a regression.

```bash
# 1. Current per-repo state (audit input; re-run after migration to check)
gh api /orgs/TheVoskamps/properties/values --paginate \
  --jq '.[] | [.repository_name, (.properties[] | select(.property_name == "gh-repo-config-mode") | .value // "(unset)")] | @tsv'

# 2. Clear the one live old-vocabulary value (the allowed-values change
#    in step 3 conflicts with a repo still holding "process")
gh api -X PATCH /orgs/TheVoskamps/properties/values \
  -f "repository_names[]=convergence-test" \
  -f "properties[][property_name]=gh-repo-config-mode" \
  -F "properties[][value]=null"

# 3. Redefine the property: required, new vocabulary, default preserving
#    today's behavior (nothing managed unless a repo opts in)
gh api -X PUT /orgs/TheVoskamps/properties/schema/gh-repo-config-mode \
  -f value_type=single_select \
  -F required=true \
  -f default_value=opt-out \
  -f "allowed_values[]=opt-in" \
  -f "allowed_values[]=opt-out"

# 4. Re-flag the canary repo under the new vocabulary
gh api -X PATCH /orgs/TheVoskamps/properties/values \
  -f "repository_names[]=convergence-test" \
  -f "properties[][property_name]=gh-repo-config-mode" \
  -f "properties[][value]=opt-in"

# 5. Retire the org-default property
gh api -X DELETE /orgs/TheVoskamps/properties/schema/gh-repo-config-default

# 6. Dry-run tick: the summary header must name the declared default
#    (opt-out) and convergence-test must be the only converge candidate
gh workflow run sweep.yml --repo TheVoskamps/gh-repo-config -f dry-run=true
```

Steady-state flip, whenever the operator is ready (no code change
involved):

```bash
# 7. Flag every repo that must stay unmanaged (repeat per repo, using
#    the step-1 listing as the audit input)
gh api -X PATCH /orgs/TheVoskamps/properties/values \
  -f "repository_names[]=<repo>" \
  -f "properties[][property_name]=gh-repo-config-mode" \
  -f "properties[][value]=opt-out"

# 8. Flip the org default: unset repos are now managed
gh api -X PUT /orgs/TheVoskamps/properties/schema/gh-repo-config-mode \
  -f value_type=single_select \
  -F required=true \
  -f default_value=opt-in \
  -f "allowed_values[]=opt-in" \
  -f "allowed_values[]=opt-out"

# 9. Dry-run again; review each repo's "would change" lines, then let
#    the daily tick run (or dispatch with dry-run=false)
gh workflow run sweep.yml --repo TheVoskamps/gh-repo-config -f dry-run=true
```

Flip verification: the summary header names `opt-in` as the declared
default, and repos previously reported `skip-unmanaged` appear as
converge candidates. A run whose header still names `opt-out` — or
reports the property undefined or valueless — is a failed flip, not a
quiet success. Repos that stay `skip-unmanaged` under an `opt-in` header
are the ones step 7 flagged `opt-out`, which is the flip working.

## Where this lives in the code

- `src/config/selection.ts` — `SelectionMode`, `DefaultMode`,
  `normalizeMode`, `normalizeDefaultMode`, `resolveManaged` (the truth
  table).
- `src/github/properties.ts` — `readDefaultMode`, which reads the
  schema's `default_value` and reports its provenance.
- `src/stamp/decide.ts` — selection combined with the version-skip.
- `src/sweep.ts` — the header line and
  `describeDefaultModeProvenanceFailure`, the CLI's non-zero-exit
  decision.
