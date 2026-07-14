import type { ProcedureRegistry } from "../rpc/registry.js";
import { ping } from "./ping.js";
import { presence } from "./presence.js";
import { rollExecute } from "./rollExecute.js";
import { rollAction } from "./rollAction.js";
import { sheetDerived } from "./sheetDerived.js";
import { effectApply, effectRemove, effectSetValue } from "./effects.js";
import { compendiumIndex, compendiumGet } from "./compendium.js";
import { displayShow, displayClear } from "./display.js";
import { hasAuthenticatedModuleResponses } from "../rpc/trust.js";
import {
  isPF2eAdvancementRuntimeSupported,
  pf2eAdvancementApply,
  pf2eAdvancementPreview,
  pf2eOperationStatus,
} from "./pf2eAdvancement.js";

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
  // PF2e Remaster advancement is version-pinned and intentionally omitted from
  // capability advertisements on any other system/runtime. The handlers repeat
  // the guard so a stale/forged request can never bypass capability negotiation.
  if (isPF2eAdvancementRuntimeSupported()) {
    registry.register("pf2e.advancement.preview", pf2eAdvancementPreview);
    // Reserved consequential procedures stay dormant until module -> agent
    // replies are authenticated. Correlation ids are broadcast-visible and
    // cannot serve as an authorization/commit proof.
    if (hasAuthenticatedModuleResponses()) {
      registry.register("pf2e.advancement.apply", pf2eAdvancementApply);
      registry.register("pf2e.operation.status", pf2eOperationStatus);
    }
  }
}
