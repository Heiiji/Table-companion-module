import { buildApi } from "./api.js";
import { MODULE_ID } from "./constants.js";
import { registerBuiltinProcedures } from "./procedures/index.js";
import { Channel } from "./rpc/channel.js";
import { ProcedureRegistry } from "./rpc/registry.js";
import { openSetupApp } from "./ui/SetupApp.js";
import { localize, log } from "./util/log.js";

let channel: Channel | undefined;

Hooks.once("init", () => {
  const registry = new ProcedureRegistry();
  registerBuiltinProcedures(registry);

  const mod = game.modules?.get(MODULE_ID);
  const version = (mod?.version as string | undefined) ?? "0.0.0";
  channel = new Channel(registry, version);

  const openSetup = () => {
    if (channel) void openSetupApp(channel);
  };

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
});

// Add a control to the Settings sidebar so a GM can open setup any time. The
// `html` arg is a jQuery object on v13 and a raw HTMLElement on v14; the sidebar
// layout also differs, so we normalize, append defensively, and never let a
// layout change throw inside the hook (the API's openSetup() is the fallback).
Hooks.on("renderSettings", (_app: unknown, html: unknown) => {
  if (!game.user?.isGM || !channel) return;
  try {
    const root = normalizeHtml(html);
    if (!root || root.querySelector(`.${MODULE_ID}-settings-block`)) return;

    const btn = document.createElement("button");
    btn.type = "button";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-dice-d20";
    btn.append(icon, " ", localize("setup.openButton"));
    btn.addEventListener("click", () => void openSetupApp(channel!));

    const section = document.createElement("div");
    section.classList.add(`${MODULE_ID}-settings-block`, "tca-settings-block");
    section.appendChild(btn);
    root.appendChild(section);
  } catch (err) {
    // Non-fatal: the GM can still open setup via the public API.
    log.warn("could not add the settings button", err);
  }
});

function normalizeHtml(html: unknown): HTMLElement | null {
  if (html instanceof HTMLElement) return html;
  const arr = html as ArrayLike<HTMLElement> | undefined; // jQuery on v13
  return arr && arr.length ? arr[0] : null;
}
