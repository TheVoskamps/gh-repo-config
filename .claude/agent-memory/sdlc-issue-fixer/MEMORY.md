# Memory Index

- [Asset provenance claims](project_asset_provenance_claims.md) — gh-repo-config's assets/ "extracted verbatim" claims ARE byte-diffable via a scratch clone of the marketplace repo; #43/PR #48 found five divergent files post-fix (six before adopting an upstream header).
- [Ruleset canonical-authoritative](project_ruleset_canonical_authoritative.md) — protect-main ruleset compare treats per-repo drift as variance to eliminate, not intent to preserve, except bypass actors.
- [YAML render test indentation](feedback_yaml_render_test_indentation.md) — tests over rendered YAML must pin exact indentation (contiguous substring or anchored regex), never .trim()/\s*.
