# Contributing

Thanks for your interest in the Table Companion Foundry module. Bug reports and pull requests are
welcome.

## What this repository is

This is the **optional** Foundry VTT half of Table Companion. The mobile apps and the backend that
talks to this module (the "agent") are developed separately and are not open source. Everything
in Table Companion works without this module; it only makes setup one click and lets the backend
use Foundry's own dice, compendiums, display popout and (for Knight) character provisioning.

## Getting started

Requirements: Node.js 24 or later.

```sh
npm ci
npm run lint          # ESLint + TypeScript type-check (src, tests and config files)
npm test              # Vitest, no Foundry needed
npm run build         # bundles into dist/, a drop-in module folder
npm run format        # Prettier
```

To try it in Foundry, symlink or copy `dist/` to `Data/modules/table-companion` on a Foundry
v13 or v14 install.

## Before you open a pull request

- `npm run lint`, `npm run format:check`, `npm test` and `npm run build` pass. CI runs the same.
- **Changelog.** Any change to behaviour, security, compatibility, setup, the manifest or the
  release packaging adds a line under `## [Unreleased]` in `CHANGELOG.md`, in the same pull
  request. Pure refactors, tests and documentation do not need one.
- **Tests.** Every procedure and the socket channel have a spec under `test/`. A behaviour change
  comes with a test that fails without it.
- **Fixtures.** Test fixtures describe document *shapes* only. Never commit rulebook text, a real
  world's data, or anything from a player.

## Protocol rules

The module and the backend exchange signed messages over Foundry's `module.table-companion`
socket. Because the backend is maintained separately, a few rules keep old and new versions
working together:

- **The envelope is additive only.** New fields and new procedures are fine; renaming or removing
  one, or changing what an existing field means, is a breaking change and needs the maintainer.
- **Procedure names are a shared contract.** Adding one is an additive capability; changing one
  needs a matching backend release, so open an issue first.
- **`test/vectors/*.json` are frozen.** They are byte-identical copies of the backend's own test
  vectors. Do not edit them; if a change needs new vectors, say so in the pull request.
- **Security posture.** Every backend message is signed and must come from the paired service
  user; the elected Gamemaster's replies are signed too. Please do not weaken these checks.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
