# Contributing to Portable

Thanks for your interest! A few things make this repo a little different from a typical
open-source project.

## This is a public mirror

This repository is a **public mirror** of an internal monorepo. The mirror contains only the
user-facing / on-device components (the CLI, the local server, the mobile app, and shared
code). The internal hosted services and infrastructure are **not** here.

Because of that:

- **Source paths match upstream**, so your changes can be carried into the internal repo
  cleanly as patches.
- Maintainers periodically **sync** the mirror from upstream (you'll see "Sync from private @
  &lt;sha&gt;" commits). Don't be surprised by them.
- Your merged contributions are imported upstream and then reflected back here on the next
  sync.

## How to contribute

1. **Fork** this repo and create a branch: `git checkout -b feat/short-description`.
2. Make your change. Keep it scoped to one thing.
3. **Build & check locally:**
   ```bash
   bun install
   bun run typecheck
   # run the relevant package tests, e.g.:  cd packages/mobile && bun run test
   ```
4. **Never include secrets.** No real `.env` files, API keys, tokens, or private URLs. CI runs
   a secret scan and will fail the PR.
5. Open a **Pull Request** against `main`. Describe what and why.

## What maintainers do with your PR

After review here, a maintainer turns your commits into patches and applies them to the
internal monorepo (`git format-patch` → `git am`), where they go through internal review + CI
before landing. On the next mirror sync, the result appears back in this repo. You keep
authorship attribution on your commits.

## Scope

Please keep PRs within the published packages (`packages/{shared,api,launcher,mobile}`).
Changes to build/release tooling or anything infrastructure-related are usually maintained
upstream — open an issue first to discuss.

## Code style

- TypeScript strict mode; follow the existing patterns in each package.
- `eslint` + `prettier` are enforced (see the repo config). Run `bun run format` before pushing.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
