import type { ProcedureRegistry } from "../rpc/registry.js";
import { systemId } from "./foundry.js";
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
  const isPF2e = systemId() === "pf2e";

  registry.register("ping", ping);
  registry.register("presence", presence);
  // Foundry core formula evaluation only: returns dice/total, not a system check result or PF2e
  // degree. Additive; the app falls back to its local formula engine when absent.
  registry.register("roll.execute", rollExecute);
  // These generic system oracles remain available for systems whose current contracts support
  // them. PF2e deliberately advertises none of them: sheet.derived previously exposed a broad raw
  // prepared subtree, roll.action omitted spoiler/provenance data, and effect.* did not model PF2e
  // embedded condition Items exactly. Their handlers repeat this guard against stale/direct calls.
  // PF2e can regain only narrow, versioned procedures after the M8 fixture/authentication gate.
  if (!isPF2e) {
    registry.register("sheet.derived", sheetDerived);
    registry.register("roll.action", rollAction);
    registry.register("effect.apply", effectApply);
    registry.register("effect.remove", effectRemove);
    registry.register("effect.setValue", effectSetValue);
  }
  // Phase 3 live library passthrough: surface content from the GM's licensed/local Foundry session
  // as a transient world section. This access is not content admission or redistribution rights;
  // responses must never seed a bundled/backend catalog or telemetry corpus.
  registry.register("compendium.index", compendiumIndex);
  registry.register("compendium.get", compendiumGet);
  // PNJ refactor (decision #3): shared-screen / projector display. Additive; absent
  // ⇒ the app keeps the "Now Showing" spotlight mesh-only. The "display.show"
  // capability is the app's feature-detect key.
  registry.register("display.show", displayShow);
  registry.register("display.clear", displayClear);
}
