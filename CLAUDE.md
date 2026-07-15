# gh-repo-config

Org-wide repo-configuration converger. TypeScript, Node >=22, ESM
(`"type": "module"`). See `docs/org-repo-configuration-fanout-design.md`
and `docs/org-repo-configuration-fanout-decomposition.md` for the
overall design and issue breakdown.

## Commands

Install (deterministic, from lockfile):

```bash
npm ci
```

Build (TypeScript → `dist/`):

```bash
npm run build
```

Test (runs compiled output under `dist/`, so build first):

```bash
npm run build && npm test
```

## Structure

- `src/` — TypeScript source, compiled to `dist/` by `npm run build`.
  `dist/` is gitignored; tests and `bin/gh-repo-config.js` import from
  `dist/`, not `src/`.
- `bin/gh-repo-config.js` — CLI entry point (`package.json` `bin`).
- `test/` — `node:test` files, run via `node --test test/**/*.test.js`.
- `.github/workflows/release.yml` — publishes a tagged (`v*`) immutable
  GitHub Release with a build-provenance attestation. Bumping the
  release version means editing `package.json`'s `version` and pushing
  a matching `vX.Y.Z` tag; the workflow verifies the two match before
  building.

## Conventions

- Doc comments (TSDoc) on exported symbols explain contracts and *why*,
  not what's evident from the signature.
- GitHub Actions steps in `.github/workflows/` pin third-party actions
  by commit SHA (with a version comment), not by tag.
