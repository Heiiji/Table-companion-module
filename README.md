# Table Companion (Foundry VTT module)

The optional companion module for the **Table Companion** mobile apps.

Table Companion already works **without** this module — the app connects to your
Foundry world on its own. Installing this module just makes setup one click and
unlocks richer, system-aware features over time.

> This module is a **Foundry-only enhancement**. The app treats Foundry as one
> (optional) external-VTT provider among others it may support later (e.g. Roll20,
> "Let's Role"); those providers have no equivalent module, and this module sits
> outside that provider abstraction. It is never required for a table to work.

## What it does

- **One-click setup** — creates the dedicated `Companion` user with a strong
  password and shows it once to paste into the app.
- **Link status** — a panel showing whether the app is connected to your world
  and, with a current backend, which players have the Table Companion app open
  (in session, app open or offline).
- **Knight character provisioning** — when the app finishes or resumes its guided Knight creator,
  a signed GM-side procedure can create, explicitly adopt, or safely update the matching Foundry
  Actor without name-based guessing or overwriting unrelated equipment.
- **Capability channel** — a small, versioned link the app's backend uses for
  Foundry-native dice (`roll.execute`), your compendiums, the shared-screen popout
  and Knight provisioning. Every backend message is signed (Ed25519) and bound to
  the Foundry user and world it was sent for; the Gamemaster's replies are signed
  too and go to the backend only, never to players' browsers. See **Pairing**
  below.

## Install

In Foundry: **Add-on Modules → Install Module**, then paste this manifest URL:

```
https://github.com/Heiiji/Table-companion-module/releases/latest/download/module.json
```

Enable it in your world, then open **Settings → Configure Settings → Table
Companion** to run setup.

## Setup (one minute)

1. Open **Settings → Configure Settings → Table Companion** (Gamemaster only).
2. Click **Create Companion user** and copy the generated password.
3. Paste that password into the Table Companion app — or scan the QR code shown —
   to link your table.
4. Give the `Companion` user _Observer_ (display) or _Owner_ (edit) permission on
   your players' characters.

> **Important:** never log in to Foundry as the `Companion` user yourself —
> Foundry allows one session per user, so it would disconnect the app.

## Pairing

The first time the app's backend connects while the setup window is open, the
module remembers ("pairs with") its signing key and the Foundry user it logs in
as. After that it only listens to that key, from that user.

- If the backend logs in as the `Companion` user this module created, pairing is
  automatic.
- If it logs in as any other user (for example one you created by hand), setup
  shows a **pairing request** naming that user and a key fingerprint. Click
  **Trust** only if that is the user you linked in the app and the fingerprint
  matches the one Table Companion shows on its Foundry connection screen;
  otherwise **Ignore**. A Gamemaster account, or a user who owns an Actor (a
  player account), can never pair, and one request waits at a time: another
  user's request is dropped with a notice until you decide.
- Each Gamemaster browser signs the replies it sends with its own key, kept per
  world and Foundry user. A browser's key is enrolled with the backend while
  setup is open in it: a second Gamemaster, the same Gamemaster on another
  computer, or a browser whose data was cleared opens setup there once. The
  setup panel says whether this browser's key is enrolled.
- **Reset pairing** forgets the backend's key in this world, rotates this
  browser's reply key for this world, then announces the module again, so a
  connected backend pairs again right away (keep setup open while it does) and
  replaces your previous keys in this world with the new one. A backend that
  keeps a single key (older versions) keeps its record of the previous key until
  you tap **Re-pair** in the Table Companion app; the setup panel says when that
  is needed.

Anyone you grant Foundry's _Modify Configuration Settings_ permission can change
world settings, including this pairing. By default only Assistant GMs and
Gamemasters have it.

The password is shown only once. If you lose it, open setup and click **Reset
password** to generate a new one — no need to delete the user or re-grant
permissions. If the **Table Companion** settings entry is ever missing, a
Gamemaster can open setup from the console with
`game.modules.get("table-companion").api.openSetup()`.

## Compatibility

- **Foundry VTT:** v13 and later (verified on v14; newer versions are accepted, not refused)
- **Game systems:** system-agnostic baseline; Knight 3.58.33 or a later 3.x on Foundry 13 or later has an
  additive, constrained actor-provisioning integration. Exact equipment materialization optionally
  uses Knight Compendium 14.0.1; other/missing versions remain safely partial.
- **Live resources:** on Knight, the current resources a character spends in the app (health, armour,
  energy and the like) are written to its linked Foundry Actor as they change (`actor.resources.v1`),
  and so is deploying or folding the armour (`actorResourcesWearV1`). An armour picked in the app
  replaces the Actor's armour (`actor.items.v1`, `actorItemsArmourV1`), never one carrying evolutions,
  archived data or an active capacity unless the Gamemaster confirms.
- **Fifth Edition live counters:** on dnd5e 6.0.0 or a later 6.x on Foundry 14 or later, a linked
  character's hit points, temporary hit points, spell slots, exhaustion, conditions, death saves
  and inspiration are written from the app (`dnd5e.resources.v1`), which reports back the
  character's prepared maximum hit points.
- **Pathfinder 2e character drafts:** on pf2e 8.6.1 or a later 8.x on Foundry 14, a character made in the
  app can be created in Foundry as a draft — name, ownership, level, and the ancestry, heritage,
  background and class found by slug in the system's compendiums — for the GM to complete there
  (`pf2e.actor.upsert.v1`).
- **Pathfinder 2e character completion:** on the same releases, the character's player completes that
  draft from the app — attribute boosts, skill ranks, lores, feats, spells and equipment found by slug
  in the system's compendiums (`pf2e.actor.complete.v1`). It only adds: nothing already on the Actor is
  removed or rewritten, the level is never changed, an item that would open a choice dialog is skipped
  with a warning, and the completing user must own the Actor in Foundry at the time it applies.
- **Pathfinder 2e live counters:** on pf2e 8.5.1 or a later 8.x on Foundry 14, a linked character's hit points, temporary
  hit points, hero points, conditions and inventory are written from the app (`pf2e.resources.v1`):
  quantities of the items the app mirrors (0 deletes), and items added in the app found by slug in the
  system's equipment compendium, never stacked onto another item. Where the module advertises
  `pf2eSheetWritesV1`, the app also writes the coin purse (per denomination, through pf2e's own
  currency functions; skipped with a warning when a coin stack is not worth exactly one coin of
  one denomination, is sold in lots, is kept in a container, or is a legacy coin pf2e does not count), custom items it created without a compendium entry, and
  spell slots, prepared spells, focus points and innate uses. A condition another item grants or
  locks, the level and the attributes are never touched.
- **Pathfinder 2e prepared statistics:** on the same releases, the app reads a character's or NPC's
  armor class, perception, saves, skills, class DC, spellcasting attack and DC, and strikes (attack
  modifiers with the multiple attack penalty, damage formulas) as pf2e prepared them
  (`pf2e.statistics.v1`), to roll with Foundry's own numbers. Nothing is written or rolled in Foundry.
- **Pathfinder 2e checks and cards:** on pf2e 8.5.1 or a later 8.x on Foundry 14, a check, a
  character's Strike or a spell attack started in the app is rolled by pf2e itself, with Foundry's own
  card (`pf2e.check.v1`), and a spell cast or an item used in the app posts the card pf2e posts from
  the sheet (`pf2e.card.v1`). Dialogs never open, no ammunition is spent, and the cards spend no slot,
  focus point or item: the app writes those counters itself. An NPC's Strike stays on the app's engine.
  A Strike or spell attack against a target answers the degree pf2e read from the target, never its
  AC, and whether pf2e's « Show Check Outcomes » setting shows it to players.
- **Knight prepared statistics:** on the same Knight releases, the app reads a Knight character's or
  non-player Actor's aspects, characteristics and overdrives, health, hope, armour, energy, contacts,
  force field, defense, reaction and initiative as the Knight system prepared them
  (`knight.statistics.v1`), to show Foundry's own numbers. Nothing is written or rolled in Foundry.
- **Knight attacks:** on the same Knight releases, a weapon attack started in the app is rolled by the
  Knight system itself (`knight.attack.v1`): the native card with its targets, hit or miss, effects
  and damage / violence buttons, and the result sent back to the app. The app composes the dice pool;
  the dialog's own extras (module damage bonuses and the like) are not applied, and costs are spent by
  the app. Targets must be tokens on the scene the Gamemaster is viewing; barrage weapons, which have
  no attack roll, stay on the app's engine.
- **Knight tests:** on the same Knight releases, a test started in the app without a weapon is rolled
  by the Knight system itself (`knight.test.v1`): the native card with its successes and, when a
  difficulty is set, its verdict, and the dice sent back to the app. Costs are spent by the app.
- **Combat mirror:** on every system, the app's combat (combatants, initiative, current turn) is
  mirrored one way into a Foundry Combat (`combat.sync.v1`).
- **Languages:** English, Français
- **Connection:** Foundry must be served over HTTPS (or opened on localhost): the module verifies the
  backend's signatures with the browser's WebCrypto, which plain http does not provide.

## Developing

```bash
npm ci
npm run build      # bundles to dist/ (a drop-in module folder)
npm run watch      # rebuild on change
npm run lint       # eslint + tsc --noEmit
npm test           # vitest, no Foundry needed
```

Symlink `dist/` into your Foundry `Data/modules/table-companion` for local
testing. The public API is exposed at `game.modules.get("table-companion").api`.
See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE). The release also bundles
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT); see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Table Companion is an independent project, not affiliated with or endorsed by
Foundry Gaming LLC (Foundry Virtual Tabletop), Antre Monde Éditions (Knight),
Paizo Inc. (Pathfinder) or Wizards of the Coast (Dungeons & Dragons). Those names
are used only to say what the module works with.
