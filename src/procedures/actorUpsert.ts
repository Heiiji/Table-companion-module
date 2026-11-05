import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import { gameUsers } from "../foundry/runtime.js";
import type { Procedure } from "../rpc/registry.js";
import {
  actorCollection,
  docId,
  alreadyApplied,
  assertBase,
  assertKnightUpsertAuthority,
  bindingFor,
  bindingOf,
  canonicalDigest,
  createActorDocument,
  foundryId,
  invalid,
  normalizedOwnership,
  parseStoredResult,
  uniqueBoundActor,
  type ActorLike,
  type BindingV1,
  type Outcome,
  FLAG_KEYS,
} from "./upsertShared.js";
import {
  ACTOR_TYPE,
  EQUIPMENT_COMPLETENESS,
  type ActorUpsertResultV1,
  type EquipmentCompleteness,
  type KnightActorUpsertV1,
  type SyncV1,
} from "./actorUpsert.types.js";
import { validateKnightActorUpsertV1 } from "./actorUpsert.validate.js";
import { applyCurrentResources, authoredPatch } from "./actorUpsert.patch.js";
import { applyMinorMotivations } from "./actorUpsert.motivations.js";
import { applyEquipment } from "./actorUpsert.equipment.js";

// The request/result shapes and the validator are part of this file's public
// surface; they live in siblings so each concern reads on its own.
export type {
  ActorUpsertResultV1,
  KnightActorUpsertV1,
} from "./actorUpsert.types.js";
export { validateKnightActorUpsertV1 } from "./actorUpsert.validate.js";

function assertRuntimeAndAuthority(req: KnightActorUpsertV1): void {
  assertKnightUpsertAuthority("actor.upsert.v1");
  if (req.foundryUserId && !gameUsers()?.get(req.foundryUserId))
    invalid("foundryUserId is not a User in this world");
}

function syncOf(actor: ActorLike): SyncV1 | null {
  const stored = parseStoredResult(actor, FLAG_KEYS.actorUpsert);
  if (!stored) return null;
  const { result, flag } = stored;
  if (
    (flag.state !== "draft" && flag.state !== "approved") ||
    !EQUIPMENT_COMPLETENESS.includes(String(flag.equipmentCompleteness))
  )
    return null;
  return {
    ...result,
    state: flag.state,
    equipmentCompleteness: flag.equipmentCompleteness as EquipmentCompleteness,
  };
}

function createActor(
  req: KnightActorUpsertV1,
  binding: BindingV1,
): Promise<ActorLike> {
  return createActorDocument({
    name: req.name,
    type: ACTOR_TYPE,
    flags: { [MODULE_ID]: { [FLAG_KEYS.binding]: binding } },
    ownership: normalizedOwnership(req.foundryUserId),
  });
}

/**
 * Durable Knight actor provisioning. Lookup is exclusively by the unique Table
 * Companion binding (or an explicit unbound assignedActorId); names are never a
 * key. Drafts write only name/flags/ownership. Approved requests add a fixed
 * allowlist of authored Knight source fields, then current resources in a
 * post-prepare pass. No caller-controlled Foundry paths are accepted.
 */
export const actorUpsertV1: Procedure = async (payload) => {
  const req = validateKnightActorUpsertV1(payload);
  assertRuntimeAndAuthority(req);
  const digest = await canonicalDigest(req);
  const binding = bindingFor(req);
  const collection = actorCollection();
  let actor = uniqueBoundActor(collection, binding);
  let outcome: Outcome = "updated";
  if (req.expectedActorId) {
    if (!actor)
      throw new RpcError(
        "deleted_link",
        "the previously linked Actor no longer exists",
      );
    if (docId(actor) !== req.expectedActorId)
      throw new RpcError(
        "binding_conflict",
        "the binding points at a different Actor",
      );
  }
  if (actor && req.assignedActorId && docId(actor) !== req.assignedActorId) {
    throw new RpcError(
      "binding_conflict",
      "assignedActorId differs from the bound Actor",
    );
  }

  if (!actor && req.assignedActorId) {
    actor = collection.get(req.assignedActorId);
    if (!actor)
      throw new RpcError("actor_not_found", "assignedActorId does not exist");
    if (actor.type !== ACTOR_TYPE)
      invalid("assignedActorId must identify a Knight actor");
    if (bindingOf(actor))
      throw new RpcError(
        "binding_conflict",
        "assignedActorId is already bound to another character",
      );
    outcome = "adopted";
  } else if (!actor) {
    actor = await createActor(req, binding);
    outcome = "created";
  }
  if (actor.type !== ACTOR_TYPE) invalid("bound Actor is not a Knight actor");
  const id = docId(actor);
  if (!foundryId.test(id))
    throw new Error("Foundry returned an invalid Actor id");

  const previous = syncOf(actor);
  if (
    previous &&
    alreadyApplied(previous, req.approvedRevision, digest, "approved")
  ) {
    return {
      schemaVersion: 1,
      resultDocId: id,
      outcome: previous.outcome,
      appliedRevision: previous.appliedRevision,
      appliedDigest: previous.appliedDigest,
      equipmentCompleteness: previous.equipmentCompleteness,
      warnings: [...previous.warnings],
    } satisfies ActorUpsertResultV1;
  }

  // The name the app last saw (`base.name`) guards the name write; a created
  // or just-adopted Actor has nothing the app saw to compare.
  const target = actor;
  if (outcome === "updated")
    assertBase(
      req,
      req.base,
      (field) => (field === "name" ? target.name : undefined),
      parseStoredResult(target, FLAG_KEYS.actorUpsert)?.flag.written,
    );
  await actor.update(authoredPatch(actor, req, binding));
  const motivationWarnings =
    req.state === "approved"
      ? await applyMinorMotivations(actor, req.profile!.minorMotivations)
      : [];
  const equipment =
    req.state === "approved"
      ? await applyEquipment(actor, req.equipment?.selections)
      : {
          equipmentCompleteness: "not_requested" as const,
          warnings: req.equipment?.selections.length
            ? ["equipment_deferred_until_approved"]
            : [],
        };
  // After the equipment: the worn gear (and the armour maxima) follow the
  // `armure` Item this call may have just imported or removed.
  actor.prepareData?.();
  const resourceWarnings =
    req.state === "approved"
      ? await applyCurrentResources(actor, req.resources)
      : [];
  const result: ActorUpsertResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome,
    appliedRevision: req.approvedRevision,
    appliedDigest: digest,
    equipmentCompleteness: equipment.equipmentCompleteness,
    warnings: [
      ...(req.foundryUserId ? [] : ["assign_foundry_user"]),
      ...motivationWarnings,
      ...resourceWarnings,
      ...equipment.warnings,
    ],
  };
  // `written` (the name Foundry now holds) serves the next base compare.
  const sync: SyncV1 & { written: { name?: string } } = {
    ...result,
    state: req.state,
    written: { name: target.name },
  };
  await actor.update({ [`flags.${MODULE_ID}.${FLAG_KEYS.actorUpsert}`]: sync });
  return result;
};
