import { buildApi } from "./api.js";
import { MODULE_ID, SETTING_AGENT_KEY } from "./constants.js";
import { registerBuiltinProcedures } from "./procedures/index.js";
import { Channel } from "./rpc/channel.js";
import { ProcedureRegistry } from "./rpc/registry.js";
import { startPresenceWatcher } from "./setup/presence.js";
import { openSetupApp } from "./ui/SetupApp.js";
import { localize, log } from "./util/log.js";

let channel: Channel | undefined;

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
