import type { Procedure } from "../rpc/registry.js";
import { anyActiveGM } from "../setup/presence.js";

/** Pull form of the active-GM signal (the watcher also pushes it on change).
 * Registering it advertises the "presence" capability to the agent. */
export const presence: Procedure = () => ({ activeGm: anyActiveGM() });
