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
- **Link status** — a panel showing whether the app is connected to your world.
- **Knight character provisioning** — when the app finishes or resumes its guided Knight creator,
  a signed GM-side procedure can create, explicitly adopt, or safely update the matching Foundry
  Actor without name-based guessing or overwriting unrelated equipment.
- **Capability channel** — a small, versioned link the app's backend uses to add
  higher-fidelity features (native system rolls, …) in future updates. The agent
  signs every message (Ed25519); the module pins the agent's public key on first
  contact and verifies it thereafter, so another logged-in client cannot
  impersonate the agent. The paired key's fingerprint is shown in **Settings →
  Table Companion**, with a **Reset pairing** button if you ever need to re-pair.

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
4. Give the `Companion` user *Observer* (display) or *Owner* (edit) permission on
   your players' characters.

> **Important:** never log in to Foundry as the `Companion` user yourself —
> Foundry allows one session per user, so it would disconnect the app.

The password is shown only once. If you lose it, open setup and click **Reset
password** to generate a new one — no need to delete the user or re-grant
permissions. If the **Table Companion** settings entry is ever missing, a
Gamemaster can open setup from the console with
`game.modules.get("table-companion").api.openSetup()`.

## Compatibility

- **Foundry VTT:** v13 – v14 (verified on v14)
- **Game systems:** system-agnostic baseline; exact Knight v3.58.33 on Foundry 13–14 has an
  additive, constrained actor-provisioning integration. Exact equipment materialization optionally
  uses Knight Compendium 14.0.1; other/missing versions remain safely partial.
- **Languages:** English, Français

## Developing

```bash
npm install
npm run build      # bundles to dist/ (a drop-in module folder)
npm run watch      # rebuild on change
npm run lint       # eslint + tsc --noEmit
```

Symlink `dist/` into your Foundry `Data/modules/table-companion` for local
testing. The public API is exposed at `game.modules.get("table-companion").api`.

## License

[MIT](LICENSE).
