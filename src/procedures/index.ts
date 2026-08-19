import type { ProcedureRegistry } from "../rpc/registry.js";
import { supportsKnightActorUpsertV1Runtime, systemId } from "./foundry.js";
import { ping } from "./ping.js";
import { presence } from "./presence.js";
import { rollExecute } from "./rollExecute.js";
import { rollAction } from "./rollAction.js";
import { sheetDerived } from "./sheetDerived.js";
import { effectApply, effectRemove } from "./effects.js";
import { compendiumIndex, compendiumGet } from "./compendium.js";
import { displayShow, displayClear } from "./display.js";
import { actorUpsertV1 } from "./actorUpsert.js";
import { npcUpsertV1 } from "./npcUpsert.js";

/**
 * Foundry systems with a verified, admitted contract for the system-aware
 * oracle procedures (`sheet.derived`, `roll.action`, `effect.*`).
 *
 * FAIL CLOSED: a system absent from this list gets none of them. This is the
 * PF2e clean-cut posture generalized — PF2e was carved out by name while every
 * other unknown system silently kept the whole surface, which had it backwards.
 * `roll.action` in particular was advertised on every non-PF2e world but
 * implements exactly `dnd5e` and `knight`; anywhere else it performed an Actor
 * lookup and an OWNER permission check and only THEN threw a generic
 * `procedure_failed`. `sheet.derived` was worse: for an unlisted system it
 * still exported the entire prepared `actor.system` subtree plus every embedded
 * Item's `system`, behind only an OBSERVER check, while returning an empty
 * `derived` — all of the exposure, none of the value.
 *
 * Adding a system here is a contract decision, not a convenience: it needs
 * fixtures proving the mapping for a pinned system version. See
 * ../../docs/game-systems/README.md.
 */
const ADMITTED_ORACLE_SYSTEMS = ["dnd5e", "knight"] as const;

/** Register every built-in procedure. Each registration adds one capability to
 * the module's advertised set — a promise the apps feature-detect on, so
 * nothing is registered here that cannot succeed on THIS world. */
export function registerBuiltinProcedures(registry: ProcedureRegistry): void {
  const system = systemId();
  const oracleAdmitted = (
    ADMITTED_ORACLE_SYSTEMS as readonly string[]
  ).includes(system);

  registry.register("ping", ping, { kind: "read" });
  registry.register("presence", presence, { kind: "read" });
  // Foundry core formula evaluation only: returns dice/total, not a system check result or PF2e
  // degree. Genuinely system-agnostic (core Roll API), so no `systems` gate.
  // Additive; the app falls back to its local formula engine when absent.
  registry.register("roll.execute", rollExecute, { kind: "read" });

  // The system-aware oracles. Advertised ONLY where a contract is admitted, so
  // the capability set means "this works here" rather than "this exists".
  // The handlers repeat their own guards against stale/direct calls.
  if (oracleAdmitted) {
    registry.register("sheet.derived", sheetDerived, {
      kind: "read",
      minPermission: "OBSERVER",
      systems: ADMITTED_ORACLE_SYSTEMS,
    });
    registry.register("roll.action", rollAction, {
      kind: "read",
      minPermission: "OWNER",
      systems: ADMITTED_ORACLE_SYSTEMS,
    });
    registry.register("effect.apply", effectApply, {
      kind: "mutation",
      minPermission: "OWNER",
      systems: ADMITTED_ORACLE_SYSTEMS,
    });
    registry.register("effect.remove", effectRemove, {
      kind: "mutation",
      minPermission: "OWNER",
      systems: ADMITTED_ORACLE_SYSTEMS,
    });
    // effect.setValue is NOT registered: no system ever had a working
    // implementation — it validated its arguments then threw unconditionally.
    // The handler survives as a rejecting tombstone in effects.ts.
  }

  // Phase 3 live library passthrough: surface content from the GM's licensed/local Foundry session
  // as a transient world section. This access is not content admission or redistribution rights;
  // responses must never seed a bundled/backend catalog or telemetry corpus.
  registry.register("compendium.index", compendiumIndex, { kind: "read" });
  registry.register("compendium.get", compendiumGet, { kind: "read" });
  // PNJ refactor (decision #3): shared-screen / projector display. Additive; absent
  // ⇒ the app keeps the "Now Showing" spotlight mesh-only. The "display.show"
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
    registry.register("actor.upsert.v1", actorUpsertV1, {
      kind: "mutation",
      minPermission: "OWNER",
      systems: ["knight"],
    });
    registry.register("npc.upsert.v1", npcUpsertV1, {
      kind: "mutation",
      minPermission: "OWNER",
      systems: ["knight"],
    });
  }
}
