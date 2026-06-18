import type { ProcedureRegistry } from "../rpc/registry.js";
import { ping } from "./ping.js";
import { presence } from "./presence.js";
import { rollExecute } from "./rollExecute.js";
import { compendiumIndex, compendiumGet } from "./compendium.js";

/** Register every built-in procedure. Each registration adds one capability to
 * the module's advertised set. */
export function registerBuiltinProcedures(registry: ProcedureRegistry): void {
  registry.register("ping", ping);
  registry.register("presence", presence);
  // M4: system-exact rolls via Foundry's dice pipeline (additive; app falls back to its local engine).
  registry.register("roll.execute", rollExecute);
  // Phase 3 (augmented library): surface the GM's own compendium content so the app can merge it
  // with the backend catalog. Additive; absent ⇒ backend-only library.
  registry.register("compendium.index", compendiumIndex);
  registry.register("compendium.get", compendiumGet);
}
