import type { ProcedureRegistry } from "../rpc/registry.js";
import { supportsKnightActorUpsertV1Runtime } from "./foundry.js";
import { ping } from "./ping.js";
import { presence } from "./presence.js";
import { rollExecute } from "./rollExecute.js";
import { compendiumIndex, compendiumGet } from "./compendium.js";
import { displayShow, displayClear } from "./display.js";
import { actorUpsertV1 } from "./actorUpsert.js";
import { npcUpsertV1 } from "./npcUpsert.js";

/** Register every built-in procedure. Each registration adds one capability to
 * the module's advertised set — a promise the apps feature-detect on, so
 * nothing is registered here that cannot succeed on THIS world. */
export function registerBuiltinProcedures(registry: ProcedureRegistry): void {
  registry.register("ping", ping, { kind: "read" });
  registry.register("presence", presence, { kind: "read" });
  // Foundry core formula evaluation only: returns dice and total, not a
  // system-specific check result. Genuinely system-agnostic (core Roll API).
  // Additive; the app falls back to its local formula engine when absent.
  registry.register("roll.execute", rollExecute, { kind: "read" });

  // Live library passthrough: surface content from the GM's own Foundry
  // compendiums as a transient section in the app. This access is not content
  // admission or redistribution rights; responses must never seed a bundled or
  // backend catalog.
  registry.register("compendium.index", compendiumIndex, { kind: "read" });
  registry.register("compendium.get", compendiumGet, { kind: "read" });
  // Shared-screen / projector display. Additive; when absent the app keeps its
  // "Now Showing" spotlight on the local network only. The "display.show"
  // capability is the app's feature-detect key. `clientState`, not `mutation`:
  // it opens a popout on connected browsers and writes no document.
  registry.register("display.show", displayShow, { kind: "clientState" });
  registry.register("display.clear", displayClear, { kind: "clientState" });
  // Consequential, signed-response-only actor provisioning. The agent refuses
  // to invoke these without moduleResponseSignatureV1; only Knight registers
  // the system-specific mappings. The two lanes target different Knight actor
  // types (PC "knight" vs NPC "pnj") and share ONE runtime gate — the pnj data
  // model is verified byte-identical 3.58.33 → 3.58.35, so a future gate
  // widening moves both together.
  if (supportsKnightActorUpsertV1Runtime()) {
    registry.register("actor.upsert.v1", actorUpsertV1, { kind: "mutation" });
    registry.register("npc.upsert.v1", npcUpsertV1, { kind: "mutation" });
  }
}
