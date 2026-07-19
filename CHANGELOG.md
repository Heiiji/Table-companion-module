# Changelog

All notable changes to this module are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.7.0] - 2026-07-18

### Added
- **Signed module responses (`moduleResponseSignatureV1`, M8 transport authentication)**: the
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
