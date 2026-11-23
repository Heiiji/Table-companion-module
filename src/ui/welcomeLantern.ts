import {
  CAP_RESPONSE_SIG,
  LINK_STALE_MS,
  MODULE_ID,
  SETTING_AGENT_KEY,
} from "../constants.js";
import {
  chatMessageImplementation,
  foundryHooks,
  gameSettings,
  systemId,
} from "../foundry/runtime.js";
import { laneFlags, type CardMessage } from "../procedures/chatCards.js";
import type { Channel } from "../rpc/channel.js";
import { signatureSupport } from "../rpc/signatureSupport.js";
import { isResponder, responderGM } from "../setup/election.js";
import { isServiceUserId, pairedAgentUserId } from "../setup/identity.js";
import { escapeHtml } from "../util/html.js";
import { localize, log } from "../util/log.js";
import { openSetupApp } from "./SetupApp.js";

const MODE = "welcomeMode";
const SEEN = "welcomeSeen";
const OPENING = "welcomeLastOpening";
const QUERY = "table-companion.lanternActive";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Foundry types custom User queries through CONFIG.Queries.
  namespace CONFIG {
    interface Queries {
      "table-companion.lanternActive": (data: object) => boolean;
    }
  }
}

function greetingHtml(): string {
  const system = systemId();
  const greeting = ["knight", "pf2e", "dnd5e"].includes(system)
    ? system
    : "other";
  const path = game.i18n?.lang?.split("-")[0] === "fr" ? "fr/beta/" : "beta/";
  return (
    `<p class="tca-lantern-greeting">${escapeHtml(localize(`welcome.greeting.${greeting}`))}</p>` +
    `<a class="tca-lantern-link" href="https://tablecompanion.app/${path}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize("welcome.link"))} <span aria-hidden="true">↗</span></a>`
  );
}

export async function postWelcomeLantern(): Promise<void> {
  const settings = gameSettings();
  const userId = game.user?.id;
  if (!settings || !userId || isServiceUserId(userId)) return;
  const mode = settings.get(MODULE_ID, MODE);
  const opening = game.world?.lastPlayed;
  let id: string;
  let marker: typeof SEEN | typeof OPENING;
  let value: true | string;
  if (mode === "first") {
    id = userId;
    marker = SEEN;
    value = true;
  } else if (mode === "world" && isResponder() && opening) {
    // Foundry stamps lastPlayed on world launch; browser reloads retain it.
    const time = Date.parse(opening);
    if (!Number.isFinite(time)) return;
    id = "TCWorld" + time.toString(36).padStart(9, "0");
    marker = OPENING;
    value = opening;
  } else return;
  if (settings.get(MODULE_ID, marker) === value) return;

  // A stable ChatMessage id covers simultaneous logins and a failed marker write.
  // Deleting old chat history does not clear the separate account/world marker.
  const existing = game.messages?.get(id);
  if (existing) {
    if (laneFlags(existing)?.welcomeOpening === undefined) return;
  } else {
    const created = await chatMessageImplementation()?.create(
      {
        _id: id,
        speaker: { alias: "Table Companion" },
        content: greetingHtml(),
        whisper: mode === "first" ? [userId] : [],
        sound: null,
        flags: { [MODULE_ID]: { welcomeOpening: opening ?? "" } },
      },
      { keepId: true, notify: false, scroll: false },
    );
    if (!created) return;
  }
  await settings.set(MODULE_ID, marker, value);
}

function gmStatus(channel: Channel) {
  if (signatureSupport() !== "ok") return "check";
  if (
    !gameSettings()?.get(MODULE_ID, SETTING_AGENT_KEY) ||
    !pairedAgentUserId()
  )
    return "setup";
  const status = channel.getStatus();
  if (
    !status.lastAgentHelloAt ||
    Date.now() - status.lastAgentHelloAt >= LINK_STALE_MS ||
    !game.users?.get(pairedAgentUserId())?.active
  )
    return "waiting";
  if (
    status.pairingIssue ||
    channel.replyKeyEnrolled() === false ||
    (status.isResponder &&
      !channel.advertisedCapabilities().includes(CAP_RESPONSE_SIG))
  )
    return "check";
  return "active";
}

export function registerWelcomeLantern(channel: Channel): void {
  const settings = gameSettings();
  const prefix = MODULE_ID + ".welcome.";
  settings?.register(MODULE_ID, MODE, {
    name: prefix + "name",
    hint: prefix + "hint",
    scope: "world",
    config: true,
    restricted: true,
    type: String,
    choices: {
      first: prefix + "first",
      world: prefix + "world",
      off: prefix + "off",
    },
    default: "first",
  });
  settings?.register(MODULE_ID, SEEN, {
    scope: "user",
    config: false,
    type: Boolean,
    default: false,
  });
  settings?.register(MODULE_ID, OPENING, {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  // Players receive only the elected GM's yes/no answer. Pairing details stay local to the GM.
  CONFIG.queries[QUERY] = () =>
    settings?.get(MODULE_ID, MODE) !== "off" &&
    isResponder() &&
    gmStatus(channel) === "active";
  const badges = new Set<HTMLElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Foundry can finish rendering a batch of cards before it inserts them into the chat.
  const observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      const badge = target.querySelector<HTMLElement>(".tca-lantern-status");
      if (!badge) continue;
      if (isIntersecting) badges.add(badge);
      else {
        badges.delete(badge);
        badge.hidden = true;
        if (!target.isConnected) observer.unobserve(target);
      }
    }
    if (badges.size && timer === undefined)
      timer = setTimeout(() => void refresh(), 0);
  });
  async function refresh() {
    for (const badge of badges) if (!badge.isConnected) badges.delete(badge);
    if (!badges.size) {
      timer = undefined;
      return;
    }
    let state = "";
    try {
      if (!document.hidden && settings?.get(MODULE_ID, MODE) !== "off") {
        if (game.user?.isGM) state = gmStatus(channel);
        else if (
          game.user?.hasPermission("QUERY_USER") &&
          game.users?.get(pairedAgentUserId())?.active
        ) {
          const gm = responderGM();
          if (
            gm &&
            (await gm.query(QUERY, {}, { timeout: 2000 })) === true &&
            responderGM()?.id === gm.id
          )
            state = "active";
        }
      }
    } catch {
      /* A GM can disconnect during a query. Leave the badge hidden. */
    }
    for (const badge of badges) {
      badge.hidden = !state;
      badge.dataset.state = state;
      badge.textContent = state ? localize("welcome.status." + state) : "";
    }
    timer = setTimeout(() => void refresh(), 15_000);
  }

  foundryHooks()?.on(
    "renderChatMessageHTML",
    (
      message: CardMessage & { isContentVisible?: boolean },
      html: HTMLElement,
    ) => {
      const opening = laneFlags(message)?.welcomeOpening;
      if (typeof opening !== "string" || message.isContentVisible === false)
        return;
      const content = html.querySelector<HTMLElement>(".message-content");
      const sender = html.querySelector<HTMLElement>(".message-sender");
      if (!content) return;
      html.classList.add("tca-lantern");
      content.innerHTML = greetingHtml();
      if (
        opening !== game.world?.lastPlayed ||
        settings?.get(MODULE_ID, MODE) === "off"
      )
        return;
      const badge = document.createElement(game.user?.isGM ? "button" : "span");
      badge.className = "tca-lantern-status";
      badge.hidden = true;
      if (badge instanceof HTMLButtonElement) {
        badge.type = "button";
        badge.title = localize("setup.menu.label");
        badge.addEventListener("click", () => void openSetupApp(channel));
      }
      if (sender) sender.after(badge);
      else content.append(badge);
      observer.observe(html);
    },
  );
}

export function welcomeOnReady(): void {
  void postWelcomeLantern().catch((err: unknown) =>
    log.warn("could not post the welcome lantern", err),
  );
}
