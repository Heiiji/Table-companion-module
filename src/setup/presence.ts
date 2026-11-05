import type { Channel } from "../rpc/channel.js";
import { isResponder } from "./election.js";
import { companionAnchorId, pairedAgentUserId } from "./identity.js";
import { log } from "../util/log.js";

/** True when at least one human GM is actually connected to this world. The
 * Companion service user is created with a non-GM role, so it is excluded by
 * role; it is also excluded by id (the paired user, the one this module
 * created) in case a GM elevates it — never by name, which anyone can carry. */
export function anyActiveGM(exceptUserId = ""): boolean {
  const excluded = [pairedAgentUserId(), companionAnchorId(), exceptUserId];
  const users = game.users?.contents ?? [];
  return users.some(
    (u) => u.active && u.isGM && !excluded.includes(u.id ?? ""),
  );
}

/**
 * Watches for GMs joining/leaving the Foundry world and pushes an active-GM
 * presence event to the agent (capability "presence"). Debounced so a flurry
 * of connect/disconnect hooks collapses into one emit, and only emits on change.
 */
export function startPresenceWatcher(channel: Channel): void {
  let last: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = () => {
    // Only the elected responder emits, mirroring the rest of the channel —
    // otherwise every connected GM client would push (N× traffic + flapping).
    if (!isResponder()) return;
    const activeGm = anyActiveGM();
    if (activeGm === last) return;
    last = activeGm;
    channel.emitEvent("presence", { activeGm });
    log.info(`presence: activeGm=${activeGm}`);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(publish, 1000);
  };

  // Foundry fires userConnected(user, connected) whenever another user joins
  // OR leaves; there is no userDisconnected hook.
  const hooks = Hooks as unknown as {
    on(hook: string, fn: () => void): number;
  };
  hooks.on("userConnected", schedule);
  // The last GM closing the tab: no GM client is left to observe the leave,
  // so say it on the way out. Best effort (the backend also learns it from
  // Foundry itself); a duplicate signal is harmless.
  globalThis.addEventListener?.("pagehide", () => {
    if (!isResponder() || anyActiveGM(game.user?.id ?? "")) return;
    channel.emitEvent("presence", { activeGm: false });
  });
  // Emit the initial state shortly after the channel starts so an already-live
  // agent learns the current GM presence without waiting for a connect event.
  schedule();
}
