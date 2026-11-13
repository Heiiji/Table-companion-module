import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import { gameUsers } from "../foundry/runtime.js";
import type { Procedure } from "../rpc/registry.js";
import {
  actorCollection,
  docId,
  alreadyApplied,
  replayDigests,
  assertBase,
  assertKnightUpsertAuthority,
  bindingFor,
  bindingOf,
  canonicalDigest,
  createActorDocument,
  assertOwnershipApplied,
  foundryId,
  invalid,
  normalizedOwnership,
  parseStoredResult,
  recordedFields,
  uniqueBoundActor,
  assertNotLost,
  assertTakeover,
  takeoverPatch,
  valueAt,
  type ActorLike,
  type Dict,
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
import {
  AUTHORED_PATHS,
  applyCurrentResources,
  authoredPatch,
} from "./actorUpsert.patch.js";
import { applyMinorMotivations } from "./actorUpsert.motivations.js";
import { applyEquipment } from "./actorUpsert.equipment.js";

/** The values of Knight's `system.origin` select (the being's nature). */
const KNIGHT_ORIGINS: readonly string[] = ["humain", "anatheme", "autre"];

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
    // Linked: damage dealt to the character's token on a scene lands on this
    // Actor, the one the backend reads. Set at creation only, then the GM's.
    prototypeToken: { actorLink: true },
  });
}

/** This Knight lane takes over an Actor another table holds. */
const TAKEOVER = { takeover: true } as const;

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
  let actor = uniqueBoundActor(collection, binding, req.expectedActorId);
  let outcome: Outcome = "updated";
  if (req.expectedActorId && !actor) {
    // The Actor the app names may be held by another table now: a take-over
    // (or `binding_lost` for a table that lost it). Unbound, it is a link the
    // Gamemaster removed, as before.
    const named = collection.get(req.expectedActorId);
    const bound = named ? bindingOf(named) : null;
    if (named && bound) {
      assertTakeover(
        bound,
        req,
        "the Actor is bound to another character",
        TAKEOVER,
      );
      actor = named;
    } else {
      assertNotLost(collection, req);
      throw new RpcError(
        "deleted_link",
        "the previously linked Actor no longer exists",
      );
    }
  }
  if (req.expectedActorId && actor) {
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
    const bound = bindingOf(actor);
    if (bound)
      assertTakeover(
        bound,
        req,
        "assignedActorId is already bound to another character",
        TAKEOVER,
      );
    outcome = "adopted";
  } else if (!actor) {
    assertNotLost(collection, req);
    actor = await createActor(req, binding);
    outcome = "created";
  }
  if (actor.type !== ACTOR_TYPE) invalid("bound Actor is not a Knight actor");
  const id = docId(actor);
  if (!foundryId.test(id))
    throw new Error("Foundry returned an invalid Actor id");

  // Taken over from another table: its records (revision, digest, written
  // fields) are that table's, so none is read here.
  const takeover = takeoverPatch(actor, req);
  const previous = takeover ? null : syncOf(actor);
  if (
    previous &&
    alreadyApplied(
      previous,
      req.approvedRevision,
      await replayDigests(req, actor, digest),
      "approved",
    )
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
  const lastWritten = takeover
    ? undefined
    : (parseStoredResult(target, FLAG_KEYS.actorUpsert)?.flag.written as
        Dict | undefined);
  if (outcome === "updated")
    assertBase(
      req,
      req.base,
      (field) => (field === "name" ? target.name : undefined),
      lastWritten,
    );
  const patch = { ...authoredPatch(actor, req, binding), ...takeover };
  // Foundry wins per field: an authored path the Gamemaster moved in Foundry
  // since this lane last wrote it (it holds neither that value nor the
  // requested one) is kept, the rest written. A path the record does not
  // name (an Actor drafted by an older build) is written as before.
  // ponytail: a Foundry edit back to exactly the value the lane last wrote
  // reads as unmoved, as assertBase's.
  const fields = recordedFields(lastWritten?.fields);
  const kept = new Set<string>();
  if (outcome === "updated")
    for (const path of AUTHORED_PATHS) {
      if (!(path in patch) || !(path in fields)) continue;
      const now = valueAt(target, path);
      if (now !== fields[path] && now !== patch[path]) {
        delete patch[path];
        kept.add(path);
      }
    }
  // Earlier builds wrote the app's free-text origin into `system.origin`, the
  // being's nature in Knight (`humain`, `anatheme` or `autre`). An Actor that
  // still holds the value the lane recorded gets the system's initial
  // `humain` back; any of the system's own values is left alone. The record
  // no longer names the path afterwards, so this runs once.
  const origin = fields["system.origin"];
  if (
    outcome === "updated" &&
    typeof origin === "string" &&
    !KNIGHT_ORIGINS.includes(origin) &&
    valueAt(target, "system.origin") === origin
  )
    patch["system.origin"] = "humain";
  await actor.update(patch);
  assertOwnershipApplied(actor, req.foundryUserId, "actor.upsert.v1");
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
      ...(kept.size > 0 ? [`foundry_kept:${kept.size}`] : []),
      ...(takeover ? ["binding_taken_over"] : []),
    ],
  };
  // `written` (the name and authored paths Foundry now holds) serves the next
  // base compare and the next pass's per-field check. A kept path keeps the
  // value this lane last wrote, so the Gamemaster's value still reads as
  // theirs at the next revision.
  const sync: SyncV1 & { written: { name?: string; fields: Dict } } = {
    ...result,
    state: req.state,
    written: {
      name: target.name,
      fields: Object.fromEntries(
        AUTHORED_PATHS.map((path) => [
          path,
          kept.has(path) ? fields[path] : valueAt(target, path),
        ]).filter(([, value]) => value !== undefined),
      ),
    },
  };
  await actor.update({ [`flags.${MODULE_ID}.${FLAG_KEYS.actorUpsert}`]: sync });
  return result;
};
