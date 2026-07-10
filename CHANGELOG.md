# Changelog

All notable changes to this module are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  its local dice engine. **Historical behavior note:** this path is now classified as divergent
  from the indexed Knight v1.5 player-combo rule; see the workspace
  [`Knight implementation status`](../docs/game-systems/knight/implementation-status.md).
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
  procedures that surface the GM's own Foundry compendium content (creatures, spells, items) so the
  app can merge it with the backend reference catalog into one "augmented library". `compendium.index`
  returns pack-qualified summaries (`"<pack>|<docId>"` ids) filtered by content type / system / query;
  `compendium.get` returns one raw Foundry document. The GM already owns this content — it is surfaced
  live, never redistributed or cached server-side; the app normalizes it via its existing system
  mappers, so the module stays system-agnostic. Absent ⇒ the app shows backend-only catalog content.
- **Per-system widget oracle** — three additive, capability-gated RPC procedures that feed the
  apps' per-game-system dashboard widgets with Foundry ground truth (absent ⇒ the app uses its
  local profile-derived baseline / dice engine, so no widget is gated by Foundry):
  - `sheet.derived` — a fully-prepared actor's system-aware derived data (saving-throw totals +
    proficiency ranks, AC, spell DC/attack, slot maxes) plus its raw prepared `system`, items and
    effects. The headless connector can never see these (system JS computes them in-session).
  - `roll.action` — a system-contextual roll resolved through the system's own pipeline
    (pf2e save/check with degrees-of-success, dnd5e check/save with advantage, Knight aspect
    d6-pool sized from the actor), returning the evaluated roll + `system` enrichment.
  - `effect.apply` / `effect.remove` / `effect.setValue` — system-aware condition/effect mutations
    so rule side-effects fire (pf2e valued conditions via the system API, dnd5e concentration drop
    via the stable ActiveEffect delete path). Mechanical embedded toggles stay on the agent's
    connector write path. All are responder-gated by the existing rpc.request dispatch.
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
- `roll.execute` RPC procedure: evaluates a formula through Foundry's own dice
  pipeline so the app can obtain system-exact rolls.

### Fixed
- Single-instance setup dialog and more robust password copy.

## [0.2.0]

### Added
- Authenticated agent channel: Ed25519 message signing with trust-on-first-use
  key pinning, an active-GM presence signal pushed to the agent, and release
  hardening.
