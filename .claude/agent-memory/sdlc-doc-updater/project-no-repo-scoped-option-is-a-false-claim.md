---
name: no-repo-scoped-option-is-a-false-claim
description: "\"Neither has a repo-scoped option\" about GitHub Actions/Dependabot secrets is false — both stores have a repo-scoped tier; write the requirement, not a capability claim"
metadata:
  type: project
---

# "No repo-scoped option" is a capability claim, and a false one

GitHub exposes a repo-scoped secret in BOTH stores: the Actions one
(`repos/{o}/{r}/actions/secrets`) and the Dependabot one
(`repos/{o}/{r}/dependabot/secrets`, which returns 200 with an empty
list here, proving the tier exists). Prose that says a secret "has no
repo-scoped option" therefore states something untrue, even when the
requirement it is reaching for — org scope — is right.

**Why:** the requirement here comes from fanout (the payload reaches
managed repos created after provisioning) and from Dependabot-triggered
runs resolving `secrets.*` out of the Dependabot store. Neither reason
is "GitHub won't let you". A reader who believes the capability claim
builds a wrong model of the platform, and nothing in the test suite or
a workflow run ever contradicts it.

**How to apply:** when a doc pass meets a scope statement, write what
the payload requires and why, and let the capability stand as it is —
"provisioned at org scope rather than as the repo-scoped secret each
store also offers". Settle the capability half with the API call, per
[[secret-scope-is-checkable-via-gh-api]].
