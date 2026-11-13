import { buildApi } from "./api.js";
import {
  MODULE_ID,
  SETTING_AGENT_KEY,
  SETTING_AGENT_USER,
  SETTING_COMPANION_ANCHOR,
  SETTING_MODULE_KEYPAIR,
} from "./constants.js";
import {
  applicationV2Class,
  gameSettings,
  worldId as foundryWorldId,
} from "./foundry/runtime.js";
import { registerBuiltinProcedures } from "./procedures/index.js";
import { scheduleCompendiumWarmup } from "./procedures/compendium.js";
import { startDisplayListener } from "./procedures/display.js";
import { stripDuplicatedBinding } from "./procedures/upsertShared.js";
import { Channel } from "./rpc/channel.js";
import { ProcedureRegistry } from "./rpc/registry.js";
import { checkSignatureSupport } from "./rpc/signatureSupport.js";
import {
  clearStoredSigner,
  loadOrCreateSigner,
  type SignerStorage,
} from "./rpc/responseSigning.js";
import { appPresence } from "./setup/appPresence.js";
import { startPresenceWatcher } from "./setup/presence.js";
import { startChatMarks } from "./ui/chatMarks.js";
import { startKnightRollCards } from "./ui/knightRollCard.js";
import { startKnightAttackFollowUps } from "./procedures/knightAttackFollowUps.js";
import { offerSetupIfNeeded, openSetupApp } from "./ui/SetupApp.js";
import { indexedDbKeyStore, responseKeyRecord } from "./util/keyStore.js";
import { localize, log } from "./util/log.js";

let channel: Channel | undefined;

/** Read this browser's stored response-signing keypair (private JWK), or null. */
function getKeypairJwk(): JsonWebKey | null {
  const v = gameSettings()?.get(MODULE_ID, SETTING_MODULE_KEYPAIR);
  return v && typeof v === "object" ? (v as JsonWebKey) : null;
}

/** Persist this browser's response-signing keypair (private JWK). */
async function setKeypairJwk(jwk: JsonWebKey | null): Promise<void> {
  await gameSettings()?.set(MODULE_ID, SETTING_MODULE_KEYPAIR, jwk);
}

/** Where this GM browser keeps its response-signing key: a non-extractable key
 * in IndexedDB, one per world and Foundry user — so a reset in one world, or
 * another user of this browser, never rotates another world's key — adopting
 * the browser-wide key of older builds, with the older client-setting JWK as
 * migration source and fallback. A fallback is surfaced once so the GM knows
 * the key is exportable.
 * ponytail: the JWK fallback stays browser-wide (only a browser that cannot
 * store a CryptoKey uses it); a GM re-enrolls from setup after its rotation. */
function signerStorage(): SignerStorage {
  let warned = false;
  return {
    getJwk: getKeypairJwk,
    setJwk: setKeypairJwk,
    keyStore: indexedDbKeyStore(
      responseKeyRecord(foundryWorldId(), game.user?.id ?? ""),
    ),
    legacyKeyStore: indexedDbKeyStore(),
    onFallback: (reason) => {
      log.warn("response-signing key kept in browser settings instead", reason);
      if (warned) return;
      warned = true;
      ui.notifications?.warn(localize("setup.notify.keyStoreFallback"));
    },
  };
}

/** Load (or create) this GM browser's response-signing key and install it on the
 * channel, plus the reset hook so "Reset pairing" rotates it. Only GM clients
 * hold a key; only the elected responder ever signs with it. */
async function initResponseSigner(ch: Channel): Promise<void> {
  const storage = signerStorage();
  const signer = await loadOrCreateSigner(storage);
  ch.setResponseSigner(signer);
  ch.setResponseKeyResetter(async () => {
    // Rotate: discard this world's key and mint a fresh one — never re-adopting
    // the browser-wide legacy key — which the channel then enrolls in place of
    // this user's old keys.
    await clearStoredSigner(storage);
    const rotated = await loadOrCreateSigner({
      ...storage,
      legacyKeyStore: null,
    });
    log.info("rotated module response-signing key");
    return rotated;
  });
}

Hooks.once("init", () => {
  // Pinned agent signing key (trust-on-first-use). Hidden from the settings form
  // (config:false); managed by the channel and the setup UI. fvtt-types models
  // settings only for keys it knows, so we register through the runtime shim.
  gameSettings()?.register(MODULE_ID, SETTING_AGENT_KEY, {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });
  // The Foundry user the paired agent sends as, and the service user this
  // module created. Both hidden and GM-managed; see src/setup/identity.ts.
  for (const key of [SETTING_AGENT_USER, SETTING_COMPANION_ANCHOR]) {
    gameSettings()?.register(MODULE_ID, key, {
      scope: "world",
      config: false,
      type: String,
      default: "",
    });
  }

  // This browser's response-signing keypair as a private JWK: the storage used
  // by builds before 0.11.0, now only a migration source and the fallback when
  // IndexedDB cannot hold the key. CLIENT scope is load-bearing — a world-scoped
  // private key would broadcast to every player and let them forge module
  // responses. See responseSigning.ts.
  gameSettings()?.register(MODULE_ID, SETTING_MODULE_KEYPAIR, {
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

  // Every client: app rolls on a Knight world drawn as the system's roll card.
  startKnightRollCards();
  // Every client: an Actor created carrying another Actor's Table Companion
  // link (a « Duplicate ») loses it before it is saved. The hook runs only on
  // the creating client, so no Gamemaster needs to be connected.
  Hooks.on("preCreateActor", (doc, data, options) =>
    stripDuplicatedBinding(doc as never, data, options as never),
  );
  // Every client: a card the companion apps cancelled is greyed under a banner.
  startChatMarks();
  // Knight: damage / violence cards rolled from an app attack card are tagged
  // with that attack (the elected responder stamps them).
  startKnightAttackFollowUps();

  // Publish the public API as early as possible so dependents can read it.
  if (mod) {
    (mod as { api?: unknown }).api = buildApi(
      version,
      registry,
      channel,
      openSetup,
    );
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
  // Response signing: only GM clients hold a key (only the elected responder
  // ever signs). Players never sign, so they never generate one. Both it and
  // every agent envelope need WebCrypto Ed25519, which plain http withholds.
  void checkSignatureSupport().then((support) => {
    if (support !== "ok") {
      // The channel stays up (election, hello, presence need no crypto); the
      // setup panel names the cause instead of a silent "Waiting".
      log.error(`cannot verify the backend's signatures here (${support})`);
      if (game.user?.isGM)
        ui.notifications?.error(localize("setup.notify.insecureContext"));
      return;
    }
    if (channel && game.user?.isGM) void initResponseSigner(channel);
  });
  // Who has the Table Companion app open, for the setup panel. The backend
  // sends this to Gamemasters only.
  if (channel && game.user?.isGM) channel.onEvent(appPresence.onEvent);
  // A Gamemaster on a world not linked yet is offered the setup, once.
  if (channel && game.user?.isGM) void offerSetupIfNeeded(channel);
  // Load the readable compendium indexes in the background, so the first
  // search of the session does not load them all against its deadline.
  scheduleCompendiumWarmup();
});

/** Register the setup launcher as a settings menu. The menu's `type` is a minimal
 * ApplicationV2 whose render just opens our DialogV2 setup panel and returns, so
 * the button behaves as a launcher. Defined here (not at import) because the
 * `foundry` global only exists once `init` runs. Never throws into init — the
 * public-API openSetup() is the fallback. */
function registerSetupMenu(openSetup: () => void): void {
  try {
    const AppV2 = applicationV2Class();
    if (!AppV2) return;
    class SetupLauncher extends AppV2 {
      override async render(): Promise<unknown> {
        openSetup();
        return this;
      }
    }
    gameSettings()?.registerMenu(MODULE_ID, "setupMenu", {
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
