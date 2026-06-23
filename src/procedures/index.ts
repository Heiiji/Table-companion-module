import type { ProcedureRegistry } from "../rpc/registry.js";
import { ping } from "./ping.js";
import { presence } from "./presence.js";
import { rollExecute } from "./rollExecute.js";
import { rollAction } from "./rollAction.js";
import { sheetDerived } from "./sheetDerived.js";
import { effectApply, effectRemove, effectSetValue } from "./effects.js";
import { compendiumIndex, compendiumGet } from "./compendium.js";
import { displayShow, displayClear } from "./display.js";

/** Register every built-in procedure. Each registration adds one capability to
 * the module's advertised set. */
export function registerBuiltinProcedures(registry: ProcedureRegistry): void {
  registry.register("ping", ping);
  registry.register("presence", presence);
  // M4: system-exact rolls via Foundry's dice pipeline (additive; app falls back to its local engine).
  registry.register("roll.execute", rollExecute);
  // Tier-1 oracle: per-system dashboard enrichment. sheet.derived exposes a prepared actor's
  // derived stats (saves/AC/DC/MAP/slot maxes); roll.action resolves system-contextual rolls
  // (pf2e degrees-of-success, dnd5e advantage, Knight aspect pools). Both additive + capability-
  // gated; absent ⇒ the app uses its locally-derived baseline / local dice engine (standalone-first).
  registry.register("sheet.derived", sheetDerived);
  registry.register("roll.action", rollAction);
  // Tier-1 system-aware writes: conditions / effects mutated through the system's own API so rule
  // side-effects fire (pf2e valued conditions, dnd5e concentration). Responder-gated; absent ⇒ the
  // app keeps the change in its local session. Mechanical embedded writes stay on the connector.
  registry.register("effect.apply", effectApply);
  registry.register("effect.remove", effectRemove);
  registry.register("effect.setValue", effectSetValue);
  // Phase 3 (augmented library): surface the GM's own compendium content so the app can merge it
  // with the backend catalog. Additive; absent ⇒ backend-only library.
  registry.register("compendium.index", compendiumIndex);
  registry.register("compendium.get", compendiumGet);
  // PNJ refactor (decision #3): shared-screen / projector display. Additive; absent
  // ⇒ the app keeps the "Now Showing" spotlight mesh-only. The "display.show"
  // capability is the app's feature-detect key.
  registry.register("display.show", displayShow);
  registry.register("display.clear", displayClear);
}
