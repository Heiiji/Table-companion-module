import type { Channel } from "../rpc/channel.js";
import { isResponder } from "./election.js";
import { COMPANION_USER_NAME } from "./companion-user.js";
import { log } from "../util/log.js";

/** True when at least one human GM is actually connected to this world. The
 * Companion service user is created with a non-GM role, so it is excluded by
 * role; we also exclude it by name as defense-in-depth in case a GM elevates it. */
export function anyActiveGM(): boolean {
  const users = game.users?.contents ?? [];
  return users.some(
    (u) => u.active && u.isGM && u.name !== COMPANION_USER_NAME,
  );
}

/**
 * Watches for GMs joining/leaving the Foundry world and pushes an active-GM
 * presence event to the agent (capability "presence", H5). Debounced so a flurry
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

  // userConnected/userDisconnected fire when a user's active state changes.
  const hooks = Hooks as unknown as {
    on(hook: string, fn: () => void): number;
  };
  hooks.on("userConnected", schedule);
  hooks.on("userDisconnected", schedule);
  // Emit the initial state shortly after the channel starts so an already-live
  // agent learns the current GM presence without waiting for a connect event.
  schedule();
}
