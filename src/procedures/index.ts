import type { ProcedureRegistry } from "../rpc/registry.js";
import { ping } from "./ping.js";
import { presence } from "./presence.js";
import { rollExecute } from "./rollExecute.js";
import { compendiumIndex, compendiumGet } from "./compendium.js";
import { displayShow, displayClear } from "./display.js";
import { actorUpsertV1 } from "./actorUpsert.js";
import { npcUpsertV1 } from "./npcUpsert.js";
import { actorResourcesV1 } from "./actorResources.js";
import {
  MINIMUM_COMBAT_SYNC_FOUNDRY_GENERATION,
  combatSyncV1,
  supportsCombatSyncV1Runtime,
} from "./combatSync.js";
import {
  KNIGHT_UPSERT_SYSTEM_VERSION_LABEL,
  MINIMUM_KNIGHT_UPSERT_FOUNDRY_GENERATION,
  supportsKnightActorUpsertV1Runtime,
} from "./upsertShared.js";
import {
  foundryGeneration,
  systemId,
  systemVersion,
} from "../foundry/runtime.js";

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
  // Consequential, signed-response-only actor provisioning: `signedOnly` keeps
  // them unadvertised and refused on a responder that cannot sign its replies,
  // and the agent refuses to invoke them without moduleResponseSignatureV1.
  // Only Knight registers the system-specific mappings. The two lanes target different Knight actor
  // types (PC "knight" vs NPC "pnj") and share ONE runtime gate over one list of
  // admitted Knight versions, so a widening moves both together.
  // Mirror of the app's combat into a Foundry Combat. Combat and Combatant are
  // core documents, so every system gets it, from the Foundry generation the
  // mapping was checked on (13, the module's own minimum). Signed-only and a
  // mutation like the provisioning lanes.
  if (supportsCombatSyncV1Runtime()) {
    registry.register("combat.sync.v1", combatSyncV1, {
      kind: "mutation",
      signedOnly: true,
    });
  } else if (foundryGeneration() > 0) {
    registry.markUnsupported(
      "combat.sync.v1",
      `Foundry ${foundryGeneration()}; requires Foundry ${MINIMUM_COMBAT_SYNC_FOUNDRY_GENERATION} or later`,
    );
  }
  if (supportsKnightActorUpsertV1Runtime()) {
    registry.register("actor.upsert.v1", actorUpsertV1, {
      kind: "mutation",
      signedOnly: true,
    });
    registry.register("npc.upsert.v1", npcUpsertV1, {
      kind: "mutation",
      signedOnly: true,
    });
    // Live current resources of an already-provisioned PC: same gate, same
    // signed-only posture, bound Actor only.
    registry.register("actor.resources.v1", actorResourcesV1, {
      kind: "mutation",
      signedOnly: true,
    });
  } else if (systemId() === "knight") {
    // Another Knight or Foundry release: the lanes stay unregistered, and the
    // handshake says why, so the backend parks the GM's characters as « not
    // supported on this version » rather than « no module ».
    const reason =
      `Knight ${systemVersion() || "unknown"} on Foundry ${foundryGeneration() || "unknown"}; ` +
      `requires Knight ${KNIGHT_UPSERT_SYSTEM_VERSION_LABEL} on Foundry ${MINIMUM_KNIGHT_UPSERT_FOUNDRY_GENERATION} or later`;
    registry.markUnsupported("actor.upsert.v1", reason);
    registry.markUnsupported("npc.upsert.v1", reason);
    registry.markUnsupported("actor.resources.v1", reason);
  }
}
