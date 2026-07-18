import { buildApi } from "./api.js";
import {
  MODULE_ID,
  SETTING_AGENT_KEY,
  SETTING_MODULE_KEYPAIR,
} from "./constants.js";
import { registerBuiltinProcedures } from "./procedures/index.js";
import { startDisplayListener } from "./procedures/display.js";
import { Channel } from "./rpc/channel.js";
import { ProcedureRegistry } from "./rpc/registry.js";
import { loadOrCreateSigner } from "./rpc/responseSigning.js";
import { startPresenceWatcher } from "./setup/presence.js";
import { openSetupApp } from "./ui/SetupApp.js";
import { localize, log } from "./util/log.js";

let channel: Channel | undefined;

// Structural view of Foundry's settings store — fvtt-types only models keys it
// knows, and both of ours are registered structurally (config:false).
type SettingsStore = {
  get(ns: string, key: string): unknown;
  set(ns: string, key: string, value: unknown): Promise<unknown>;
  register(ns: string, key: string, data: unknown): void;
};

function settingsStore(): SettingsStore | undefined {
  return game.settings as unknown as SettingsStore | undefined;
}

/** Read this browser's stored response-signing keypair (private JWK), or null. */
function getKeypairJwk(): JsonWebKey | null {
  const v = settingsStore()?.get(MODULE_ID, SETTING_MODULE_KEYPAIR);
  return v && typeof v === "object" ? (v as JsonWebKey) : null;
}

/** Persist this browser's response-signing keypair (private JWK). */
async function setKeypairJwk(jwk: JsonWebKey | null): Promise<void> {
  await settingsStore()?.set(MODULE_ID, SETTING_MODULE_KEYPAIR, jwk);
}

/** Load (or create) this GM browser's response-signing key and install it on the
 * channel, plus the reset hook so "Reset pairing" rotates it. Only GM clients
 * hold a key; only the elected responder ever signs with it. */
async function initResponseSigner(ch: Channel): Promise<void> {
  const signer = await loadOrCreateSigner(getKeypairJwk, setKeypairJwk);
  ch.setResponseSigner(signer);
  ch.setResponseKeyResetter(async () => {
    // Rotate: discard the pinned identity the agent knows and mint a fresh one so
    // a re-pair starts clean. The agent must also clear its pin (it will see the
    // new key as a mismatch until then).
    await setKeypairJwk(null);
    const rotated = await loadOrCreateSigner(getKeypairJwk, setKeypairJwk);
    ch.setResponseSigner(rotated);
    log.info("rotated module response-signing key");
  });
}

Hooks.once("init", () => {
  // Pinned agent signing key (trust-on-first-use). Hidden from the settings form
  // (config:false); managed by the channel and the setup UI. fvtt-types models
  // settings only for keys it knows, so we register through a structural cast.
  (
    game.settings as unknown as {
      register(ns: string, key: string, data: unknown): void;
    }
  )?.register(MODULE_ID, SETTING_AGENT_KEY, {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  // M8: this browser's own response-signing keypair (private JWK). CLIENT scope
  // is load-bearing — a world-scoped private key would broadcast to every player
  // and let them forge module responses. See responseSigning.ts.
  settingsStore()?.register(MODULE_ID, SETTING_MODULE_KEYPAIR, {
    scope: "client",
    config: false,
    type: Object,
    default: null,
  });

  const registry = new ProcedureRegistry();
  registerBuiltinProcedures(registry);

  const mod = game.modules?.get(MODULE_ID);
  const version = (mod?.version as string | undefined) ?? "0.0.0";
  channel = new Channel(registry, version);

  const openSetup = () => {
    if (channel) void openSetupApp(channel);
  };

  // GM-only setup entry under Settings → Configure Settings, via Foundry's own
  // settings-menu API (layout-stable across v13/v14, unlike injecting into the
  // sidebar DOM). The API's openSetup() remains a fallback entry point.
  registerSetupMenu(openSetup);

  // Publish the public API as early as possible so dependents can read it.
  if (mod) {
    (mod as { api?: unknown }).api = buildApi(version, registry, channel, openSetup);
  }

  log.info(`initialized (v${version})`);
});

Hooks.once("ready", () => {
  // Socket is available from init, but we wait for `ready` so game state exists
  // for GM election and for procedures that touch documents.
  channel?.start();
  if (channel) startPresenceWatcher(channel);
  // Every client listens for player-facing projector broadcasts (the responder
  // renders locally and rebroadcasts; peers render here). Inert until a display is
  // pushed — no-op on standalone tables and tables that never use the feature.
  startDisplayListener();
  // M8: only GM clients hold a response-signing key (only the elected responder
  // ever signs). Players never sign, so they never generate one.
  if (channel && game.user?.isGM) void initResponseSigner(channel);
});

/** Register the setup launcher as a settings menu. The menu's `type` is a minimal
 * ApplicationV2 whose render just opens our DialogV2 setup panel and returns, so
 * the button behaves as a launcher. Defined here (not at import) because the
 * `foundry` global only exists once `init` runs. Never throws into init — the
 * public-API openSetup() is the fallback. */
function registerSetupMenu(openSetup: () => void): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AppV2 = (foundry as any)?.applications?.api?.ApplicationV2;
    if (!AppV2) return;
    class SetupLauncher extends AppV2 {
      async render(): Promise<unknown> {
        openSetup();
        return this;
      }
    }
    (
      game.settings as unknown as {
        registerMenu(ns: string, key: string, data: unknown): void;
      }
    )?.registerMenu(MODULE_ID, "setupMenu", {
      name: localize("setup.menu.name"),
      label: localize("setup.menu.label"),
      hint: localize("setup.menu.hint"),
      icon: "fa-solid fa-dice-d20",
      type: SetupLauncher,
      restricted: true,
    });
  } catch (err) {
    log.warn("could not register the setup menu", err);
  }
}
