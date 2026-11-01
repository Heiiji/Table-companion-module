import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  clampToPrepared,
  hasPath,
  resourcePaths,
  valueAt,
} from "./actorUpsert.patch.js";
import {
  MAX_RESOURCE_VALUE,
  RESOURCE_KEYS,
  type ResourceKey,
} from "./actorUpsert.types.js";
import {
  SCHEMA_VERSION,
  actorCollection,
  docId,
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
  text,
  uniqueBoundActor,
  type Dict,
  type StoredResultV1,
  FLAG_KEYS,
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
 *
 * The request may also carry the character's `name` (with or without values).
 * With `previousName` it is a compare-and-set: an Actor renamed in Foundry
 * since the app last saw it refuses the request with `name_conflict` and
 * writes nothing, so Foundry's rename is the one the app adopts next.
 */

const ACTOR_TYPE = "knight";
export interface KnightActorResourcesV1 {
  schemaVersion: 1;
  actorType: "knight";
  worldId: string;
  tableId: string;
  characterId: string;
  expectedActorId: string;
  sequence: number;
  resources: Partial<Record<ResourceKey, number>>;
  name?: string;
  previousName?: string;
}

/** The longest Actor name accepted, as `actor.upsert.v1`. */
const MAX_NAME = 200;

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
    "name",
    "previousName",
  ]);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.actorType !== ACTOR_TYPE) invalid("actorType must be knight");
  const r =
    p.resources === undefined
      ? {}
      : record(p.resources, "resources", RESOURCE_KEYS);
  const resources: Partial<Record<ResourceKey, number>> = {};
  for (const key of RESOURCE_KEYS) {
    if (r[key] !== undefined)
      resources[key] = integer(
        r[key],
        `resources.${key}`,
        0,
        MAX_RESOURCE_VALUE,
      );
  }
  const name =
    p.name === undefined ? undefined : text(p.name, "name", MAX_NAME, true);
  if (p.previousName !== undefined && name === undefined)
    invalid("previousName needs a name");
  const previousName =
    p.previousName === undefined
      ? undefined
      : text(p.previousName, "previousName", MAX_NAME, true);
  if (Object.keys(resources).length === 0 && name === undefined)
    invalid("resources needs at least one value or a name");
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
    ...(name === undefined ? {} : { name }),
    ...(previousName === undefined ? {} : { previousName }),
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
  const id = docId(actor);
  if (actor.type !== ACTOR_TYPE || id !== req.expectedActorId)
    throw new RpcError(
      "binding_conflict",
      "the binding points at a different Actor",
    );

  const stored = parseStoredResult(actor, FLAG_KEYS.actorResources);
  const previous = stored?.result ?? null;
  if (previous && alreadyApplied(previous, req.sequence, digest, "sequence")) {
    return { ...previous, warnings: [...previous.warnings] };
  }
  // Compare-and-set on the name, after the replay above (an applied rename
  // re-sent under its own sequence replays). An Actor already carrying the
  // requested name has nothing to compare: the rename is in place.
  if (
    req.name !== undefined &&
    req.previousName !== undefined &&
    actor.name !== req.previousName &&
    actor.name !== req.name
  )
    throw new RpcError(
      "name_conflict",
      "the Actor was renamed in Foundry first",
    );

  const paths = resourcePaths(actor);
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
    value = clampToPrepared(actor, key, value, maxPath, warnings);
    // A value Foundry already holds is not re-written: a capped re-send
    // changes nothing on the Actor but the result flag below.
    if (valueAt(actor.system, path) !== value) patch[`system.${path}`] = value;
  }
  if (req.name !== undefined && actor.name !== req.name) patch.name = req.name;
  const result: ActorResourcesResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome: "updated",
    appliedRevision: req.sequence,
    appliedDigest: digest,
    warnings,
  };
  // A re-send of the values the flag already records, under a new sequence,
  // changes nothing: skip the write, or the flag update itself comes back from
  // the backend as an Actor change, the app re-sends, and the loop never ends.
  // Any other request writes the flag even with an empty patch: its
  // appliedRevision is what refuses an older sequence arriving later
  // (stale_revision). `contentDigest` lives in the flag only; the returned
  // result keeps the shape the backend decodes strictly.
  // Without a name the digest stays the one older flags recorded.
  const contentDigest = await canonicalDigest(
    req.name === undefined
      ? req.resources
      : { resources: req.resources, name: req.name },
  );
  if (
    Object.keys(patch).length === 0 &&
    stored?.flag.contentDigest === contentDigest
  )
    return result;
  await actor.update({
    ...patch,
    [`flags.${MODULE_ID}.${FLAG_KEYS.actorResources}`]: {
      ...result,
      contentDigest,
    },
  });
  return result;
};
