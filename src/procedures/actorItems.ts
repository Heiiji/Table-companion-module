import { MODULE_ID } from "../constants.js";
import { gameItems, gamePacks } from "../foundry/runtime.js";
import { KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1 } from "../refdata/knightCompendiumCrosswalkV14_0_1.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { pairedAgentUser } from "../setup/identity.js";
import { compendiumAvailabilityWarning } from "./actorUpsert.equipment.js";
import { readable } from "./compendium.js";
import {
  assertKnightUpsertAuthority,
  canonicalDigest,
  contentsOf,
  docId,
  FLAG_KEYS,
  flagValue,
  linkedActor,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";
import {
  type ItemDoc,
  isDict,
  sameName,
  readFields,
  holds,
  sameValue,
} from "./actorItems.read.js";
import {
  type ItemKind,
  FOUNDRY_TYPE,
  type ItemSourceV1,
  type ActorItemsOpV1,
  validateKnightActorItemsV1,
  PROCEDURE,
  ACTOR_TYPE,
  type ActorItemsResultV1,
} from "./actorItems.validate.js";
import { fieldPatch } from "./actorItems.patch.js";

/**
 * Modules and weapons of a linked Knight player character
 * (`actor.items.v1`), one op per request: `add`, `update` or `remove` one
 * Item. Targeting is `actor.resources.v1`'s (the bound Actor, else the unbound
 * Knight Actor the app names); nothing is created, bound or matched by name.
 *
 * Each op converges on its own, so a re-send is harmless: an `add` whose
 * `entryId` already flags an Item updates that Item; an `update` is a
 * compare-and-set on the fields it moves (`item_conflict` when Foundry moved
 * one first, `item_missing` when the Item is gone); a `remove` of a missing
 * Item is applied, of a renamed one is `item_conflict`. Only the Item named by
 * id or `entryId` is ever touched. Created Items carry the `entryId` flag and
 * never the equipment-catalog flags, so `actor.upsert.v1` never reconciles
 * them away.
 */

// ------------------------------------------------------------- the procedure

const entryFlagPath = `flags.${MODULE_ID}.${FLAG_KEYS.entryId}`;

function actorItems(actor: ActorLike): ItemDoc[] {
  return contentsOf(actor.items) as ItemDoc[];
}

/** The Item to write, refused when it is not of the op's kind. */
function ofKind(item: ItemDoc, kind: ItemKind): ItemDoc {
  if (item.type !== FOUNDRY_TYPE[kind])
    throw new RpcError("item_conflict", `the Item is not a ${kind}`);
  return item;
}

async function applyPatch(item: ItemDoc, patch: Dict): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  if (typeof item.update !== "function")
    throw new RpcError("unsupported_runtime", "Item.update is unavailable");
  await item.update(patch);
}

/** The source document an `add` copies, or undefined when it must be built. */
async function copiedSource(
  source: ItemSourceV1,
  kind: ItemKind,
): Promise<{ raw: unknown; level?: number } | undefined> {
  if ("custom" in source) return undefined;
  if ("live" in source) {
    // The read lanes' visibility: only what the paired service user may
    // observe is copied; anything else is built from the app's fields.
    const { pack, docId: id } = source.live;
    const agent = pairedAgentUser();
    if (pack === "") {
      const doc = gameItems()?.get?.(id);
      return agent && doc?.testUserPermission?.(agent, "OBSERVER") === true
        ? { raw: doc.toObject() }
        : undefined;
    }
    const compendium = gamePacks()?.get(pack);
    if (!compendium || !readable(compendium, agent)) return undefined;
    const doc = await compendium.getDocument(id);
    return doc ? { raw: doc.toObject() } : undefined;
  }
  const mapped = KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1[source.catalogId];
  // One app row is one Item: a catalog entry made of several documents, or
  // of another type, is built instead.
  if (
    mapped?.length !== 1 ||
    mapped[0].itemType !== FOUNDRY_TYPE[kind] ||
    compendiumAvailabilityWarning() !== null
  )
    return undefined;
  const doc = await gamePacks()
    ?.get(mapped[0].pack)
    ?.getDocument(mapped[0].documentId);
  return doc
    ? { raw: doc.toObject(), level: mapped[0].moduleLevel }
    : undefined;
}

async function addItem(
  actor: ActorLike,
  add: Extract<ActorItemsOpV1, { add: unknown }>["add"],
  warnings: string[],
): Promise<string> {
  // Foundry's duplication copies the flag: the lowest id is the one.
  const flagged = actorItems(actor)
    .filter((item) => flagValue(item, FLAG_KEYS.entryId) === add.entryId)
    .sort((a, b) =>
      docId(a) < docId(b) ? -1 : docId(a) > docId(b) ? 1 : 0,
    )[0];
  if (flagged) {
    // A re-send: the Item is already there, so the add converges as an update.
    const item = ofKind(flagged, add.kind);
    await applyPatch(
      item,
      fieldPatch(item, add.kind, add.item, false, warnings),
    );
    return docId(item);
  }
  if (typeof actor.createEmbeddedDocuments !== "function")
    throw new RpcError(
      "unsupported_runtime",
      "Actor.createEmbeddedDocuments is unavailable",
    );
  const copy = await copiedSource(add.source, add.kind);
  const type = FOUNDRY_TYPE[add.kind];
  let source: Dict;
  if (copy && isDict(copy.raw) && copy.raw.type === type) {
    source = { ...copy.raw };
    delete source._id;
    delete source._stats;
    delete source.folder;
    delete source.ownership;
  } else {
    warnings.push("item_built");
    source = { name: add.item.name, type, system: {} };
  }
  // Only the entry identity: never the equipment-catalog flags, which would
  // hand the Item to actor.upsert's reconciliation.
  source.flags = {
    ...(isDict(source.flags) ? source.flags : {}),
    [MODULE_ID]: { [FLAG_KEYS.entryId]: add.entryId },
  };
  const created = await actor.createEmbeddedDocuments("Item", [source]);
  const item =
    (Array.isArray(created)
      ? (created[0] as ItemDoc | undefined)
      : undefined) ??
    actorItems(actor).find(
      (i) => flagValue(i, FLAG_KEYS.entryId) === add.entryId,
    );
  if (!item) throw new Error("Foundry did not return the created Item");
  const fields =
    add.item.level === undefined && copy?.level !== undefined
      ? { ...add.item, level: copy.level }
      : add.item;
  await applyPatch(
    item,
    fieldPatch(
      item,
      add.kind,
      fields,
      warnings.includes("item_built"),
      warnings,
    ),
  );
  return docId(item);
}

export const actorItemsV1: Procedure = async (payload) => {
  const req = validateKnightActorItemsV1(payload);
  assertKnightUpsertAuthority(PROCEDURE);
  const digest = await canonicalDigest(req);
  const actor = linkedActor(req, ACTOR_TYPE);
  const warnings: string[] = [];
  const result = (itemId: string): ActorItemsResultV1 => ({
    schemaVersion: 1,
    resultDocId: docId(actor),
    outcome: "updated",
    appliedDigest: digest,
    warnings,
    itemId,
  });
  const op = req.op;
  if ("add" in op) return result(await addItem(actor, op.add, warnings));

  const { itemId, kind } = "update" in op ? op.update : op.remove;
  const found = actorItems(actor).find((item) => docId(item) === itemId);
  if ("remove" in op) {
    if (!found) return result(itemId);
    const item = ofKind(found, kind);
    if (!sameName(item, op.remove.expectedName, true))
      throw new RpcError("item_conflict", "the Item was renamed in Foundry");
    if (typeof actor.deleteEmbeddedDocuments !== "function")
      throw new RpcError(
        "unsupported_runtime",
        "Actor.deleteEmbeddedDocuments is unavailable",
      );
    await actor.deleteEmbeddedDocuments("Item", [itemId]);
    return result(itemId);
  }

  const { item: fields, expected, entryId } = op.update;
  if (!found) throw new RpcError("item_missing", "the Item no longer exists");
  const item = ofKind(found, kind);
  const current = readFields(item, kind) as Dict;
  // An update that already landed (a re-send after a timeout) is applied, not
  // a conflict: only the entry stamp, if still missing, is written.
  if (
    Object.entries(fields).every(([key, v]) => holds(item, current, key, v))
  ) {
    if (entryId !== undefined && flagValue(item, FLAG_KEYS.entryId) !== entryId)
      await applyPatch(item, { [entryFlagPath]: entryId });
    return result(itemId);
  }
  for (const [key, value] of Object.entries(expected))
    if (
      key === "name"
        ? !sameName(item, value, true)
        : !sameValue(current[key], value)
    )
      throw new RpcError("item_conflict", `the Item's ${key} moved in Foundry`);
  const patch = fieldPatch(item, kind, fields, false, warnings);
  if (entryId !== undefined) patch[entryFlagPath] = entryId;
  await applyPatch(item, patch);
  return result(itemId);
};
