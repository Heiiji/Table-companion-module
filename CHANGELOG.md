# Changelog

All notable changes to this module are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.33.0] - 2026-11-14

### Fixed
- A Knight Actor no longer ends with two armour Items when a companion app adds the armour
  (`actor.items.v1`) before the character's approval runs `actor.upsert.v1`. The approval's
  equipment step now treats any `armure` Item of the Actor as the armour slot: the same armour
  (by either lane's flag, or for an Item made by hand, the compendium document Foundry recorded
  it was copied from) is adopted, keeping every flag it has; another armour is replaced in place
  (`equipment_armour_replaced:<id>`), unless it holds applied evolutions, archives or an active
  capacity (`equipment_armour_guarded:<id>`, nothing deleted). An `actor.items.v1` armour add
  likewise adopts the equipment step's armour instead of replacing it.
- An Actor that already holds two armour Items made by this module for the same armour, with the
  same data, is repaired by the next approval or armour add: the one carrying the app's entry id
  (else the oldest) is kept with both sets of flags, the copy is deleted
  (`armour_twins_merged:<kept>:<deleted>`). Any other set of several armours is left untouched and
  reported (`equipment_armour_conflict:<ids>`; the armour add still answers `item_conflict`).

## [0.32.0] - 2026-11-14

### Fixed
- A copy of a linked Actor made with Foundry's « Duplicate » no longer blocks every write for its
  character with `binding_collision`. A request that names its Actor (`expectedActorId`) is served
  on that Actor when it is one of those carrying the link; a request that names none is served on
  the original when Foundry recorded the copy's source (`_stats.duplicateSource`), and is still
  refused otherwise.
- A new Actor created carrying a link another Actor already holds — a « Duplicate », or an import
  of a linked Actor — loses this module's flags before it is saved (one warning in the browser
  console). The original is never touched, and the module's own Actor creation is unaffected.
- A copy made before this version, which still carries its original's link, no longer refuses
  every write for the new character it is used for (`binding_conflict`). When a live write
  (`actor.resources.v1`, `actor.items.v1`, `dnd5e.resources.v1`, `pf2e.resources.v1`) names that
  copy for another character of the same table, and Foundry recorded it as a duplicate of an Actor
  that still carries the same link, the copy's Table Companion flags are removed (one warning in
  the browser console) and the write is served as for any unlinked Actor. The original is never
  touched; any other case, including another table's link, is answered as before.

## [0.31.0] - 2026-11-13

### Changed
- Taking a Knight Actor back (`reclaim: true` on `actor.resources.v1`) takes the binding back and
  writes no value: the reclaiming table then reads Foundry's current values, so nothing the other
  table played is overwritten. A reclaim row may now carry no value; the values or name an older
  app still sends with one are ignored and the result warns `reclaim_values_ignored`. Advertised
  as `bindingReclaimV2`, beside `bindingTakeoverV1`.

## [0.30.0] - 2026-11-12

### Added
- A chat card the companion apps cancelled (undone, rerolled or removed by the GM) stays in the
  chat, greyed under a « Cancelled », « Rerolled » or « Removed by the GM » banner.
- The Knight `sheet` group of `actor.resources.v1` takes the unspent Glory (`gloryCurrent`,
  advertised as `knightSheetGloryV1`). It is written as one « other expense » line named
  « Table Companion » in the character's Glory table, whose cost moves with each change (a refund
  lowers it); the Glory total and the Items' prices are left alone. A line renamed in Foundry is
  kept, a deleted one is created again at the next change, and a change Foundry does not show is
  put back and reported as `stat_clamped:gloryCurrent`.
- The Knight write lanes (`actor.resources.v1`, `actor.items.v1`, `actor.upsert.v1`) take over an
  Actor another table holds, advertised as `bindingTakeoverV1`: the binding records the tables it
  was taken from (`previous`, the 16 latest), the other table's records of those lanes are
  dropped, and the result warns `binding_taken_over`. A table that lost an Actor is answered the
  new error `binding_lost` on every Knight lane (and `actor.upsert.v1` / `npc.upsert.v1` no longer
  create a second Actor for it) until it takes the Actor back with `reclaim: true` on
  `actor.resources.v1`. Another character of the same table, and the other systems' lanes, still
  answer `binding_conflict`.

## [0.29.0] - 2026-11-12

### Added
- A Hero Point reroll of a Pathfinder 2e check Foundry rolled (`pf2e.reroll.v1`, signed-only, on the
  check lane's releases with pf2e's `Check.rerollFromMessage`) is now rerolled by Foundry: its card is
  replaced by the system's own reroll card, with the same author and visibility, and Foundry spends no
  Hero Point (the app spends it).
- The damage or critical damage of a Pathfinder 2e Strike, the damage of a spell and a consumable's
  effect that follow a card Foundry rolled or posted for the app (`pf2e.followup.v1`, signed-only, on
  the check lane's releases) are now rolled by pf2e itself, with its own damage card, which keeps the
  original card's author and visibility. Dialogs never open and nothing is spent: no ammunition, slot
  or item (a consumable's use card is built without taking one from its quantity). An item card of a
  consumable keeps its effect in the card's stamp, so the effect can still be rolled once the item is
  gone.
- A Pathfinder 2e check (`pf2e.check.v1`) takes an optional `dcVisible`: `false` hides the app's DC
  from players on Foundry's card (the Gamemaster still reads the DC and the margin).
- The replies of a Pathfinder 2e check (`pf2e.check.v1`) and of its Hero Point reroll
  (`pf2e.reroll.v1`) now tell the Gamemaster's device the DC or AC pf2e judged the roll against
  (`dcValue`, null when there is none), read from the card pf2e keeps; the module's own stamp on the
  card does not copy it.

## [0.28.0] - 2026-11-12

### Added
- The live resources write of a Knight character (`actor.resources.v1`) takes an optional `sheet`
  group, advertised as `knightSheetWritesV1` with the prepared statistics read: aspects and
  characteristics in Foundry's prepared values (the stored base is solved from Knight's own
  formula, so wounds and experience purchases count once), unspent experience (written on the
  experience total), Glory total, age, nickname and major motivation, each guarded by `base.sheet`.
  A value Foundry cannot prepare at its target is put back and reported as `stat_clamped`; an
  overridden or unreadable one is skipped and reported.

### Fixed
- The live resources write now checks that its update landed: when Foundry refuses the update (which it
  does without an error), the write answers `procedure_failed` and records nothing, instead of
  reporting values that never landed.

## [0.27.0] - 2026-11-12

### Added
- The prepared statistics read (`pf2e.statistics.v1`) carries the actor's maximum Hit Points as
  Foundry computes them (feats and effects included), as an optional `hp.max`.

### Fixed
- A Gamemaster-only roll or card posted for a player's character is no longer readable by that
  player in Foundry's chat: the Gamemaster now authors it. A player's own private Gamemaster roll
  still shows to that player, as in Foundry.
- A spell card asked at a rank below the spell's own rank (a focus spell or a cantrip) no longer
  hangs the Gamemaster's browser: the card is posted at the spell's rank.

## [0.26.1] - 2026-11-11

### Fixed
- A Knight character written from the app no longer gets the app's free-text origin in its
  `system.origin`, which the Knight system reads as the being's nature (`humain`, `anatheme`,
  `autre`); a character an earlier version had written this way gets `humain` back at its next
  approved revision, unless its origin was changed in Foundry since.
- An approved Knight character update now really keeps the fields the Gamemaster changed in Foundry
  since the app's last write, and the NPC and resources writes again accept a base read before
  their own last write landed: the record of what was written is read the way Foundry stores it. A
  `dnd5e.resources.v1` replay no longer answers an effective hit-point maximum the Actor no longer has.

## [0.26.0] - 2026-11-11

### Added
- Knight attacks (`knight.attack.v1`) take an optional `itemId`, the weapon's Foundry Item id, so a
  weapon created in Foundry can be rolled when no Item carries the app's `entryId`; advertised by the
  capability token `knightAttackItemIdV1`.

### Fixed
- Unlinking a world in the app and linking it again no longer duplicates its NPCs nor blocks writes to its
  characters: an Actor is bound to its character by table and character, whatever the world link's id, and a
  re-send of an already applied revision under the new link replays instead of conflicting.
- On Foundry 14, the Knight character, Knight NPC and Pathfinder 2e character upserts (`actor.upsert.v1`,
  `npc.upsert.v1`, `pf2e.actor.upsert.v1`) no longer lose their whole update to Foundry refusing the
  ownership change: the ownership map is now replaced with Foundry 14's `ForcedReplacement`, and a lane
  answers `procedure_failed` instead of success when Foundry still did not apply its update.
- A Knight Warrior armour whose « type » is active (in or out of conflict) is now guarded against an
  unconfirmed replacement (`armour_guarded`).
- A Knight character created by `actor.upsert.v1` now has a linked prototype token, so damage dealt to
  its token on a scene lands on the character itself.
- Knight attacks (`knight.attack.v1`) now roll a ranged weapon with the « barrage » effect as a normal
  attack, the barrage option off as in the sheet's roll dialog, instead of refusing it.

## [0.25.0] - 2026-11-11

### Added
- Pathfinder 2e checks (`pf2e.check.v1`) answer the degree of a Strike or spell attack that pf2e
  read from its target when the app sent no DC, with two new reply keys: `degreeSource` (`dc`,
  `target` or null) and `resultsShown` (pf2e's « Show Check Outcomes » world setting). The target's
  AC never leaves Foundry.
- Pathfinder 2e checks (`pf2e.check.v1`) roll a player's Strike or spell attack against that player's
  own target, or against none, never the Gamemaster's; a Gamemaster's own roll from the app still
  uses the Gamemaster's targets. The Gamemaster's target selection is left as it was.
- Knight armour from the app (`actor.items.v1`, new `armour` kind, advertised by the new
  `actorItemsArmourV1` capability): an armour picked in the app replaces the character's armour in
  Foundry, copied from Knight Compendium 14.0.1 (now covering all 17 armours) or built from the app's
  fields. Modules and weapons are kept. An armour carrying applied evolutions, archived data or an
  active capacity is refused (`armour_guarded`) unless the Gamemaster confirms the replacement
  (`force`, reported as `armour_replaced_guarded`).
- Knight armour deploy and fold from the app (`actor.resources.v1` `wear` / `previousWear`, advertised
  by the new `actorResourcesWearV1` capability): a compare-and-set on the wear Foundry shows
  (`wear_conflict` when it moved first, a capacity holds the ascension, or there is no armour);
  a generation 4 armour stays worn (`wear_forced`).

### Changed
- Fifth Edition live counters (`dnd5e.resources.v1`) now run on dnd5e 6.0.0 or a later 6.x on
  Foundry 14 or later (previously 6.1.0, a release that is not published), checked against dnd5e
  6.0.6. An exhaustion change is recorded as written even before dnd5e's exhaustion effect catches
  up, so a following change is no longer refused as a conflict.

## [0.24.0] - 2026-11-11

### Added
- Knight tests from the app (`knight.test.v1`, signed-only): a test with no weapon is rolled by the
  Knight system itself, so the native card shows its successes, Exploit or critical failure and, with a
  difficulty, its verdict; the dice go back to the app. Nothing is spent in Foundry.
- Knight prepared statistics (`knight.statistics.v1`, signed-only read): the app reads, for up to 32
  Actors at once, the aspects, characteristics and overdrives, pools, force field, defense, reaction
  and initiative as the Knight system prepared them, so it shows Foundry's own numbers. Nothing is
  written or rolled in Foundry.
- Knight live counters (`actor.resources.v1`) also write non-player Actors (`pnj`, `creature`, `bande`,
  `vehicule`), advertised by the new `knightNpcResourcesV1` capability: health, armour and energy on
  the Actor's own pools, clamped to their prepared maximum; `npc.upsert.v1` pools may leave out
  `current` so a stat edit keeps damage dealt in Foundry, NPCs it creates have linked tokens, the
  backend's Companion user keeps Observer on them (players unchanged), and « Share » also covers
  hidden NPCs the app created.

### Fixed
- Knight attacks from the app (`knight.attack.v1`): a card posted as a self or blind roll is now also
  whispered to the backend's Companion user, so the app can still read its result when the reply was
  lost.
- Knight character provisioning (`actor.upsert.v1`): an approved character written onto an Actor
  already created for it keeps each field the Gamemaster changed in Foundry since the module last
  wrote it, and reports how many with one `foundry_kept:<n>` warning.

## [0.23.0] - 2026-11-11

### Added
- Pathfinder 2e checks run by Foundry (`pf2e.check.v1`, signed-only, pf2e 8.5.1 or a later 8.x on
  Foundry 14): a Perception, save, skill or lore check, a character's Strike at any multiple-attack
  step, or a spell attack started in the app is rolled by pf2e itself in the Gamemaster's browser, so
  Foundry posts its own card (modifier breakdown, roll options, degree of success, damage buttons) and
  the dice, total and degree go back to the app. No dialog opens and no ammunition is spent; a retry
  never rolls twice. An NPC's Strike stays on the app's engine.
- Pathfinder 2e spell and item cards (`pf2e.card.v1`, signed-only, same releases): the card of a spell
  cast or an item used in the app, as pf2e posts it from the sheet (heightened to the cast rank). It
  spends nothing in Foundry: the app updates the slot, focus point or quantity itself, once.

## [0.22.1] - 2026-11-11

### Fixed
- Character images from the app (`actor.image.v1`): on a Knight world, the icon the Knight system
  gives a new Actor is now recognised as a placeholder, so an image chosen in the app replaces it
  instead of being set aside.

## [0.22.0] - 2026-11-10

### Added
- Character images from the app (`actor.image.v1`, every game system, signed-only): a Gamemaster's
  browser now saves a character image sent from the app (a JPEG of at most 1 MiB, received in chunks
  and checked against its length, SHA-256 and JPEG signature) into the world's
  `table-companion/portraits` folder, named after the Actor and the image's hash, and sets it as that
  Actor's image; it can also reset the image to the system's default artwork. Only a world Actor's
  `img` is written (never its prototype token), and no other folder or file name can be requested.

## [0.21.0] - 2026-11-09

### Added
- Pathfinder 2e live counters (`pf2e.resources.v1`) also write an imported NPC (`actorType: "npc"`),
  advertised by the new `pf2eNpcWritesV1` capability: hit points, temporary hit points, conditions,
  item quantities and spellcasting (slots, prepared spells, the NPC's stored focus pool, innate uses).
  Hero points, the coin purse and item adds are refused for an NPC.
- Pathfinder 2e live counters (`pf2e.resources.v1`) take three optional groups, advertised by the
  new `pf2eSheetWritesV1` capability: the coin purse (`coins`, a target total per denomination,
  written through pf2e's own currency functions and skipped with `coins_unaddressable` when a coin
  stack is not plain), custom items created in the app without a compendium entry (`customAdds`,
  idempotent by their key), and spellcasting (`spellcasting`: slot values and prepared spells per
  entry and rank, focus points, innate uses, each clamped to its maximum with a warning). `base`
  takes `coins` and `spellcasting`. An older module refuses the new keys; apps send them only when
  the capability is advertised.
- Pathfinder 2e prepared statistics (`pf2e.statistics.v1`, a signed read on pf2e 8.5.1 or a later
  8.x on Foundry 14): a character's or NPC's armor class, perception, saves, skills and lores, class DC,
  spellcasting attack and DC, and strikes with their three multiple-attack-penalty modifiers and
  damage formulas, as pf2e prepared them, so the app rolls with Foundry's own numbers. It never
  writes, rolls or posts to chat.

### Fixed
- An accidentally elevated Companion service user no longer blocks human Gamemasters from
  answering requests, even when Foundry selects it as the active GM.

### Changed
- Release builds now enforce the same formatting, coverage and runtime-dependency audit gates as
  CI before publishing the module.

### Fixed
- Pathfinder 2e live counters: prepared spell slots are compared and written in pf2e's own order
  (prepared spells first, empty slots last), so a retry after a write that failed part-way no
  longer reports its own earlier slot write as a `base_conflict`; a change made in Foundry in
  between is still refused.

### Security
- Projector portraits reject control-character-obfuscated URLs and mixed-slash network paths,
  keeping the HTTPS-or-local image restriction intact after browser URL normalization. The
  projection still renders without the rejected image.

## [0.20.0] - 2026-11-05

### Added
- Setup: a Gamemaster opening a world that is not linked yet (no Companion user, or no app paired)
  is offered the setup once per session, in a prompt they can dismiss.
- Reply signing works from several Gamemaster browsers: each one pairs its own reply key with the
  backend while its setup is open (a second Gamemaster, the same Gamemaster on another computer, or
  a browser whose data was cleared), keys are kept per world and user so Reset pairing in one world
  no longer changes another's, and a reply is signed even if another Gamemaster took over while it
  ran. Needs a backend that lists its enrolled keys; an older one keeps a single key as before.
- Live and provisioning writes (Knight `actor.resources.v1`, `actor.upsert.v1` and `npc.upsert.v1`,
  `dnd5e.resources.v1`, `pf2e.resources.v1`) take an optional `base`: the values the app last saw.
  When a field the request writes was edited in Foundry since, the whole request is refused with
  `base_conflict` and nothing is written; without `base` nothing changes. A value the module itself
  wrote last is not a conflict, and the module advertises `writeBaseV1` so apps send `base` only to
  a build that takes it.

### Changed
- Setup: Reset password and Reset pairing ask for confirmation first and say what the app will
  need afterwards; the password window and the pairing QR code use the Companion user's current
  name when the Gamemaster renamed it.
- An expected refusal (`stale_revision`, `base_conflict`, `invalid_args`, …) is logged as one
  information line instead of a console error with a stack; unexpected failures stay errors.
- System writes now stop at the system major they were verified against: Knight 3.x, Fifth Edition
  6.x and Pathfinder 2e 8.x. A later major answers `unsupported_runtime` (the app keeps the write
  queued) and its procedures are not advertised, until a module update verifies it; reads are
  unchanged.

### Security
- Setup no longer mistakes another account for the Companion user in a world set up before the
  module recorded it: a player or Gamemaster merely named "Companion" is never selected, and the
  module's own flag counts only on a single non-Gamemaster account that owns no Actor, so Reset
  password can no longer reset a player's password. A Gamemaster is counted as present by user id,
  so a renamed Companion user raised to Gamemaster no longer counts as one.
- The responder election and Knight attacks also tell the Companion user by id: a Gamemaster or
  player merely named "Companion" can answer the backend, author an attack card and be counted as
  a player, and no longer receives Gamemaster-only attack cards.
- A message from a user other than the paired backend user is dropped before its signature is
  checked, so a flood of such messages costs no cryptography on the Gamemaster's browser.
- Knight: `actor.items.v1` refuses weapon damage and violence dice with a negative or oversized
  count (at most 1000) or faces outside 1–1000, so a stored weapon can no longer freeze the next
  damage roll.
- Knight: adding a module or weapon from a live world Item or compendium copies it only when the
  paired service user may observe that Item or pack, as the compendium lanes already require;
  otherwise the Item is built from the app's fields.
- Dice: `roll.execute` refuses dice whose count or faces resolve only while rolling (`(N)d6`,
  `1d(N)`) and budgets the dice inside parentheses, functions and pools, so an oversized roll can
  no longer slip past the dice limit and freeze the Gamemaster's browser.
- Knight: the description, limited description, history and minor motivations written from the
  companion app are now escaped into paragraphs before they reach the character sheet, which
  renders them as HTML; markup typed in the app shows as text instead of running in the browser.

### Fixed
- Packaging: a release's manifest downloads that release's own zip instead of the latest one, so
  installing from an older release's manifest installs that release; `module.js` no longer
  references a source map the zip does not carry.
- French: the setup texts follow French typography (a no-break space before « : ; ? ! » and inside
  guillemets, typographic apostrophes), so a colon or a question mark no longer wraps onto a line
  of its own.
- Knight: an attack retried with the same event while its card is still on its way now waits for
  that card instead of rolling a second attack.
- Pathfinder 2e: a character creation retried after its ancestry, heritage, background and class
  were already embedded no longer embeds them a second time.
- Display: a show followed quickly by a clear, or two shows in a row, no longer leave a projector
  popout open that no later clear can close; shows and clears now run one after another.
- With the Gamemaster's world open in two tabs, a request whose copy reaches the second tab after
  the first tab answered is no longer run a second time; every tab of the browser records the
  requests already handled.
- Knight: equipment from the companion app no longer deletes an armour, weapon or module before its
  replacement can be imported; with the Knight Compendium missing, disabled or at another version,
  or a replacement that cannot be fetched, the existing Items stay and the result is `partial`.
- Knight: an attack answers as soon as its card lands, even when the Gamemaster's Foundry tab is
  in the background (it no longer polls on a timer the browser slows down); a roll that never
  finishes no longer blocks every later attack until reload; and an attack whose roller posted no
  card no longer takes over a different roll the Gamemaster makes from that character's sheet.
- Fewer server round trips on large writes: Pathfinder 2e character completion and catalog adds
  fetch each compendium's documents in one request, and Knight equipment fetches one request per
  compendium; Knight minor motivations are updated and created in one request each, and an
  unchanged one is no longer rewritten.
- When the last Gamemaster closes the Foundry tab that answers the backend, the module tells the
  backend no Gamemaster is left on the way out, so app calls stop waiting for Foundry sooner.
- Compendium search: the index warm-up now also runs for a world paired after Foundry loaded, and
  only in the Gamemaster tab that answers the backend instead of in every Gamemaster tab.

## [0.19.1] - 2026-11-04

### Fixed
- Pathfinder 2e: synchronize character resources on pf2e 8.5.1 and later; character creation and completion still require pf2e 8.6.1.

## [0.19.0] - 2026-11-04

### Added
- Knight: a weapon attack started in the companion app can be run by the Knight system's own roller
  through the new signed-only `knight.attack.v1`: the native attack card appears with its targets
  (the player's own targets, else the app's, else the Gamemaster's), the hit or miss against each
  one, the weapon's effects and the damage and violence buttons, authored by the character's player
  and shown with the app's roll visibility. The result is returned to the app and stored on the card;
  a retry never rolls twice. Barrage weapons, which have no attack roll, are refused and stay on
  the app's own engine. Damage and violence cards rolled from it are tagged with the attack.

## [0.18.1] - 2026-11-04

### Changed
- Knight: rolls posted by the companion app show in the chat as the system's own roll card (even
  dice as successes, the success count, Exploit / Échec critique) instead of Foundry's generic dice
  card. Display only; the stored message is unchanged.

## [0.18.0] - 2026-11-04

### Added
- Knight: the companion app can add, update and remove the modules and weapons of a linked character
  (name, level, energy, slots, activation, a single magazine's charges, weapon attack profiles), one
  operation per request, through the new signed-only `actor.items.v1`. An Item is copied from the
  world, a compendium or Knight Compendium 14.0.1 when it can be, and built from the app's fields
  otherwise (warning `item_built`); an edit Foundry made first answers `item_conflict` and overwrites
  nothing. Items it creates carry an `entryId` flag and are left alone by `actor.upsert.v1`.

## [0.17.0] - 2026-11-03

### Added
- Fifth Edition: `dnd5e.resources.v1` accepts `hpTempMax`, written to the character's temporary
  maximum hit points (a long rest in the app resets it to 0).

### Changed
- Fifth Edition: on a world playing the 2014 rules, the exhaustion level is left to Foundry (warning
  `exhaustion_unavailable:legacy_rules`); the module advertises `dnd5eRulesModern` on a 2024-rules
  world.
- Property removals use Foundry 14's replacement for the deprecated `-=` syntax when it is
  available.

### Fixed
- Pathfinder 2e: completing a character twice no longer duplicates its spellcasting entry and spells
  when the request carries no entry slug; the entry is keyed on its tradition and kind.
- Two requests of the same procedure on the same character, Actor or combat no longer run at the
  same time; the second (such as a retry after a timeout) waits for the first to finish.

## [0.16.0] - 2026-11-03

### Added
- Fifth Edition: the companion app can write hit points, temporary hit points, spell slots,
  exhaustion, conditions, death saves and inspiration to a linked character (dnd5e 6.1 or later on
  Foundry 14), through the new signed-only `dnd5e.resources.v1`. Its result reports the character's
  prepared maximum hit points (`hpEffectiveMax`), which the stored actor does not hold.
- Pathfinder 2e: a character draft created from the apps — name, ownership, level, and the
  ancestry, heritage, background and class found by slug in the system's compendiums (an item that
  would open a choice dialog is skipped with a warning) — through the new signed-only
  `pf2e.actor.upsert.v1` (pf2e 8.6.1 or later on Foundry 14).
- Pathfinder 2e: the character's player can complete a character draft made from the apps — attribute
  boosts, skill ranks, lores, feats, spells and equipment found by slug in the system's compendiums —
  through the new signed-only `pf2e.actor.complete.v1` (same pf2e and Foundry floor). Additive only;
  refused unless the completing user owns the Actor and the build's level matches the Actor's.
- Pathfinder 2e: the companion app can write hit points, temporary hit points, hero points,
  conditions and inventory (item quantities, removals, and items added by slug from the system's
  equipment compendium) to a linked character, through the new signed-only `pf2e.resources.v1`
  (pf2e 8.6.1 or later on Foundry 14). Conditions granted or locked by another item are never touched.
- `test/vectors/pf2e-actor-complete-vectors.json`, shared byte for byte with the backend, pins the
  `pf2e.actor.complete.v1` contract: accepted and refused requests, thrown error words, result shape.
- `actor.resources.v1` may carry the character's `name`, alone or with resource values; an optional
  `previousName` makes it a compare-and-set, refused with `name_conflict` (nothing written) when the
  Actor was renamed in Foundry first. The module advertises `actorResourcesNameV1` alongside
  `actor.resources.v1`.

### Changed
- `actor.resources.v1` no longer re-writes a value the Actor already holds (a capped re-send included);
  only its result record is updated.
- `actor.resources.v1` leaves the Actor untouched, result record included, when a new request re-sends
  the values it already recorded; the record update no longer echoes back as a change.
- Knight character provisioning and resource sync accept Knight 3.58.33 or any later release (was
  3.58.33 to 3.58.35); later releases change only data preparation the module does not touch.
- The setup panel lists each procedure withheld on this world, with the reason.
- Knight character provisioning (`actor.upsert.v1`) accepts current resource values from 0 to 9 999,
  the same range as `actor.resources.v1` (was up to 100 000).

### Fixed
- Knight NPC provisioning (`npc.upsert.v1`) sets the token disposition only when it creates the
  Actor: a GM's token disposition set in Foundry is kept on every later update.
- On a Foundry served over plain http, the module no longer waits silently: it reports once to the
  Gamemaster, and in setup, that a secure connection (HTTPS, or localhost) is required to verify the
  backend's signatures.
- `combat.sync.v1` no longer erases an initiative rolled in Foundry when the app's entry has none yet.
- `combat.sync.v1` no longer lets Foundry emit its own turn change, with turn hooks, when combatants
  join or leave: the turn is cleared quietly first, then set once.
- On a plain-http world (no Web Locks), two browser tabs of the same Gamemaster no longer both answer
  a request: the first tab to claim it in `localStorage` answers, the others stay silent.
- Knight Armour and Energy now land where Foundry reads them: a generation-4 or later armour is always
  worn in Foundry, whatever the sheet's worn-gear selector stores, and a missing selector reads as the
  civilian outfit (the Knight default), no longer as the armour. A selector of armour or ascension
  with no armour item on the Actor also reads as the civilian outfit, as Foundry reads it; and
  `actor.upsert.v1` writes current resources after its equipment import, on the gear that import
  leaves worn.
- Knight character provisioning (`actor.upsert.v1`) clamps a current resource to the sheet's prepared
  maximum, with a `resource_clamped` warning, as `actor.resources.v1` already did; `npc.upsert.v1`
  clamps each pool's current to its maximum the same way.

### Security
- Pairing refuses a request from a Foundry user who owns an Actor (a player account) and tells the
  Gamemaster why; while one request waits, another user's request is dropped with a notice instead of
  replacing it. Setup shows the waiting request's key fingerprint, to compare with the one Table
  Companion shows before trusting it.

## [0.15.1] - 2026-10-29

### Changed
- The combat mirror (`combat.sync.v1`) is no longer advertised on Pathfinder 2e and Cyberpunk RED
  worlds, where the backend never writes; setup names the reason instead.

## [0.15.0] - 2026-10-29

### Added
- **Live Knight resources.** A new signed `actor.resources.v1` procedure lets the backend push a
  player character's current Health, Hope, Armour, Energy, Heroism and Contacts to its linked
  Knight Actor after every edit in the app. It writes only the Actor linked to that character, or
  for a character imported from Foundry the unlinked Actor it came from, clamps each value to the sheet's maximum and skips a value the Actor has no field for.
- **Fights started in the app appear in Foundry.** A new signed `combat.sync.v1` procedure, on every
  game system from Foundry 13, lets the backend mirror the app's combat into a Foundry Combat on the
  scene the Gamemaster is viewing: combatants (linked to their actor and its token on that scene when
  there is one), initiative, hidden state, round and current turn, and deletes that Combat when the
  fight ends. Combatants the Gamemaster adds in Foundry are left alone, and turn changes are set
  directly so no system turn effect runs twice. Changes made in Foundry are not sent back to the app.

### Fixed
- Character provisioning now writes current Armour and Energy on the gear the character wears
  (armour, Guardian or civilian outfit) instead of always the armour slot.

## [0.14.0] - 2026-10-23

### Added
- **Setup shows how many player characters Companion can see, and shares the rest.** A « Player
  characters » row reads « Companion can see N of M » and names the characters the Companion user
  cannot observe, which the app cannot show. A Gamemaster-only « Share with Companion » button
  gives the Companion user Observer permission on exactly those characters, after a confirmation
  that gives their count; no other actor changes and no permission is lowered.

### Changed
- **Knight character provisioning accepts Knight 3.58.33 to 3.58.35.** It required 3.58.33 exactly;
  3.58.34 and 3.58.35 leave the Knight Actor and Item data models unchanged. Any other Knight
  version still keeps it off and says which versions it needs.
- **Knight characters provisioned from the app stay visible to Companion.** A new character now
  gives the paired Companion user Observer permission, and a later revision keeps the Companion
  user's permission at Observer or above instead of removing it, so « Share with Companion » is no
  longer undone. Every other grant is still reset to the character's player as owner.

## [0.13.0] - 2026-10-18

### Added
- **Setup lists the players who have the Table Companion app open.** A « Players in the app »
  section names each seat of the linked table — after its Foundry character, else its name in the
  app — and says whether the player is *In session*, has the *App open* or is *Offline*. After three
  minutes without news from the app's backend the states read as unknown; the section stays hidden
  until the backend reports presence. Gamemasters only, kept in the browser's memory. Requires the
  Table Companion backend released with this version.

### Changed
- **The first compendium search of a session no longer loads every index against its deadline.**
  A Gamemaster's browser now loads the indexes of the compendiums the Companion user may read in
  the background, one pack at a time, 15 seconds after the world is ready; the first
  `compendium.index` then reads Foundry's own index cache. On a world with many packs that first
  search could time out and the app reported the module as absent. Requests are served exactly
  as before.

### Fixed
- **The setup panel is only redrawn when something in it changed.** It was rewritten every four
  seconds, which made screen readers re-read it and moved keyboard focus off the Trust / Ignore
  buttons of a pairing request.
- **Projector pushes no longer fill every browser's console with « dropped agent envelope ».**
  The frames that show or clear the shared screen travel on the same socket as the backend's
  messages, and every connected browser logged each one as a refused message. They are now
  recognised and ignored by the backend channel. Conversely, a signed message whose body is not
  valid JSON, which was dropped without a word, is now logged like every other refusal.

## [0.12.0] - 2026-10-08

### Added
- **Setup shows when the app's backend refuses this browser's replies.** A « Reply signing » row
  now reads *Key mismatch* when the backend paired with another browser (or another Gamemaster)
  first, or *The app is linked to a different world*, each with what to do — the link read « Live »
  while every reply was dropped. Requires the Table Companion backend released with this version.
- **Setup shows a clock offset.** When this computer's clock and the backend's differ by more than
  45 seconds, a « Clock offset » row says so (past 90 seconds every message is dropped).
- **A Gamemaster browser that cannot sign its replies says so.** It warns once, and setup reads
  *Reply signing: Unavailable in this browser* — on such a browser the backend cannot trust the
  replies and Knight provisioning stays off.

- **The handshake names procedures withheld because of the game-system version.** On a Knight
  release other than the one the actor mappings are verified against, the two Knight provisioning
  procedures stay unregistered as before, and the module now tells the backend why (`unsupported`),
  so the app can say « Knight version not supported by the module » instead of « no module ».

### Changed
- **`compendium.index` reads every compendium's index at once.** The first search of a session
  loaded each pack's index one after another against the request deadline; on a world with many
  packs it could time out. They now load in parallel.
- `api.getStatus()` gains `pairingIssue` (the backend's verdict, or `null`) and `lastSkewMs` (this
  browser's clock minus the backend's, or `null`).

### Fixed
- **Reset pairing announces the module again at once.** It forgot the backend's key and rotated
  this browser's reply key, but a GM browser without a reply key sent nothing afterwards, so the
  backend had to wait for its next reconnection to pair again. The module now announces itself as
  the last step of a reset.
- **Two tabs of the same Gamemaster no longer both answer a request.** Both tabs were the elected
  responder and both received the backend's request, so a Knight provisioning request could create
  the Actor twice. Only the tab that takes the browser's lock for that request now answers. On a
  Foundry served over plain `http:` (no Web Locks) the behaviour is unchanged.
- **Reopening setup quickly no longer closes its pairing window.** Closing the setup dialog and
  opening it again within four seconds let the old dialog's refresh timer close the pairing window
  of the new one, so a backend could not pair while setup was visibly open.
- **The module no longer listens for a hook Foundry does not have.** It registered
  `userDisconnected` for presence, responder changes and the setup panel; Foundry reports a user
  leaving through `userConnected` (with `connected: false`), which the module already handles.

## [0.11.1] - 2026-09-30

### Changed
- **A newer Foundry version is no longer refused.** Knight actor provisioning used to require
  Foundry 13 or 14 exactly and turned a newer server away as an unsupported runtime. It now runs on
  Foundry 13 and every later version; a release that changes the actor data model is handled when it
  happens. The Knight system version requirement is unchanged.

## [0.11.0] - 2026-09-25

### Security
- **Only the app's service account can pair, and a player can no longer win the pairing race.**
  Foundry's server tells the module which user sent each socket message, and the backend now signs
  the user it is logged in as into every message. The module accepts backend traffic only when the
  two match, and after pairing only from the paired user. While the setup dialog is open, a
  pairing request from the Companion user this module created is accepted as before; one from any
  other user is held until the GM clicks **Trust** or **Ignore**, and a Gamemaster account can
  never pair. Before, any logged-in player could send a self-signed "backend" hello while setup
  was open and have their key pinned.
- **A message signed for one world is refused in any other.** The backend serves many worlds with
  one key and now signs the world id into every message; the module drops a message whose world
  does not match. Requires the Table Companion backend released with this version.
- **Players' browsers no longer receive the backend's requests or the module's replies.** The
  module answers only the backend's user, and the backend now addresses only the Gamemasters, so
  hidden NPC stats, character data and compendium results no longer reach every player's socket.
  The display popout is still shown to everyone, but only a Gamemaster's browser can now drive it.
- **Compendium reads are limited to what the service user may see.** `compendium.index` and
  `compendium.get` now skip packs the Companion user cannot observe and serve only Actor and Item
  packs; a hidden pack answers exactly like a missing one.
- **A procedure withheld from the capability list is also refused when called directly.** The
  Knight actor/NPC provisioning procedures were hidden from a GM browser that cannot sign its
  replies, but a request naming them still ran; it now gets `unknown_procedure`.
- **Envelopes must carry a real timestamp.** A message without a numeric `ts` was stamped "now"
  and passed the freshness check; it is now dropped.
- **Replay protection no longer forgets under load.** Recently seen request ids are kept by age
  (twice the freshness window) instead of the last 256, so a flood of traffic cannot push an id
  out and re-open its replay.
- **Unexpected errors no longer send their text over the socket.** A procedure failure that is
  not a deliberate, structured error now reports "module procedure failed"; the detail stays in
  the GM browser's console. Validation failures in `roll.execute`, `display.show` and
  `compendium.get` are now structured `invalid_args` / `not_found` errors.
- **The GM browser's reply-signing key can no longer be copied out.** It is now kept as a
  non-exportable key in the browser's IndexedDB instead of as a private key in browser settings,
  where any macro or add-on could read it. An existing key is migrated in place (same identity,
  no re-pairing); if the browser cannot store it, the old storage keeps working and the GM sees
  a one-time notice.
- **The display popout only loads `https:` or Foundry-relative portrait images.** Every
  connected browser loads the portrait, so `javascript:`, `data:`, plain `http:` and
  protocol-relative URLs are dropped and the card renders without an image.

### Changed
- **The release zip now carries `LICENSE` and `THIRD-PARTY-NOTICES.md`.** The bundled
  qrcode-generator is MIT-licensed and its copyright line does not survive minification, so its
  notice now ships beside the code. Releases also carry a signed build-provenance attestation
  (`gh attestation verify module.zip -R Heiiji/Table-companion-module`).
- **Only the elected Gamemaster announces the module to the backend.** Every connected browser used
  to, and the backend kept the capability list from the last one it heard, so a player or second
  GM joining could hide the Knight provisioning procedures until the next announcement. The new
  responder announces itself when the GM changes.
- **On player browsers, `api.getStatus()` no longer reports the backend link** (its last hello
  stays `null`) and `api.onAgentEvent` never fires, since backend traffic is now addressed to
  Gamemasters only.

### Removed
- **The `sheet.derived`, `roll.action` and `effect.apply` / `effect.remove` procedures.** No
  version of the Table Companion backend or apps ever called them: the apps compute derived
  values, system rolls and conditions in their own rules engine. They are no longer registered,
  so `capabilities()` and the capability list sent to the backend are shorter on D&D 5e and
  Knight worlds. `roll.execute`, the compendium passthrough, the display popout and the Knight
  actor/NPC provisioning are unchanged.

## [0.10.1] - 2026-09-02

### Changed
- **The Knight `roll.action` oracle says what it does NOT compute.** `type: "aspect"` has
  always returned the dice half of a Knight test — the capped pool, the even-face successes, one
  Exploit and the critical failure — and has never read the actor's Overdrives or Espoir, so its
  `successes` excludes the automatic successes Overdrives grant and its pool is not reduced by the
  despair (Espoir) penalty. The arithmetic is unchanged; the **claim** was
  wrong. Its own comment described the answer as "ground truth the app renders without re-banding",
  which is a statement about a whole test rather than about its dice. The response now carries
  **`system.automaticSuccessesIncluded: false`** and **`system.hopeTaxApplied: false`** so a consumer
  can see the boundary without reading the source, the procedure header says the same thing, and a
  test drives an actor with
  OD 3 + OD 1 and Espoir 4 whose pool and successes are unchanged by both.
  **Additive and non-breaking:** two new keys on the module's own response object, relayed verbatim
  by the agent; `ENVELOPE_VERSION` stays **1** and no procedure, argument or capability changed.
  Extending the oracle to the whole test needs a Knight 3.58.x actor fixture carrying
  `system.aspects.*.caracteristiques.*.overdrive` and `system.espoir.value`; that fixture does not
  exist, and no Table Companion app routes a Knight test through the oracle (both apps compute it
  locally, which is what standalone-first requires).

## [0.10.0] - 2026-08-24

### Added
- **`npc.upsert.v1` — durable Knight NPC provisioning (actor type `pnj`).** The signed-response
  twin of `actor.upsert.v1`: an app-created Knight NPC now appears in Foundry's actor list as a
  `pnj` Actor. The recursively exact `KnightNpcUpsertV1` DTO carries identity, a hidden/visible
  flag, direct NPC aspect values, health/armour/energy pools, force field, defense/reaction bases
  and a fixed initiative bonus — no caractéristiques, Items, descriptions, aspects exceptionnels
  or caller-selected Foundry paths. Visibility maps **fail-closed** onto document ownership plus
  prototype-token disposition: hidden ⇒ `{default: NONE}` + SECRET, visible ⇒
  `{default: LIMITED}` + NEUTRAL, and ownership is replaced wholesale on every apply so a
  visibility flip revokes stale grants. Lookup is exclusively the shared
  `flags["table-companion"].binding` (never by name); a missing binding creates, a hand-deleted
  bound Actor is deliberately recreated, and re-sends converge by content revision + canonical
  digest with a zero-write replay. Advertised only by a signing elected GM responder on the same
  exact Knight 3.58.33 / Foundry 13–14 gate as the PC lane — the pnj data model is verified
  byte-identical from 3.58.33 to 3.58.35, so a future gate widening moves both lanes together.
  New sanitized fixtures `knight-pnj-3.58.33-foundry{13,14}.json`.

### Changed
- **Build toolchain refreshed; no behavioural change.** The bundle is now emitted by Vite 8.2.2
  and TypeScript 6.0.3 (was 8.2.0 / 5.9.3), and the Foundry type definitions moved from the v13
  line to `14.366` to match the Foundry generation this module already declares as verified. All
  of these are dev-time dependencies — the single runtime dependency (`qrcode-generator`) is
  unchanged and no `src/` file was touched by the refresh — but the emitted `module.js` bytes
  differ from 0.9.0's as a result, so a byte-diff of the artifact will show more than the feature.

## [0.9.0] - 2026-08-03

> **Upgrade note — deploy the agent and the module together.** The response-signing scheme moves
> from v1 to v2, and the scheme tag is the first field of the signed string, so the two versions
> cannot verify each other's replies. A mismatched pair **fails closed**: signatures are rejected,
> replies are dropped, the agent answers 409, and the apps fall back to their local engine. Nothing
> breaks and nothing is lost — Foundry enrichment simply goes quiet until both sides match, which
> is easy to mistake for "the module stopped working". Upgrade the agent first, or at the same time.
>
> This release also contains a **breaking public-API change**: `api.registerProcedure()` now takes a
> required third argument. Any add-on registering its own procedures must declare a descriptor.

### Security
- **Response-signing scheme v1 → v2: the envelope `type` is now part of the signed string.**
  An `rpc.error`'s signed body is `{code, message}`, which canonicalizes *identically* to an
  `rpc.response` payload of the same shape. Under v1 the type sat outside the signature, so every
  signed field matched under both readings: anyone who could observe a signed error on Foundry's
  socket relay could re-emit it as a success and the signature still verified — the agent resolved
  the call with a garbage payload in place of the module's authored failure, and the app rendered
  it as a real result. The scheme tag is the first field of the signed string, so a v1 signature
  can never accidentally verify as v2. **Agent and module must be upgraded together**; a
  mismatched pair fails closed (reply dropped → 409 → the app uses its local engine).

### Changed
- **The advertised capability set now fails closed on unverified systems.** `sheet.derived`,
  `roll.action`, `effect.apply` and `effect.remove` are advertised only for systems with a
  verified contract (`dnd5e`, `knight`). Previously PF2e was carved out *by name* while every
  other unknown system silently kept the whole surface — backwards, since the systems nobody has
  looked at are the ones we can vouch for least. Concretely: `roll.action` implements exactly two
  systems but was offered on all of them, performing an Actor lookup and an OWNER check before
  failing with a generic `procedure_failed`; and `sheet.derived` returned an empty `derived` block
  for an unverified system while still exporting the entire prepared `actor.system` subtree plus
  every embedded Item's `system`, behind only an OBSERVER check. All four handlers now reject an
  unadmitted system *before* any Actor lookup, so an unsupported world learns nothing.
- **Every procedure must declare a descriptor to be registered** (`kind`, plus `minPermission`
  and `systems` where they apply). The agent routes fallback behaviour on the declared `kind`: a
  read that times out may fall back to the app's local engine, a mutation with an unknown outcome
  may not. **Breaking API change** — `api.registerProcedure()` takes a third argument.
- `api.capabilities()` now reports the WIRE list rather than the raw registry, so it no longer
  claims the module offers something the agent will never be shown (`actor.upsert.v1` is withheld
  until this client can sign, and `moduleResponseSignatureV1` is added when it can).
- The projector is documented as a **public shared screen**: its audience is every user logged into
  the Foundry world, which is *not* the set of devices seated at the table, and the GM cannot see
  that list from the app. Only table-public content may traverse it; per-player content stays on the
  redacted mesh. See `specs/pnj-refactor/backend-plan.md` §1.
- The agent's `POST /v1/worlds/{id}/effects` now accepts `apply|remove` only, and validates the
  action *before* consulting module availability — an unknown action is an honest 400 rather than
  a 409 that would tell the app to fall back and retry something that will never work.

### Fixed
- **`display.show` no longer reports success when the projector failed to open.** `openProjector`
  caught the render error, logged it, and the procedure returned `{ok: true}` regardless — so a GM
  standing in front of a blank screen was told the shared screen was showing. It now returns a
  receipt: `rendered` (this client's own popout — the only delivery fact available) and `broadcast`
  (the frame was handed to Foundry's relay, which acknowledges nothing, so the other clients' state
  stays honestly unknown). `ok` now means the projector actually came up.
- `npm run lint` now type-checks the test suite. `tsconfig.json` includes only `src`, so
  `tsc --noEmit` had been silently skipping every test file while the lint script read as though
  it covered them — and Vitest runs through esbuild, which strips types without checking them.
  Three call sites were already passing the wrong arity undetected.

### Build
- Toolchain moved to **ESLint 10** and **Vite 8**. The bundle is ~10% smaller (117.7 → 106.3 KB,
  gzip 34.1 → 30.4 KB) purely from better inlining — the emitted `dist/` contains the same module
  manifest, styles, both language files and every wire constant, and lints/tests/builds clean.
- **TypeScript stays on 5.9.** TypeScript 7 is not adoptable yet: `typescript-eslint` refuses to
  load against it (upstream tracks support for TS ≥ 7.1), so taking it would mean dropping lint
  coverage of the whole codebase to gain a version number.

### Removed
- **`effect.setValue` is no longer registered or advertised.** No Foundry system ever had a
  working implementation: the handler validated its arguments and then threw unconditionally, so
  every call failed. Because the advertised capability set is what the apps feature-detect on, a
  capability that can never succeed is worse than an absent one. The handler survives as a
  tombstone that rejects with `unsupported_runtime` *before* any Actor lookup or permission check,
  so a stale or direct call is cheap and no longer distinguishes "unknown actor" from "permission
  denied" on a procedure that could not work either way. `effect.apply` and `effect.remove` are
  unaffected. No app change: neither the iOS nor the Android client ever referenced the procedure.

## [0.8.0] - 2026-07-20

### Added
- **Durable Knight actor provisioning (`actor.upsert.v1`)**: a signed-response-only procedure can
  create a new Knight, adopt one explicitly assigned unbound Actor, or update the uniquely bound
  Actor without ever matching by name. Drafts contain only name, Table Companion binding, target
  user ownership, public creation provenance, and sync flags; approved requests map a narrow
  semantic DTO to an allowlist of authored Knight v3.58.33 fields, then apply current-only
  resources (including fixture-verified `contacts.actuel`) after actor preparation. IA
  personalization may be omitted without overwriting Foundry. The authoritative 1–5 minor
  motivations reconcile only module-managed `motivationMineure` Items.
  Duplicate bindings, stale revisions, deleted known links, and already-bound assignments fail
  closed with stable RPC codes. Optional equipment uses an exact Knight Compendium 14.0.1
  crosswalk pinned to source commit `a7c06e20245247752b5d350f8252a8b89ddeed9c`: all nine
  creation armours, twelve creation weapons, and forty module-level IDs are admitted. Multi-mode
  weapons expand to their exact documents and cumulative module levels reconcile as one Item at
  the highest purchased level. The constrained selection DTO preserves quantity, canonical armour
  slot placement, and improvement parentage without exposing Foundry paths. Missing/version-
  mismatched compendium data and unverified
  improvements report a partial result and are never synthesized. Only module-stamped equipment
  is reconciled, while all unrelated Items are preserved.
- **Public creation provenance:** the Actor stores only three catalog digests, approved revision,
  five public dealt-card ids, redacted public selections/roleplay, and five derived-source ids under
  `flags.table-companion.characterCreationV1`. `gmSecretPending`, secret pasts/advantages, and
  Maison-Dieu private choices never enter the procedure payload; partial public fields need no
  private-state reason bit.

### Security
- `actor.upsert.v1` is advertised and callable by the agent only when the elected responder can
  sign module responses. The procedure independently requires a GM responder, Knight on Foundry
  13 or 14, and exact Knight v3.58.33. A target User is optional (GM-only Actor plus an actionable
  assignment warning); when present it must be real. The procedure replaces the whole ownership
  map and rejects unknown fields recursively. It accepts no raw
  Foundry paths, ownership maps, flags, Item JSON, Tarot secrets, prepared/effective values,
  derived statistics, or maxima.

## [0.7.0] - 2026-07-18

### Added
- **Signed module responses (`moduleResponseSignatureV1`, transport authentication)**: the
  elected responder GM now signs every `rpc.response` / `rpc.error` with its own Ed25519 key, closing
  the reverse direction of the channel (the agent already signs agent→module). The public key +
  Foundry world id travel to the agent in the existing `hello` / `hello.ack` (additive `peer.pubKey`
  + `worldId`); the agent pins the key trust-on-first-use and drops any reply that fails
  verification. Each reply carries additive `sig` + `signedAt` fields over a canonical string
  `v1|<requestId>|<worldId>|<procedure>|<signedAt>|sha256(canonical-body)` — no `ENVELOPE_VERSION`
  bump. The keypair lives in a **client-scoped** setting (the responder GM's browser only), never a
  world setting, so a player cannot read it and forge responses. Modules that cannot sign (older
  runtime) keep working unsigned for read-only relays; only mutation-consequential procedures will
  require the capability. This wave is transport authentication only — no PF2e procedures are
  introduced on top of it.
- **`compendium.index` Item-subtype filter**: an optional `subtype` request field keeps only Items
  whose `type` matches (e.g. the Knight loadout subtypes `module` / `arme` / `armure`), so the app
  can pull a GM's homebrew Knight gear from their world without sifting every Item. Additive request
  field — no `ENVELOPE_VERSION` bump.

### Changed
- **"Reset pairing" is now a full two-sided reset**: besides forgetting the pinned agent key, it
  rotates this browser's response-signing keypair, so the agent must re-pin the module's identity
  too. (The agent clears its pinned key via `POST /v1/worlds/{id}/module/reset-pairing`.)
- PF2e no longer advertises `sheet.derived`, `roll.action`, or generic `effect.*` procedures. Direct
  stale invocations also fail closed: the prior sheet response exported broad prepared subtrees,
  the roll result lacked spoiler-safe provenance, and generic effects did not exactly model PF2e
  embedded condition Items. Other game systems keep their existing procedures; PF2e will regain
  only narrow, versioned capabilities after authenticated exact-version fixture verification.
- Foundry compendium reads are now described as transient access from the GM's licensed/local
  session, not redistribution rights or content-pack admission. Passthrough documents must not seed
  bundled/backend catalogs, persistent caches, or telemetry.
- **`compendium.index` is now stably ordered and reports paging**: results are sorted by name (then
  document id as a locale-independent tie-break) and returned as `{ entries, total, truncated }`
  instead of a silently-capped bare list, so the app can show "N of M". Additive to the response
  (existing readers of `entries` are unaffected).

### Removed
- Removed the unpublished PF2e advancement preview/apply/status implementation and its dormant
  unsigned-response trust flag. PF2e now advertises no sheet, semantic-roll, generic-effect, or
  advancement procedure; formula-only rolls, transient compendium reads, display, presence, and
  ping remain available. A future Foundry adapter starts from a fresh signed-response contract.

## [0.6.0] - 2026-07-10

### Added
- **Structured RPC failures and deadlines**: procedure errors can now carry stable machine codes
  such as `invalid_args`, `permission_denied`, `payload_too_large`, and `procedure_timeout`.
  Every request has a 10-second deadline, and oversized actor or compendium responses fail
  explicitly instead of being silently dropped by the envelope-size guard.
- **Knight v1.5 roll results**: `roll.action` now returns the computed success count, Exploit
  state, and critical-failure state, together with the base/combo characteristics and their
  governing aspects.

### Changed
- **Knight rolls now use a two-characteristic combo**: the request options are `base` + `combo`
  (with optional bonus dice), and the two characteristics must differ. Each characteristic is
  capped by its linked Aspect, the two effective scores are summed, even d6 results are successes,
  an all-even first pool triggers one Exploit reroll, and an all-odd first pool is a critical
  failure. Effective scores are clamped to zero, and `sheet.derived` now exposes exactly Knight's
  five real Aspects (no phantom `heaume`).
- App-initiated PF2e and D&D 5e rolls now skip Foundry's configuration dialog and suppress chat
  messages, including compatibility with both modern and legacy D&D 5e actor roll APIs.
- Dropped agent envelopes now report rate-limited diagnostic reasons in the GM console.
- GitHub releases now publish the matching changelog section as their release notes and fail
  instead of creating an incomplete release when expected artifacts are missing.

### Security
- Actor reads now require the Companion user to have `OBSERVER` permission; rolls and effect
  mutations require `OWNER`. This prevents the elected GM browser's authority from exposing or
  changing actors that were not explicitly shared with Companion.
- A previously unknown agent key can now be pinned only while the GM has the Table Companion setup
  dialog open. A successful pairing shows the new key fingerprint for verification.

### Fixed
- Pairing QR codes no longer embed loopback hosts such as `localhost`, `127.x`, or `::1`, which a
  phone cannot reach; the app will prompt for a reachable Foundry host instead.
- Opening or resetting the Companion password now closes any prior one-time password dialog so
  different secrets cannot remain stacked on screen.

## [0.5.0] - 2026-06-27

### Added
- **Knight Aspect + Caractéristique roll** (`roll.action`): `rollKnight` now sizes its
  d6 pool from the actor's Aspect **and** a chosen Caractéristique (pool = aspect value +
  `system.aspects.{aspect}.caracteristiques.{characteristic}.value`), accepting a
  `characteristic` option. Success bands stay app-side, so the module keeps shipping the
  system's own roll without baking in rules interpretation. Absent ⇒ the app falls back to
  its local dice engine. **Historical behavior note:** this path was later found to diverge from
  the Knight v1.5 player-combo rule (fixed in 0.6.0).
- **Knight sheet oracle** (`sheet.derived`): `knightDerived` surfaces a Knight actor's
  system-aware derived data — `energyMax`, `defense`, `reaction`, and per-aspect
  `aspectPools` — with gear-scoped energy and a top-level fallback. Strictly additive;
  the raw prepared `system` block is still returned.

### Changed
- **D&D 5e `sheet.derived` enrichment for the player dashboard**: `dnd5eDerived` now
  normalizes `spellSlots` (per-level + pact), `hitDice` (v3 integer ↔ v4 object coercion),
  `deathSaves`, and `concentration` (`{ active, spellName, effectId }`). Strictly additive;
  the raw prepared `system` block is still returned.

## [0.4.0] - 2026-06-23

### Added
- **Foundry compendium passthrough** (`compendium.index` / `compendium.get`): two additive RPC
  procedures that transiently surface content the active Foundry session is authorized to access
  (creatures, spells, items) as a distinct live-world section. `compendium.index` returns
  pack-qualified summaries (`"<pack>|<docId>"` ids) filtered by content type / system / query;
  `compendium.get` returns one raw Foundry document. This access is not redistribution rights or
  Table Companion content admission; the module does not retain it, and downstream consumers must
  not use it to seed persistent catalogs, backend storage, or telemetry. Absent ⇒ no live-world
  section.
- **Per-system widget oracle** — three additive, capability-gated RPC procedures that feed the
  apps' per-game-system dashboard widgets with live Foundry enrichment (absent ⇒ the app uses its
  local profile-derived baseline / dice engine, so no widget is gated by Foundry):
  - `sheet.derived` — a legacy fully-prepared Actor response plus system-specific enrichment.
    **Current qualification:** it is no longer registered for PF2e because its broad raw
    `system`/Item/effect export is not an admitted PF2e DTO.
  - `roll.action` — a system-contextual roll resolved through the system's own pipeline.
    **Current qualification:** PF2e is no longer registered because the old save/check result did
    not preserve required visibility and roll provenance; D&D 5e and Knight remain available.
  - `effect.apply` / `effect.remove` / `effect.setValue` — system-aware condition/effect mutations.
    **Current qualification:** PF2e is no longer registered because the generic endpoints did not
    exactly model its embedded condition Items; supported non-PF2 behavior is unchanged.
- **Shared-screen / projector display** (`display.show` / `display.clear`): two
  additive RPC procedures that render a GM-authored, already-revealed projection
  (portrait + fields) as a high-contrast, large-type projector popout on every
  connected client. The responder renders locally and rebroadcasts on the shared
  socket so each player's browser shows it too. Status is a text label ("En jeu"),
  never color-only. Advertised as the `display.show` capability so the app
  feature-detects it; absent ⇒ the app keeps its "Now Showing" spotlight on the
  WebRTC mesh only. No canvas/Actor/scene coupling; the module performs no
  redaction (the payload is already-revealed content) and is the sole HTML escaper.

## [0.3.0] - 2026-06-17

### Security
- Drop oversized socket messages by their wire size **before** parsing, closing a
  denial-of-service vector where any connected client could force a large
  allocation/parse on every browser at the table.
- Reject stale and replayed agent envelopes (a timestamp-freshness window plus a
  bounded seen-id cache), so a captured signed envelope can no longer be replayed
  to re-trigger a procedure or fake link liveness.
- Bound `roll.execute` formula length and dice count before evaluation, so an
  oversized formula can't freeze the responding GM's browser.
- Create the Companion service user with the least-privilege **PLAYER** role
  instead of TRUSTED (its reach still comes from per-actor ownership).

### Changed
- Non-responder clients no longer verify `rpc.request`/`ping` traffic they would
  never act on.
- The **Settings → Table Companion** entry is now registered through Foundry's
  settings-menu API instead of being injected into the sidebar DOM.

### Added
- Live-updating link-status panel (no more manual Refresh to see the link go
  live).
- Non-destructive **Reset password** action for the Companion user.
- QR-code pairing in the password dialog for one-scan setup from the mobile app.
- The pairing deep link now carries the Foundry server origin (`&h=`), so a single
  scan fully connects the app without the GM retyping the host.
- First direct test coverage of the RPC channel (signature gate, pairing,
  responder gating, replay), and a push/pull-request CI workflow.
- Accessibility and onboarding refinements in the setup dialog.

## [0.2.1]

### Added
- `roll.execute` RPC procedure: evaluates a formula through Foundry core's dice pipeline. It returns
  formula/dice/total only and is not a system check result or PF2e degree-of-success envelope.

### Fixed
- Single-instance setup dialog and more robust password copy.

## [0.2.0]

### Added
- Authenticated agent channel: Ed25519 message signing with trust-on-first-use
  key pinning, an active-GM presence signal pushed to the agent, and release
  hardening.
