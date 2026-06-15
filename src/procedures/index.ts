import type { ProcedureRegistry } from "../rpc/registry.js";
import { ping } from "./ping.js";
import { presence } from "./presence.js";

/** Register every built-in procedure. Each registration adds one capability to
 * the module's advertised set. Future milestones register here:
 *   - M4: registry.register("roll.execute", rollExecute)  // pf2e/dnd5e/Knight
 */
export function registerBuiltinProcedures(registry: ProcedureRegistry): void {
  registry.register("ping", ping);
  registry.register("presence", presence);
}
