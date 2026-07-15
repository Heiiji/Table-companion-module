# CLAUDE.md — Table-companion-module

Project instructions for Claude Code, Codex, and other AI agents working in the optional
FoundryVTT module. The README is for end users (GMs); this file is the internal contract for
future AI sessions.

> **Maintenance rule:** keep the Repository Map and the cross-repo pointers current. When you
> change the RPC envelope, a procedure name, or the signing scheme, update the agent side
> **and** the ecosystem [`docs/CONTRACTS.md`](../docs/CONTRACTS.md) in the same change.
> Every module change that affects runtime behavior, security, compatibility, setup/UI, manifests,
> or release packaging **must also update `CHANGELOG.md` under `[Unreleased]` in the same change**.
> Do not defer the changelog to release time or create a future version heading before its tag;
> a qualifying task is incomplete while its Unreleased note is missing. Pure tests, internal
> refactors, and documentation-only changes need no entry unless they change user-visible behavior.

## First Moves

- Run `git status --short --branch` before editing. Treat unrelated changes as user work.
- Prefer `rg` / `rg --files`. Avoid scanning `dist/`, `node_modules`, coverage output.
- Before changing game-specific procedures, use the workspace
  [`game-system reference registry`](../docs/game-systems/README.md). A connected Foundry system is
  version-specific integration evidence, not automatically the published rule authority.
- Read the relevant `src/` module **and its `test/` mirror** before changing behavior; the
  test suite is comprehensive and is the fast feedback loop (no Foundry needed).
- Never log or commit the Companion user's password or the agent signing key.

## Product Model

This is an **optional** enhancement for Foundry tables — never required. Everything in Table
Companion works without it; the app connects to Foundry on its own. The module only makes
setup one-click and unlocks higher-fidelity, system-aware features. It is a **Foundry-only**
enhancement and sits *outside* the app's external-VTT provider abstraction (Roll20, etc. have
no equivalent). See the ecosystem [`CLAUDE.md`](../CLAUDE.md) for the standalone-first invariant.

Two jobs:

1. **Setup & link status** — create the dedicated `Companion` user with a strong password
   (shown once), display whether the app is linked, expose the paired-key fingerprint +
   **Reset pairing**.
2. **Signed RPC channel** — a versioned, additive-only envelope the **agent** uses to invoke
   system-aware procedures (native rolls, derived sheet stats, effects, compendium reads,
   display push) over Foundry's own `module.table-companion` socket relay. The agent signs
   every message (Ed25519); the module pins the agent's public key on first contact and
   verifies thereafter, so another logged-in client cannot impersonate the agent.

## Repository Map

- `src/module.ts` — entry point / Foundry hooks; wires setup, presence, election, channel.
- `src/api.ts` — the public API surface at `game.modules.get("table-companion").api`
  (semver'd: `envelopeVersion`, `capabilities()`, `openSetup()`).
- `src/constants.ts` — `ENVELOPE_VERSION` (parity-locked with the agent; see Parity).
- `src/procedures/` — one file per RPC procedure: `ping`, `presence`, `rollExecute`
  (`roll.execute`), `rollAction` (`roll.action`), `sheetDerived` (`sheet.derived`),
  `effects` (`effect.apply|remove|setValue`), `compendium` (`compendium.index|get`),
  and `display` (`display.show|clear`); `index.ts` registers them and applies the PF2e
  clean-cut capability filter. **These proc-name strings are duplicated in the agent (Go)** — see
  Parity.
- `src/rpc/` — `envelope` (shape + `EnvelopeType` union), `channel` (handshake, correlation,
  freshness/clock-skew window), `registry` (procedure dispatch), `signing` (Ed25519 verify +
  key pinning).
- `src/setup/` — `companion-user` (create/reset the Companion user), `presence`, `election`
  (which connected GM client owns the channel).
- `src/ui/` — `projector` (the high-contrast display popout for `display.show`), `SetupApp`.
- `src/util/` — `password`, `html` (the **sole** HTML escaper — the agent deliberately does
  not escape, to avoid double-escaping), `log`.
- `test/` — Vitest specs mirroring `src/` (mocks the Foundry socket; one spec per RPC piece).
- `CHANGELOG.md` — user-facing release history; keep `[Unreleased]` current as part of every
  qualifying module change, then move those entries under the tagged version at release time.
- `lang/` (en, fr), `styles/`, `module.json` (manifest), `vite`/`vitest`/`tsconfig` config.

## Architecture Rules

- **Additive-only envelope.** Add new procedures/fields without breaking old peers; only a
  genuine breaking change bumps `ENVELOPE_VERSION`.
- **The module is the system-aware half.** It returns results from the connected Foundry system
  (for example D&D 5e advantage or Knight combo outcomes). The agent relays them **verbatim** and
  stays system-agnostic — keep integration logic here, not in the agent. Treat those results as
  exact for the pinned Foundry/system version, then reconcile game semantics with the workspace
  reference pack; the current Knight roll path is recorded there as divergent.
- **The module is the sole HTML escaper** for display payloads. Do not assume the agent
  escaped anything.
- **Signing is mandatory.** Every `rpc.request` is verified against the pinned agent key.
  Never relax the freshness window or the pinning without updating the agent's signer.
- **PF2e is behind a pre-production clean cut.** On a PF2e world, the registry exposes only
  `ping`, `presence`, class-neutral formula-only `roll.execute`, transient `compendium.index|get`,
  and `display.show|clear`. It does not register a PF2e sheet projection, semantic roll, generic
  effect mutation, advancement preview/apply, or operation-status procedure. The retained
  `sheet.derived`, `roll.action`, and `effect.*` handlers repeat an explicit PF2e guard and reject
  stale direct calls before Actor lookup or mutation. M8 must introduce fresh exact-version DTOs
  and procedure names only with persistent module identity, signed module responses, sanitized
  fixtures, verified authority, and adversarial recovery tests; no deleted revision-5 adapter or
  trust flag is a dormant implementation.
- Foundry's "one session per user" rule applies to `Companion`: never log in as that user.

## Verification

```sh
npm ci
npm run lint     # eslint + tsc --noEmit
npm run test     # vitest run  (no Foundry required)
npm run build    # vite build → dist/  (a drop-in module folder)
```

- **Version-sync gotcha:** `module.json` `version` **must equal** `package.json` `version`.
  CI (`.github/workflows/ci.yml`) enforces this — they are the one hand-synced field.
- Release is the `v*`-tag workflow (`release.yml`): it stamps the tag into `package.json`,
  builds, and publishes `dist/module.json` + `module.zip` to a GitHub release.
- **Manual Foundry test:** symlink/drop `dist/` into a Foundry `Data/modules/table-companion`
  folder on a licensed Foundry **13–14** world. There is no automated Foundry-integration
  harness — the agent's connector (`make probe` in `Table-companion-agent`) is the cross-repo
  integration target.

## Cross-repo contracts

This module is one end of the **agent ↔ module** boundary. The envelope version and the
procedure-name strings are parity-locked with the agent — see
[`docs/CONTRACTS.md`](../docs/CONTRACTS.md) §1 (row 4) and §2 (procedure names) before
changing either. The agent side lives in `Table-companion-agent/internal/connector/
modulechannel.go` + `internal/service/{worlds,display}.go`.
