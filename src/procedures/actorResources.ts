import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { hasPath, wornGear } from "./actorUpsert.patch.js";
import {
  SCHEMA_VERSION,
  actorCollection,
  actorID,
  alreadyApplied,
  assertKnightUpsertAuthority,
  bindingFor,
  bindingId,
  bindingOf,
  canonicalDigest,
  identifier,
  integer,
  invalid,
  parseStoredResult,
  record,
  uniqueBoundActor,
  type Dict,
  type StoredResultV1,
} from "./upsertShared.js";

/**
 * Live current resources of a Knight player character (`actor.resources.v1`).
 * Provisioning (`actor.upsert.v1`) writes current values once per approved
 * revision; this lane re-pushes them on every edit made in the app. It touches
 * ONLY the Actor bound to the character (which must be the one the app expects)
 * or, for a character imported from Foundry, the unbound Actor the app names by
 * id: it never creates, binds, or matches by name. Values land on the
 * stored current fields (never a maximum), clamped to the prepared maximum
 * when the Actor exposes one. Re-sends converge by sequence/digest like the
 * provisioning lanes.
 */

const ACTOR_TYPE = "knight";
const RESOURCE_KEYS = [
  "health",
  "hope",
  "armour",
  "energy",
  "heroism",
  "contact",
] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

export interface KnightActorResourcesV1 {
  schemaVersion: 1;
  actorType: "knight";
  worldId: string;
  tableId: string;
  characterId: string;
  expectedActorId: string;
  sequence: number;
  resources: Partial<Record<ResourceKey, number>>;
}

export type ActorResourcesResultV1 = StoredResultV1;

/** Foundry's randomID(16) shape. */
const actorDocumentId = /^[A-Za-z0-9]{16}$/;

export function validateKnightActorResourcesV1(
  payload: unknown,
): KnightActorResourcesV1 {
  const p = record(payload, "actorResources", [
    "schemaVersion",
    "actorType",
    "worldId",
    "tableId",
    "characterId",
    "expectedActorId",
    "sequence",
    "resources",
  ]);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.actorType !== ACTOR_TYPE) invalid("actorType must be knight");
  const r = record(p.resources, "resources", RESOURCE_KEYS);
  const resources: Partial<Record<ResourceKey, number>> = {};
  for (const key of RESOURCE_KEYS) {
    if (r[key] !== undefined)
      resources[key] = integer(r[key], `resources.${key}`, 0, 9999);
  }
  if (Object.keys(resources).length === 0)
    invalid("resources needs at least one value");
  return {
    schemaVersion: 1,
    actorType: ACTOR_TYPE,
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    characterId: identifier(p.characterId, "characterId", bindingId),
    expectedActorId: identifier(
      p.expectedActorId,
      "expectedActorId",
      actorDocumentId,
    ),
    sequence: integer(p.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
    resources,
  };
}

function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Dict)[key];
  }
  return current;
}

/** Stored current path and prepared-maximum path of each resource (Knight
 * 3.58.33-35 PC model). Armour and energy live on the worn gear; their prepared
 * maxima are the top-level `armure.max` / `energie.max`. Contact has no max. */
function resourcePaths(gear: string): Record<ResourceKey, [string, string?]> {
  return {
    health: ["sante.value", "sante.max"],
    hope: ["espoir.value", "espoir.max"],
    armour: [`equipements.${gear}.armure.value`, "armure.max"],
    energy: [`equipements.${gear}.energie.value`, "energie.max"],
    heroism: ["heroisme.value", "heroisme.max"],
    contact: ["contacts.actuel"],
  };
}

export const actorResourcesV1: Procedure = async (payload) => {
  const req = validateKnightActorResourcesV1(payload);
  assertKnightUpsertAuthority("actor.resources.v1");
  const digest = await canonicalDigest(req);
  const collection = actorCollection();
  let actor = uniqueBoundActor(collection, bindingFor(req));
  if (!actor) {
    // A character imported from Foundry carries no binding: the app names the
    // Actor it was imported from. Only an unbound Actor qualifies, so a binding
    // owned by another character is never written through this path.
    actor = collection.get(req.expectedActorId);
    if (!actor)
      throw new RpcError("deleted_link", "the linked Actor no longer exists");
    if (bindingOf(actor))
      throw new RpcError(
        "binding_conflict",
        "the Actor is bound to another character",
      );
  }
  const id = actorID(actor);
  if (actor.type !== ACTOR_TYPE || id !== req.expectedActorId)
    throw new RpcError(
      "binding_conflict",
      "the binding points at a different Actor",
    );

  const previous = parseStoredResult(actor, "actorResourcesV1")?.result ?? null;
  if (previous && alreadyApplied(previous, req.sequence, digest, "sequence")) {
    return { ...previous, warnings: [...previous.warnings] };
  }

  const paths = resourcePaths(wornGear(actor));
  const patch: Dict = {};
  const warnings: string[] = [];
  for (const key of RESOURCE_KEYS) {
    let value = req.resources[key];
    if (value === undefined) continue;
    const [path, maxPath] = paths[key];
    if (!hasPath(actor.system, path)) {
      warnings.push(`resource_unavailable:${key}`);
      continue;
    }
    const max = maxPath ? valueAt(actor.system, maxPath) : undefined;
    if (typeof max === "number" && Number.isFinite(max) && value > max) {
      value = Math.max(0, Math.floor(max));
      warnings.push(`resource_clamped:${key}`);
    }
    patch[`system.${path}`] = value;
  }
  const result: ActorResourcesResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome: "updated",
    appliedRevision: req.sequence,
    appliedDigest: digest,
    warnings,
  };
  await actor.update({
    ...patch,
    [`flags.${MODULE_ID}.actorResourcesV1`]: result,
  });
  return result;
};
