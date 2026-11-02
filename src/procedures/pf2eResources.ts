import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  gameItems,
  pf2eConditionManager,
  type ActorItemLike,
} from "../foundry/runtime.js";
import { valueAt } from "./actorUpsert.patch.js";
import { PackLookup } from "./pf2eActorComplete.js";
import { hasUnresolvedChoice } from "./pf2eActorUpsert.js";
import {
  FLAG_KEYS,
  PF2E_REQUIREMENT,
  SCHEMA_VERSION,
  actorCollection,
  alreadyApplied,
  assertGMResponder,
  bindingFor,
  bindingId,
  bindingOf,
  canonicalDigest,
  contentsOf,
  docId,
  identifier,
  integer,
  invalid,
  parseStoredResult,
  record,
  supportsPf2eResourcesV1Runtime,
  text,
  uniqueBoundActor,
  type ActorLike,
  type Dict,
  type StoredResultV1,
} from "./upsertShared.js";

/**
 * Live counters of a Pathfinder 2e player character (`pf2e.resources.v1`):
 * hit points, temporary hit points, hero points, valued conditions, the
 * quantity of the inventory items the app mirrors, and catalog items the app
 * added. A FULL snapshot of what the app holds, not a list of operations: a
 * re-send converges by sequence and digest, and a newer snapshot supersedes an
 * older one.
 *
 * Every pf2e path and behaviour below is source-derived (pf2e 8.6.1), never
 * confirmed against a live world. The writes run in the GM responder's client
 * through pf2e's own APIs, so its clamps and follow-ups run as for a GM edit.
 * Never touched: prepared values, `system.abilities`, the level, ABC items,
 * coins, and any condition another item grants or locks.
 */

const PROCEDURE = "pf2e.resources.v1";
const ACTOR_TYPE = "character";
const EQUIPMENT_PACK = "pf2e.equipment-srd";

/** pf2e's `CONDITION_SLUGS` (source-derived, pf2e 8.6.1), minus
 * `persistent-damage`: pf2e opens a dialog to create it. */
export const PF2E_CONDITION_SLUGS = [
  "blinded",
  "broken",
  "clumsy",
  "concealed",
  "confused",
  "controlled",
  "cursebound",
  "dazzled",
  "deafened",
  "doomed",
  "drained",
  "dying",
  "encumbered",
  "enfeebled",
  "fascinated",
  "fatigued",
  "fleeing",
  "friendly",
  "frightened",
  "grabbed",
  "helpful",
  "hidden",
  "hostile",
  "immobilized",
  "indifferent",
  "invisible",
  "malevolence",
  "observed",
  "off-guard",
  "paralyzed",
  "petrified",
  "prone",
  "quickened",
  "restrained",
  "sickened",
  "slowed",
  "stunned",
  "stupefied",
  "unconscious",
  "undetected",
  "unfriendly",
  "unnoticed",
  "wounded",
] as const;

/** Conditions pf2e caps at `attributes.<slug>.max` (source-derived, pf2e 8.6.1
 * `ConditionManager.updateConditionValue`). */
const CAPPED = new Set(["dying", "wounded", "doomed"]);

/** pf2e's `PHYSICAL_ITEM_TYPES` (source-derived, pf2e 8.6.1). */
const PHYSICAL_TYPES = new Set([
  "ammo",
  "armor",
  "backpack",
  "book",
  "consumable",
  "equipment",
  "shield",
  "treasure",
  "weapon",
]);

const MAX_CONDITIONS = 50;
const MAX_ITEMS = 500;
const MAX_ADDS = 50;
const MAX_QUANTITY = 999_999;

/** Foundry's randomID(16) shape (Actor and Item ids). */
const documentId = /^[A-Za-z0-9]{16}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Pf2eResourcesAddV1 {
  key: string;
  slug: string;
  quantity: number;
}

export interface Pf2eActorResourcesV1 {
  schemaVersion: 1;
  actorType: "character";
  worldId: string;
  tableId: string;
  characterId: string;
  expectedActorId: string;
  sequence: number;
  hp?: number;
  hpTemp?: number;
  heroPoints?: number;
  /** Every condition slug the app holds, with its value; 0 removes. */
  conditions?: Record<string, number>;
  /** Desired quantity of each mirrored item by Foundry id; 0 deletes. */
  items?: Record<string, number>;
  /** Catalog items born in the app, idempotent by `key`. */
  adds?: Pf2eResourcesAddV1[];
}

export interface Pf2eResourcesResultV1 extends StoredResultV1 {
  /** The Foundry Item id of every `adds` key on the Actor. */
  created: Record<string, string>;
}

function map(
  value: unknown,
  path: string,
  max: number,
  key: (k: string) => boolean,
  top: number,
): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`${path} must be an object`);
  const entries = Object.entries(value as Dict);
  if (entries.length > max) invalid(`${path} holds more than ${max} entries`);
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (!key(k)) invalid(`${path}.${k} is not allowed`);
    out[k] = integer(v, `${path}.${k}`, 0, top);
  }
  return out;
}

const KNOWN_CONDITIONS: ReadonlySet<string> = new Set(PF2E_CONDITION_SLUGS);

export function validatePf2eActorResourcesV1(
  payload: unknown,
): Pf2eActorResourcesV1 {
  const p = record(payload, "pf2eResources", [
    "schemaVersion",
    "actorType",
    "worldId",
    "tableId",
    "characterId",
    "expectedActorId",
    "sequence",
    "hp",
    "hpTemp",
    "heroPoints",
    "conditions",
    "items",
    "adds",
  ]);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.actorType !== ACTOR_TYPE) invalid("actorType must be character");
  const req: Pf2eActorResourcesV1 = {
    schemaVersion: 1,
    actorType: ACTOR_TYPE,
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    characterId: identifier(p.characterId, "characterId", bindingId),
    expectedActorId: identifier(
      p.expectedActorId,
      "expectedActorId",
      documentId,
    ),
    sequence: integer(p.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
  };
  if (p.hp !== undefined) req.hp = integer(p.hp, "hp", 0, 9999);
  if (p.hpTemp !== undefined) req.hpTemp = integer(p.hpTemp, "hpTemp", 0, 999);
  if (p.heroPoints !== undefined)
    req.heroPoints = integer(p.heroPoints, "heroPoints", 0, 3);
  if (p.conditions !== undefined)
    req.conditions = map(
      p.conditions,
      "conditions",
      MAX_CONDITIONS,
      (k) => KNOWN_CONDITIONS.has(k),
      99,
    );
  if (p.items !== undefined)
    req.items = map(
      p.items,
      "items",
      MAX_ITEMS,
      (k) => documentId.test(k),
      MAX_QUANTITY,
    );
  if (p.adds !== undefined) {
    if (!Array.isArray(p.adds)) invalid("adds must be an array");
    if (p.adds.length > MAX_ADDS)
      invalid(`adds holds more than ${MAX_ADDS} entries`);
    const keys = new Set<string>();
    req.adds = (p.adds as unknown[]).map((raw, i) => {
      const a = record(raw, `adds[${i}]`, ["key", "slug", "quantity"]);
      const key = identifier(a.key, `adds[${i}].key`, uuid);
      if (keys.has(key)) invalid("adds holds a duplicate key");
      keys.add(key);
      const slug = text(a.slug, `adds[${i}].slug`, 64, true);
      if (!SLUG.test(slug))
        invalid(`adds[${i}].slug must be a lowercase hyphenated slug`);
      const quantity = integer(
        a.quantity,
        `adds[${i}].quantity`,
        1,
        MAX_QUANTITY,
      );
      return { key, slug, quantity };
    });
  }
  if (
    req.hp === undefined &&
    req.hpTemp === undefined &&
    req.heroPoints === undefined &&
    req.conditions === undefined &&
    req.items === undefined &&
    req.adds === undefined
  )
    invalid("pf2eResources needs at least one value");
  return req;
}

function finiteAt(root: unknown, path: string): number | undefined {
  const v = valueAt(root, path);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const itemsOf = (actor: ActorLike): ActorItemLike[] => contentsOf(actor.items);

function appKeyOf(item: ActorItemLike): unknown {
  const ns = item.flags?.[MODULE_ID];
  return typeof ns === "object" && ns !== null
    ? (ns as Dict).appInstanceId
    : undefined;
}

const byAppKey = (actor: ActorLike, key: string) =>
  itemsOf(actor).find((i) => appKeyOf(i) === key);

const conditionsOf = (actor: ActorLike, slug: string) =>
  itemsOf(actor).filter(
    (i) => i.type === "condition" && valueAt(i.system, "slug") === slug,
  );

/** The adapter's filter (source-derived, pf2e 8.6.1 `ConditionPF2e.isLocked`):
 * a condition another item granted, or one locked by a parent, is pf2e's to
 * move — never the app's. */
function isFree(item: ActorItemLike): boolean {
  if ((item as { isLocked?: unknown }).isLocked === true) return false;
  if (valueAt(item.flags, "pf2e.grantedBy") != null) return false;
  return valueAt(item.system, "references.parent") == null;
}

/** The `actor.update` keys whose value differs from the prepared Actor. */
function counterPatch(
  actor: ActorLike,
  req: Pf2eActorResourcesV1,
  warnings: string[],
): Dict {
  const patch: Dict = {};
  const set = (path: string, value: number) => {
    if (valueAt(actor.system, path) !== value) patch[`system.${path}`] = value;
  };
  // source-derived (pf2e 8.6.1) CreaturePF2e._preUpdate clamps hp.value to
  // max(hp.max − unrecoverable, 0); pre-clamped here so the warning is seen.
  if (req.hp !== undefined) {
    let hp = req.hp;
    const max = finiteAt(actor.system, "attributes.hp.max");
    if (max !== undefined) {
      const lost = finiteAt(actor.system, "attributes.hp.unrecoverable") ?? 0;
      const ceiling = Math.max(Math.floor(max - lost), 0);
      if (hp > ceiling) {
        hp = ceiling;
        warnings.push("resource_clamped:hp");
      }
    }
    set("attributes.hp.value", hp);
  }
  // An absolute value; pf2e clamps it to 0-999 itself.
  if (req.hpTemp !== undefined) set("attributes.hp.temp", req.hpTemp);
  // source-derived (pf2e 8.6.1): the prepared max is 3, or 0 for a mythic
  // character (mythic points replace hero points).
  if (req.heroPoints !== undefined) {
    let hero = req.heroPoints;
    const max = finiteAt(actor.system, "resources.heroPoints.max");
    if (max !== undefined && hero > max) {
      hero = Math.max(Math.floor(max), 0);
      warnings.push("hero_points_max");
    }
    set("resources.heroPoints.value", hero);
  }
  return patch;
}

type Write = () => Promise<void>;

/** Condition writes, by item id on free condition items only. */
function conditionWrites(
  actor: ActorLike,
  wanted: Record<string, number>,
  refusedBefore: ReadonlySet<string>,
  warnings: string[],
): Write[] {
  const writes: Write[] = [];
  for (const slug of Object.keys(wanted).sort()) {
    let value = wanted[slug];
    if (CAPPED.has(slug)) {
      const max = finiteAt(actor.system, `attributes.${slug}.max`);
      if (max !== undefined) value = Math.min(value, Math.max(max, 0));
    }
    const held = conditionsOf(actor, slug);
    const free = held.filter(isFree);
    if (free.length === 0) {
      if (held.length > 0) {
        // Only locked or granted instances: never duplicated, never removed.
        warnings.push(`condition_locked:${slug}`);
        continue;
      }
      if (value === 0) continue;
      // Refused last time with the same content (an immunity): not re-sent,
      // so the app's re-sends do not loop through pf2e's notification.
      if (refusedBefore.has(slug)) {
        warnings.push(`condition_refused:${slug}`);
        continue;
      }
      writes.push(async () => {
        await actor.increaseCondition!(slug, { value });
        // pf2e drops a condition the actor is immune to or unaffected by,
        // without an error (source-derived, pf2e 8.6.1).
        if (conditionsOf(actor, slug).length === 0)
          warnings.push(`condition_refused:${slug}`);
      });
      continue;
    }
    if (value === 0) {
      const ids = free.map(docId);
      writes.push(async () => {
        await actor.deleteEmbeddedDocuments!("Item", ids);
      });
      continue;
    }
    const target = free[0];
    const current = valueAt(target.system, "value.value");
    // A condition without a value (prone…) is present or absent only.
    if (typeof current === "number" && current !== value)
      writes.push(async () => {
        await pf2eConditionManager()!.updateConditionValue!(
          docId(target),
          actor,
          value,
        );
      });
  }
  return writes;
}

const isCoin = (item: ActorItemLike) =>
  item.type === "treasure" && valueAt(item.system, "category") === "coin";

/** Quantity writes on the mirrored physical items; 0 deletes. */
function itemWrites(
  actor: ActorLike,
  wanted: Record<string, number>,
  warnings: string[],
): Write[] {
  const writes: Write[] = [];
  const items = itemsOf(actor);
  for (const id of Object.keys(wanted).sort()) {
    const quantity = wanted[id];
    const item = items.find((i) => docId(i) === id);
    if (!item || !PHYSICAL_TYPES.has(String(item.type)) || isCoin(item)) {
      warnings.push(`item_unavailable:${id}`);
      continue;
    }
    if (quantity === 0) {
      // pf2e moves a deleted container's contents out of it (source-derived,
      // pf2e 8.6.1): they stay on the Actor, uncontained.
      if (
        item.type === "backpack" &&
        items.some((i) => valueAt(i.system, "containerId") === id)
      )
        warnings.push(`container_ejected:${id}`);
      writes.push(async () => {
        await actor.deleteEmbeddedDocuments!("Item", [id]);
      });
    } else if (valueAt(item.system, "quantity") !== quantity) {
      writes.push(async () => {
        await item.update!({ "system.quantity": quantity });
      });
    }
  }
  return writes;
}

/** Catalog adds: compendium sources by slug, each flagged with its app key.
 * Never stacked onto an existing Item (`inventory.add` would merge the app's
 * new row into another Foundry id). */
async function addSources(
  actor: ActorLike,
  adds: Pf2eResourcesAddV1[],
  created: Record<string, string>,
  warnings: string[],
): Promise<Array<{ add: Pf2eResourcesAddV1; source: Dict }>> {
  const out: Array<{ add: Pf2eResourcesAddV1; source: Dict }> = [];
  const lookup = new PackLookup();
  for (const add of adds) {
    const existing = byAppKey(actor, add.key);
    if (existing) {
      created[add.key] = docId(existing);
      continue;
    }
    const source = await lookup.source(EQUIPMENT_PACK, add.slug);
    if (source === "missing") {
      warnings.push(`item_not_found:${add.slug}`);
      continue;
    }
    if (hasUnresolvedChoice(source)) {
      warnings.push(`item_skipped_choiceset:${add.slug}`);
      continue;
    }
    const system = (source.system ?? {}) as Dict;
    const flags = (source.flags ?? {}) as Dict;
    source.system = { ...system, quantity: add.quantity };
    source.flags = {
      ...flags,
      [MODULE_ID]: {
        ...((flags[MODULE_ID] as Dict | undefined) ?? {}),
        appInstanceId: add.key,
      },
    };
    out.push({ add, source });
  }
  return out;
}

function storedCreated(flag: Dict): Record<string, string> {
  const c = flag.created;
  if (typeof c !== "object" || c === null || Array.isArray(c)) return {};
  return Object.fromEntries(
    Object.entries(c as Dict).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
}

export const pf2eResourcesV1: Procedure = async (payload) => {
  const req = validatePf2eActorResourcesV1(payload);
  assertGMResponder(PROCEDURE);
  if (!supportsPf2eResourcesV1Runtime())
    throw new RpcError(
      "unsupported_runtime",
      `${PROCEDURE} requires ${PF2E_REQUIREMENT}`,
    );
  if (typeof pf2eConditionManager()?.updateConditionValue !== "function")
    throw new RpcError(
      "unsupported_runtime",
      "game.pf2e.ConditionManager.updateConditionValue is unavailable",
    );
  if (typeof gameItems()?.fromCompendium !== "function")
    throw new RpcError(
      "unsupported_runtime",
      "game.items.fromCompendium is unavailable",
    );
  const digest = await canonicalDigest(req);
  const collection = actorCollection();
  let actor = uniqueBoundActor(collection, bindingFor(req));
  if (!actor) {
    // An imported character carries no binding: only the unbound Actor the
    // app names qualifies.
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
  if (
    typeof actor.increaseCondition !== "function" ||
    typeof actor.createEmbeddedDocuments !== "function" ||
    typeof actor.deleteEmbeddedDocuments !== "function"
  )
    throw new RpcError(
      "unsupported_runtime",
      "the pf2e Actor condition and item APIs are unavailable",
    );

  const stored = parseStoredResult(actor, FLAG_KEYS.pf2eResources);
  const previous = stored?.result ?? null;
  if (previous && alreadyApplied(previous, req.sequence, digest, "sequence"))
    return {
      ...previous,
      created: storedCreated(stored!.flag),
      warnings: [...previous.warnings],
    };

  const contentDigest = await canonicalDigest({ ...req, sequence: 0 });
  const sameContent = stored?.flag.contentDigest === contentDigest;
  const refusedBefore = new Set(
    sameContent
      ? previous!.warnings
          .filter((w) => w.startsWith("condition_refused:"))
          .map((w) => w.slice("condition_refused:".length))
      : [],
  );

  const warnings: string[] = [];
  const created: Record<string, string> = {};
  const patch = counterPatch(actor, req, warnings);
  const writes = [
    ...(req.conditions
      ? conditionWrites(actor, req.conditions, refusedBefore, warnings)
      : []),
    ...(req.items ? itemWrites(actor, req.items, warnings) : []),
  ];
  const adds = req.adds
    ? await addSources(actor, req.adds, created, warnings)
    : [];

  const result: Pf2eResourcesResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome: "updated",
    appliedRevision: req.sequence,
    appliedDigest: digest,
    created,
    warnings,
  };
  // Loop breaker, as the other live lanes: a new sequence re-sending what the
  // flag already records, with nothing to change, writes nothing.
  if (
    Object.keys(patch).length === 0 &&
    writes.length === 0 &&
    adds.length === 0 &&
    sameContent
  )
    return result;

  // Item and condition writes first, then ONE update carrying the counters
  // and the result flag: a failure part-way leaves the sequence unrecorded,
  // so the retry recomputes and finishes (adds are found again by their key).
  for (const write of writes) await write();
  if (adds.length > 0) {
    await actor.createEmbeddedDocuments!(
      "Item",
      adds.map((a) => a.source),
    );
    for (const { add } of adds) {
      const made = byAppKey(actor, add.key);
      if (made) created[add.key] = docId(made);
      else warnings.push(`item_refused:${add.slug}`);
    }
  }
  await actor.update({
    ...patch,
    [`flags.${MODULE_ID}.${FLAG_KEYS.pf2eResources}`]: {
      ...result,
      contentDigest,
    },
  });
  return result;
};
