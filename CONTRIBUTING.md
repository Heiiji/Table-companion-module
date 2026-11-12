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
npm run test:coverage # Vitest with the coverage floor (vitest.config.ts) CI enforces
npm run build         # bundles into dist/, a drop-in module folder
npm run format        # Prettier
```

To try it in Foundry, symlink or copy `dist/` to `Data/modules/table-companion` on a Foundry
v13 or v14 install.

## Before you open a pull request

- `npm run format:check`, `npm run lint`, `npm run test:coverage` and `npm run build` pass, as
  CI runs them after `npm ci`. Plain `npm test` skips the coverage floor.
- **Changelog.** Any change to behaviour, security, compatibility, setup, the manifest or the
  release packaging adds a line under `## [Unreleased]` in `CHANGELOG.md`, in the same pull
  request. Pure refactors, tests and documentation do not need one.
- **Tests.** Every procedure and the socket channel have a spec under `test/`. A behaviour change
  comes with a test that fails without it.
- **Versions.** `package.json`, `package-lock.json` and `module.json` carry the same version (CI
  compares them); only a release changes it.
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

## Error codes

A refused request answers an `rpc.error` whose `code` is one of `RpcErrorCode`
(`src/rpc/errors.ts`). The backend and the apps switch on these codes: never rename or merge one;
a new code is an additive change.

| Code | Meaning |
|---|---|
| `unknown_procedure` | No procedure of that name is registered in this world (system or version not supported). |
| `procedure_failed` | The procedure threw an unexpected error; the detail stays in the Gamemaster's browser log. |
| `procedure_timeout` | The procedure did not finish within the request deadline. |
| `payload_too_large` | The response would exceed the envelope size cap. |
| `invalid_args` | The payload failed the procedure's validation. |
| `permission_denied` | The responder is not a Gamemaster, or the paired user lacks the ownership the read needs. |
| `unsupported_runtime` | This Foundry or game-system version, or a system API the procedure needs, is not available. |
| `not_found` | The compendium entry does not exist or is not visible to the paired user (deliberately indistinguishable). |
| `actor_not_found` | The Actor the request assigns does not exist. |
| `binding_collision` | More than one Actor carries the same Table Companion binding. |
| `binding_conflict` | The binding or the expected Actor points at a different Actor than the request. |
| `binding_lost` | Another table took this Actor over from the request's table and character; nothing is written (a Knight resources write may take it back with `reclaim`). |
| `deleted_link` | The previously linked Actor no longer exists. |
| `stale_revision` | The Actor already carries a newer revision than the request. |
| `revision_conflict` | The same revision was sent again with different content. |
| `name_conflict` | The Actor was renamed in Foundry since the app last saw it; nothing is written. |
| `base_conflict` | A field the request writes was edited in Foundry since the app's `base`; nothing is written. |
| `level_mismatch` | A Pathfinder 2e completion whose level differs from the Actor's; nothing is written. |
| `item_conflict` | A Knight Item moved, was renamed or is of another kind in Foundry; nothing is written. |
| `item_missing` | The Knight Item the request updates is gone. |
| `armour_guarded` | The Knight armour an add would replace holds applied evolutions, archived data or an active capacity, and the add is not forced; nothing is written. |
| `wear_conflict` | The Knight armour's wear moved in Foundry first, a capacity holds the ascension, or there is no armour to deploy; nothing is written. |
| `knight_api_missing` | The Knight system's roller is not available. |
| `weapon_not_found` | No weapon on the Actor is bound to the attack's entry. |
| `weapon_unsupported` | The Knight weapon has no attack roll (an active barrage). |
| `attack_card_timeout` | The Knight attack card did not complete in time; a late card is still stamped with its result. |
| `actor_unsupported` | The Knight Actor cannot roll this test itself (a vehicle: its tests are its pilot's). |
| `test_card_timeout` | The Knight test card did not appear in time after the roll. |
| `statistic_not_found` | The Pathfinder 2e Actor has no statistic with the check's slug. |
| `strike_not_found` | The Pathfinder 2e Actor has no shown strike with that item and slug. |
| `spell_not_found` | The Pathfinder 2e spell is not on the Actor (or not in that spellcasting entry), or pf2e built no card for it. |
| `item_not_found` | The Pathfinder 2e item whose card is asked for is not on the Actor, or is not a kind with a card. |
| `roll_refused` | pf2e did not roll, or Foundry did not create the card; nothing was posted. |
| `invalid_request` | An actor image request failed validation (an op, an id, a size, or a chunk out of order). |
| `upload_unknown` | The actor image upload is gone (expired, replaced by a newer one, or never begun). |
| `invalid_image` | The actor image's length, SHA-256 or JPEG signature does not match. |
| `upload_failed` | Foundry refused the image file or its directory. |

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
