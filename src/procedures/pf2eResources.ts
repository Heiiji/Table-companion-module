import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import { canonicalize } from "../util/canonicalJson.js";
import { escapeHtml } from "../util/html.js";
import type { Procedure } from "../rpc/registry.js";
import {
  gameItems,
  pf2eConditionManager,
  type ActorItemLike,
} from "../foundry/runtime.js";
import { PackLookup, hasUnresolvedChoice } from "./pf2ePacks.js";
import {
  FLAG_KEYS,
  PF2E_RESOURCES_REQUIREMENT,
  LIVE_HEADER_KEYS,
  alreadyApplied,
  assertBase,
  assertLaneAuthority,
  canonicalDigest,
  contentsOf,
  docId,
  documentId,
  finiteAt,
  hasPf2eCurrencyApis,
  identifier,
  integer,
  invalid,
  linkedActor,
  list,
  liveHeader,
  liveSequence,
  oneOf,
  parseStoredResult,
  record,
  supportsPf2eResourcesV1Runtime,
  text,
  uuid,
  valueAt,
  writtenFields,
  type LiveHeaderV1,
  type ActorLike,
  type Dict,
  type StoredResultV1,
} from "./upsertShared.js";

/**
 * Live counters of a Pathfinder 2e player character (`pf2e.resources.v1`):
 * hit points, temporary hit points, hero points, valued conditions, the
 * quantity of the inventory items the app mirrors, and catalog items the app
 * added; with the `pf2eSheetWritesV1` token also the purse (`coins`), items
 * born in the app without a compendium slug (`customAdds`) and the spell slots,
 * focus points and innate uses (`spellcasting`). A FULL snapshot of what the app holds, not a list of operations: a
 * re-send converges by sequence and digest, and a newer snapshot supersedes an
 * older one.
 *
 * With the `pf2eNpcWritesV1` token the same request writes a pf2e `npc`
 * Actor (`actorType: "npc"`): hit points, temporary hit points, conditions,
 * item quantities and spellcasting, on the same paths (pf2e 8.6.1: the hp
 * clamp, condition and inventory APIs are every creature's, spellcasting
 * entries exist on characters and npcs). An npc has no hero points, and its
 * purse and item adds are not written. Its focus pool is stored, max included;
 * pf2e prepares that stored pool (capped at 3) and clamps to it, so the
 * character clamp below applies unchanged.
 *
 * Every pf2e path and behaviour below is source-derived (pf2e 8.6.1; the
 * sheet groups' paths are identical at 8.5.1), never confirmed against a live
 * world. The writes run in the GM responder's client through pf2e's own APIs,
 * so its clamps and follow-ups run as for a GM edit. Never touched: prepared
 * values, `system.abilities`, the level, ABC items, coins through `items`,
 * and any condition another item grants or locks.
 */

const PROCEDURE = "pf2e.resources.v1";
const ACTOR_TYPES = ["character", "npc"] as const;
type ActorType = (typeof ACTOR_TYPES)[number];
/** The groups an npc request never names (`base` only takes the first two). */
const NOT_ON_NPC = ["heroPoints", "coins", "adds", "customAdds"] as const;
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

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The denominations `coins` names, in write order. Credits and upb are
 * pf2e's Starfinder units: never read, never written. */
const DENOMINATIONS = ["pp", "gp", "sp", "cp"] as const;
type Denomination = (typeof DENOMINATIONS)[number];
const MAX_CUSTOM_ADDS = 50;
const CUSTOM_ITEM_TYPES = [
  "equipment",
  "consumable",
  "backpack",
  "treasure",
] as const;
const RARITIES = ["common", "uncommon", "rare", "unique"] as const;
const MAX_SPELL_ENTRIES = 16;
const MAX_PREPARED = 30;
const MAX_INNATE = 100;
/** pf2e's `slot0`..`slot10` (source-derived, pf2e 8.5.1 and 8.6.1
 * `item/spellcasting-entry/data.ts:8-9`). */
const RANKS = Array.from({ length: 11 }, (_, r) => String(r));
/** C0 and C1 control characters, DEL included. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The same, but a tab, line feed or carriage return (notes are prose). */
const CONTROL_IN_NOTES =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export interface Pf2eResourcesAddV1 {
  key: string;
  slug: string;
  quantity: number;
}

/** The absolute TOTAL of each denomination the request names. */
export type Pf2eCoinsV1 = Partial<Record<Denomination, number>>;

/** An item born in the app with no compendium slug. */
export interface Pf2eResourcesCustomAddV1 {
  key: string;
  name: string;
  itemType: (typeof CUSTOM_ITEM_TYPES)[number];
  quantity: number;
  level: number;
  priceCopper: number;
  bulkTenths: number;
  rarity: (typeof RARITIES)[number];
  notes?: string;
}

export interface Pf2ePreparedSlotV1 {
  id: string | null;
  expended: boolean;
}

/** The absolute targets of one rank of a spellcasting entry. */
export interface Pf2eSlotTargetV1 {
  value?: number;
  /** The FULL prepared array of that rank. */
  prepared?: Pf2ePreparedSlotV1[];
}

export interface Pf2eSpellcastingV1 {
  /** By spellcasting-entry Item id, then rank "0".."10". */
  entries?: Record<string, Record<string, Pf2eSlotTargetV1>>;
  focus?: number;
  /** By innate spell Item id. */
  innateUses?: Record<string, number>;
}

export interface Pf2eActorResourcesV1 extends LiveHeaderV1<ActorType> {
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
  coins?: Pf2eCoinsV1;
  /** Items without a slug, idempotent by `key`, never in `base`. */
  customAdds?: Pf2eResourcesCustomAddV1[];
  spellcasting?: Pf2eSpellcastingV1;
  /** The values the app last saw in Foundry, same keys and bounds as the
   * counters above (never `adds` / `customAdds`): the compare-and-set guard
   * of every value both name. */
  base?: Pf2eCountersV1;
}

/** The keys a `base` may name: every written value but the adds. */
const COUNTER_KEYS = [
  "hp",
  "hpTemp",
  "heroPoints",
  "conditions",
  "items",
  "coins",
  "spellcasting",
] as const;
type Pf2eCountersV1 = Pick<Pf2eActorResourcesV1, (typeof COUNTER_KEYS)[number]>;

export interface Pf2eResourcesResultV1 extends StoredResultV1 {
  /** The Foundry Item id of every `adds` and `customAdds` key on the Actor. */
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

/** The counters of a request (`at` "") or of its base (`at` "base."). */
function parseCounters(p: Dict, at: string): Pf2eCountersV1 {
  const out: Pf2eCountersV1 = {};
  if (p.hp !== undefined) out.hp = integer(p.hp, `${at}hp`, 0, 9999);
  if (p.hpTemp !== undefined)
    out.hpTemp = integer(p.hpTemp, `${at}hpTemp`, 0, 999);
  if (p.heroPoints !== undefined)
    out.heroPoints = integer(p.heroPoints, `${at}heroPoints`, 0, 3);
  if (p.conditions !== undefined)
    out.conditions = map(
      p.conditions,
      `${at}conditions`,
      MAX_CONDITIONS,
      (k) => KNOWN_CONDITIONS.has(k),
      99,
    );
  if (p.items !== undefined)
    out.items = map(
      p.items,
      `${at}items`,
      MAX_ITEMS,
      (k) => documentId.test(k),
      MAX_QUANTITY,
    );
  if (p.coins !== undefined) out.coins = parseCoins(p.coins, `${at}coins`);
  if (p.spellcasting !== undefined)
    out.spellcasting = parseSpellcasting(p.spellcasting, `${at}spellcasting`);
  return out;
}

function parseCoins(value: unknown, path: string): Pf2eCoinsV1 {
  const c = record(value, path, DENOMINATIONS);
  const out: Pf2eCoinsV1 = {};
  for (const d of DENOMINATIONS)
    if (c[d] !== undefined)
      out[d] = integer(c[d], `${path}.${d}`, 0, MAX_QUANTITY);
  if (Object.keys(out).length === 0)
    invalid(`${path} needs at least one denomination`);
  return out;
}

function parseSpellcasting(value: unknown, path: string): Pf2eSpellcastingV1 {
  const s = record(value, path, ["entries", "focus", "innateUses"]);
  const out: Pf2eSpellcastingV1 = {};
  if (s.entries !== undefined) {
    const entries = record(
      s.entries,
      `${path}.entries`,
      Object.keys((s.entries ?? {}) as Dict),
    );
    const ids = Object.keys(entries);
    if (ids.length > MAX_SPELL_ENTRIES)
      invalid(`${path}.entries holds more than ${MAX_SPELL_ENTRIES} entries`);
    out.entries = {};
    for (const id of ids) {
      const at = `${path}.entries.${id}`;
      if (!documentId.test(id)) invalid(`${at} is not allowed`);
      const ranks = record(entries[id], at, RANKS);
      const parsed: Record<string, Pf2eSlotTargetV1> = {};
      for (const [rank, raw] of Object.entries(ranks)) {
        const r = record(raw, `${at}.${rank}`, ["value", "prepared"]);
        const slot: Pf2eSlotTargetV1 = {};
        if (r.value !== undefined)
          slot.value = integer(r.value, `${at}.${rank}.value`, 0, 99);
        if (r.prepared !== undefined)
          slot.prepared = list(
            r.prepared,
            `${at}.${rank}.prepared`,
            MAX_PREPARED,
          ).map((rawSlot, i) => {
            const where = `${at}.${rank}.prepared[${i}]`;
            const p = record(rawSlot, where, ["id", "expended"]);
            if (typeof p.expended !== "boolean")
              invalid(`${where}.expended must be a boolean`);
            return {
              id:
                p.id === null
                  ? null
                  : identifier(p.id, `${where}.id`, documentId),
              expended: p.expended,
            };
          });
        parsed[rank] = slot;
      }
      out.entries[id] = parsed;
    }
  }
  if (s.focus !== undefined)
    out.focus = integer(s.focus, `${path}.focus`, 0, 3);
  if (s.innateUses !== undefined)
    out.innateUses = map(
      s.innateUses,
      `${path}.innateUses`,
      MAX_INNATE,
      (k) => documentId.test(k),
      99,
    );
  if (
    out.entries === undefined &&
    out.focus === undefined &&
    out.innateUses === undefined
  )
    invalid(`${path} needs at least one member`);
  return out;
}

const CUSTOM_ADD_KEYS = [
  "key",
  "name",
  "itemType",
  "quantity",
  "level",
  "priceCopper",
  "bulkTenths",
  "rarity",
  "notes",
] as const;

function parseCustomAdd(raw: unknown, i: number): Pf2eResourcesCustomAddV1 {
  const at = `customAdds[${i}]`;
  const a = record(raw, at, CUSTOM_ADD_KEYS);
  const name = text(a.name, `${at}.name`, 120, true);
  if (CONTROL.test(name)) invalid(`${at}.name contains a control character`);
  const add: Pf2eResourcesCustomAddV1 = {
    key: identifier(a.key, `${at}.key`, uuid),
    name,
    itemType: oneOf(a.itemType, `${at}.itemType`, CUSTOM_ITEM_TYPES),
    quantity: integer(a.quantity, `${at}.quantity`, 1, MAX_QUANTITY),
    level: integer(a.level, `${at}.level`, 0, 30),
    priceCopper: integer(a.priceCopper, `${at}.priceCopper`, 0, 1_000_000_000),
    bulkTenths: integer(a.bulkTenths, `${at}.bulkTenths`, 0, 1_000_000),
    rarity: oneOf(a.rarity, `${at}.rarity`, RARITIES),
  };
  if (a.notes !== undefined) {
    add.notes = text(a.notes, `${at}.notes`, 4000);
    if (CONTROL_IN_NOTES.test(add.notes))
      invalid(`${at}.notes contains a control character`);
  }
  return add;
}

export function validatePf2eActorResourcesV1(
  payload: unknown,
): Pf2eActorResourcesV1 {
  const p = record(payload, "pf2eResources", [
    ...LIVE_HEADER_KEYS,
    "sequence",
    "hp",
    "hpTemp",
    "heroPoints",
    "conditions",
    "items",
    "adds",
    "coins",
    "customAdds",
    "spellcasting",
    "base",
  ]);
  if (!(ACTOR_TYPES as readonly unknown[]).includes(p.actorType))
    invalid("actorType must be character or npc");
  const req: Pf2eActorResourcesV1 = {
    ...liveHeader(p, p.actorType as ActorType),
    sequence: liveSequence(p),
  };
  // Named before any bound: what an npc never takes is refused as such.
  if (req.actorType === "npc") {
    const base = (
      typeof p.base === "object" && p.base !== null ? p.base : {}
    ) as Dict;
    for (const g of NOT_ON_NPC) {
      if (p[g] !== undefined) invalid(`${g} is not written on an npc`);
      if (base[g] !== undefined) invalid(`base.${g} is not written on an npc`);
    }
  }
  Object.assign(req, parseCounters(p, ""));
  if (p.base !== undefined)
    req.base = parseCounters(record(p.base, "base", COUNTER_KEYS), "base.");
  // One key space across `adds` and `customAdds`: both land as flagged Items.
  const keys = new Set<string>();
  if (p.adds !== undefined) {
    if (!Array.isArray(p.adds)) invalid("adds must be an array");
    if (p.adds.length > MAX_ADDS)
      invalid(`adds holds more than ${MAX_ADDS} entries`);
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
  if (p.customAdds !== undefined) {
    if (!Array.isArray(p.customAdds)) invalid("customAdds must be an array");
    if (p.customAdds.length > MAX_CUSTOM_ADDS)
      invalid(`customAdds holds more than ${MAX_CUSTOM_ADDS} entries`);
    req.customAdds = (p.customAdds as unknown[]).map((raw, i) => {
      const add = parseCustomAdd(raw, i);
      if (keys.has(add.key))
        invalid("adds and customAdds hold a duplicate key");
      keys.add(add.key);
      return add;
    });
  }
  if (
    req.hp === undefined &&
    req.hpTemp === undefined &&
    req.heroPoints === undefined &&
    req.conditions === undefined &&
    req.items === undefined &&
    req.adds === undefined &&
    req.coins === undefined &&
    req.customAdds === undefined &&
    req.spellcasting === undefined
  )
    invalid("pf2eResources needs at least one value");
  return req;
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
  // source-derived (pf2e 8.5.1 creature/document.ts:493-494, 949-950; 8.6.1
  // :506-507, 979-980): the prepared focus max is clamped to its cap, and an
  // update above it is clamped; pre-clamped here so the warning is seen.
  const focus = req.spellcasting?.focus;
  if (focus !== undefined) {
    let value = focus;
    const max = finiteAt(actor.system, "resources.focus.max");
    if (max !== undefined && value > max) {
      value = Math.max(Math.floor(max), 0);
      warnings.push("focus_clamped");
    }
    set("resources.focus.value", value);
  }
  return patch;
}

type Write = () => Promise<void>;

/** Where each scalar counter lives (source-derived, pf2e 8.6.1). */
const COUNTER_PATHS: Record<string, string> = {
  hp: "attributes.hp.value",
  hpTemp: "attributes.hp.temp",
  heroPoints: "resources.heroPoints.value",
  "spellcasting.focus": "resources.focus.value",
};

/** Foundry's current value of a `base` field, in the request's terms; a
 * value the lane would not write (a locked condition, an unavailable item)
 * reads `undefined`. */
function currentValue(actor: ActorLike, field: string): unknown {
  const dot = field.indexOf(".");
  const group = dot < 0 ? field : field.slice(0, dot);
  const key = field.slice(dot + 1);
  if (group === "conditions") {
    const held = conditionsOf(actor, key);
    const free = held.filter(isFree);
    if (free.length === 0) return held.length > 0 ? undefined : 0;
    const value = valueAt(free[0].system, "value.value");
    // A condition without a value (prone…) is present or absent only.
    return typeof value === "number" ? value : 1;
  }
  if (group === "items") {
    const item = itemsOf(actor).find((i) => docId(i) === key);
    return !item || !PHYSICAL_TYPES.has(String(item.type)) || isCoin(item)
      ? undefined
      : valueAt(item.system, "quantity");
  }
  if (group === "coins") {
    const { totals, addressable } = purseOf(actor);
    return addressable ? totals[key as Denomination] : undefined;
  }
  if (group === "spellcasting") {
    // spellcasting.entries.<entry>.<rank>.(value|prepared) or
    // spellcasting.innateUses.<spell>; focus falls through to its path.
    const [member, id, rank, leaf] = key.split(".");
    const doc = itemsOf(actor).find((i) => docId(i) === id);
    if (member === "entries") {
      if (doc?.type !== "spellcastingEntry") return undefined;
      const at = `slots.slot${rank}`;
      return leaf === "prepared"
        ? preparedOf(doc.system, at)
        : valueAt(doc.system, `${at}.value`);
    }
    if (member === "innateUses")
      return innateSpell(actor, id) === undefined
        ? undefined
        : valueAt(doc!.system, "location.uses.value");
  }
  const path = COUNTER_PATHS[field];
  return path === undefined ? undefined : valueAt(actor.system, path);
}

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

/** The stored source of an embedded Item's system data, when the runtime
 * exposes it (`_source`), else its prepared data: pf2e's prepare step
 * rewrites a coin's price to one unit of one denomination (source-derived,
 * pf2e 8.5.1 and 8.6.1 `item/treasure/document.ts:31-44`), and the app reads
 * the stored price. Spell slots are read prepared: the app reads them as pf2e
 * normalises them (`item/spellcasting-entry/document.ts:90-110`: null slots
 * last, padded to the max), and so does the base it sends. */
const sourceSystem = (item: ActorItemLike): unknown =>
  valueAt(item, "_source.system") ?? item.system;

/** A coin: `treasure` with `category` "coin", or a legacy `stackGroup`
 * "coins" (source-derived, pf2e 8.5.1 and 8.6.1 `item/treasure/document.ts:11-13`,
 * `item/treasure/data.ts:132`). */
const isCoin = (item: ActorItemLike) => {
  if (item.type !== "treasure") return false;
  const s = sourceSystem(item);
  return (
    valueAt(s, "category") === "coin" || valueAt(s, "stackGroup") === "coins"
  );
};

const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** The purse: per denomination the sum of `price.value.<d>` × `quantity` over
 * the coin items (pf2e's `inventory.currency` for plain coins, source-derived,
 * pf2e 8.5.1 and 8.6.1 `actor/inventory/index.ts:34-38`). It is addressable —
 * pf2e's add / remove by denomination move exactly that total — only when
 * every coin item is worth exactly 1 of one denomination per unit, sits in no
 * container of the Actor, and is a `category` coin (pf2e's `isCurrency`
 * ignores a legacy `stackGroup` one, `item/treasure/document.ts:16-18`). */
function purseOf(actor: ActorLike): {
  totals: Record<Denomination, number>;
  addressable: boolean;
} {
  const totals = { pp: 0, gp: 0, sp: 0, cp: 0 };
  let addressable = true;
  const ids = new Set(itemsOf(actor).map(docId));
  for (const item of itemsOf(actor).filter(isCoin)) {
    const s = sourceSystem(item);
    const raw = valueAt(s, "quantity");
    const quantity = isInt(raw) ? raw : 1;
    const named = DENOMINATIONS.filter((d) => {
      const per = valueAt(s, `price.value.${d}`);
      return isInt(per) && per !== 0;
    });
    for (const d of named)
      totals[d] += (valueAt(s, `price.value.${d}`) as number) * quantity;
    const per = valueAt(s, "price.per");
    if (
      named.length !== 1 ||
      valueAt(s, `price.value.${named[0]}`) !== 1 ||
      (per !== undefined && per !== null && per !== 1) ||
      // pf2e clears a container id naming no item of the Actor.
      ids.has(String(valueAt(s, "containerId"))) ||
      valueAt(s, "category") !== "coin"
    )
      addressable = false;
  }
  return { totals, addressable };
}

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

/** Purse writes, pp → cp: pf2e adds coins to (or creates) the denomination's
 * stack, and removes exactly that denomination or nothing (source-derived,
 * pf2e 8.5.1 and 8.6.1 `actor/inventory/index.ts:94-133` addCurrency,
 * `:135-250` removeCurrency: with `byValue` false it returns false before
 * any write when the denomination falls short, `:142`, `:158`). */
function coinWrites(
  actor: ActorLike,
  coins: Pf2eCoinsV1,
  warnings: string[],
): Write[] {
  const { totals, addressable } = purseOf(actor);
  if (!addressable) {
    warnings.push("coins_unaddressable");
    return [];
  }
  const inventory = actor.inventory!;
  const writes: Write[] = [];
  for (const d of DENOMINATIONS) {
    const target = coins[d];
    if (target === undefined) continue;
    const delta = target - totals[d];
    if (delta > 0)
      writes.push(async () => {
        await inventory.addCurrency!({ [d]: delta });
      });
    else if (delta < 0)
      writes.push(async () => {
        const removed = await inventory.removeCurrency!(
          { [d]: -delta },
          { byValue: false },
        );
        if (removed !== true) warnings.push(`coins_refused:${d}`);
      });
  }
  return writes;
}

/** A rank's stored prepared array, as the request writes it. */
function preparedOf(system: unknown, at: string): Pf2ePreparedSlotV1[] {
  const raw = valueAt(system, `${at}.prepared`);
  const slots = Array.isArray(raw)
    ? (raw as unknown[])
    : typeof raw === "object" && raw !== null
      ? Object.values(raw)
      : [];
  return preparedOrder(
    slots.map((slot) => {
      const id = valueAt(slot, "id");
      return {
        id: typeof id === "string" ? id : null,
        expended: valueAt(slot, "expended") === true,
      };
    }),
  );
}

/** pf2e's order of a prepared rank: the slots holding a spell first, the
 * empty ones after, each group in its stored order (source-derived, pf2e
 * 8.5.1 and 8.6.1 `item/spellcasting-entry/document.ts:91-111`). pf2e applies
 * it on every read, so an empty slot's position carries no meaning: a write
 * and a later read of the same rank compare in this order, and a retry after
 * a failure part-way recognises its own write as written. */
function preparedOrder(rows: Pf2ePreparedSlotV1[]): Pf2ePreparedSlotV1[] {
  return [
    ...rows.filter((r) => r.id !== null),
    ...rows.filter((r) => r.id === null),
  ];
}

/** The request with every prepared rank (target and base) in pf2e's order. */
function inPreparedOrder(req: Pf2eActorResourcesV1): Pf2eActorResourcesV1 {
  const order = (sc: Pf2eSpellcastingV1 | undefined) => {
    if (!sc?.entries) return sc;
    const entries: Record<string, Record<string, Pf2eSlotTargetV1>> = {};
    for (const [entryId, ranks] of Object.entries(sc.entries)) {
      entries[entryId] = {};
      for (const [rank, slot] of Object.entries(ranks))
        entries[entryId][rank] =
          slot.prepared === undefined
            ? slot
            : { ...slot, prepared: preparedOrder(slot.prepared) };
    }
    return { ...sc, entries };
  };
  return {
    ...req,
    ...(req.spellcasting ? { spellcasting: order(req.spellcasting) } : {}),
    ...(req.base?.spellcasting
      ? { base: { ...req.base, spellcasting: order(req.base.spellcasting) } }
      : {}),
  } as Pf2eActorResourcesV1;
}

/** The innate spell `id`, or undefined: a `spell` Item whose entry
 * (`system.location.value`) is an innate spellcasting entry (source-derived,
 * pf2e 8.5.1 and 8.6.1 `item/spell/data.ts:37-46`,
 * `item/spellcasting-entry/document.ts:66-68`). */
function innateSpell(actor: ActorLike, id: string): ActorItemLike | undefined {
  const items = itemsOf(actor);
  const spell = items.find((i) => docId(i) === id && i.type === "spell");
  if (!spell) return undefined;
  const entryId = valueAt(spell.system, "location.value");
  const entry = items.find(
    (i) => docId(i) === entryId && i.type === "spellcastingEntry",
  );
  return entry && valueAt(entry.system, "prepared.value") === "innate"
    ? spell
    : undefined;
}

/** Spell slot and innate-use writes: ONE update per entry carrying every
 * rank's paths (`system.slots.slot<N>.value` / `.prepared`, source-derived,
 * pf2e 8.5.1 and 8.6.1 `item/spellcasting-entry/data.ts:19-28`), and one
 * update per innate spell (`system.location.uses.value`, as pf2e's own
 * `consume` writes it, `item/spellcasting-entry/document.ts:334-341`). */
function spellWrites(
  actor: ActorLike,
  spellcasting: Pf2eSpellcastingV1,
  warnings: string[],
): Write[] {
  const writes: Write[] = [];
  const items = itemsOf(actor);
  const entries = spellcasting.entries ?? {};
  for (const entryId of Object.keys(entries).sort()) {
    const entry = items.find(
      (i) => docId(i) === entryId && i.type === "spellcastingEntry",
    );
    if (!entry) {
      warnings.push(`spell_entry_unavailable:${entryId}`);
      continue;
    }
    const stored = entry.system;
    const patch: Dict = {};
    const ranks = entries[entryId];
    for (const rank of Object.keys(ranks).sort((a, b) => +a - +b)) {
      const { value, prepared } = ranks[rank];
      const at = `slots.slot${rank}`;
      if (value !== undefined) {
        const max = Math.max(Math.floor(finiteAt(stored, `${at}.max`) ?? 0), 0);
        const clamped = Math.min(value, max);
        if (clamped < value)
          warnings.push(`spell_slot_clamped:${entryId}:${rank}`);
        if (valueAt(stored, `${at}.value`) !== clamped)
          patch[`system.${at}.value`] = clamped;
      }
      if (prepared !== undefined) {
        const missing = new Set(
          prepared
            .map((p) => p.id)
            .filter(
              (id): id is string =>
                id !== null &&
                !items.some(
                  (i) =>
                    docId(i) === id &&
                    i.type === "spell" &&
                    valueAt(i.system, "location.value") === entryId,
                ),
            ),
        );
        if (missing.size > 0) {
          for (const id of missing) warnings.push(`spell_unavailable:${id}`);
          continue;
        }
        if (canonicalize(preparedOf(stored, at)) !== canonicalize(prepared))
          patch[`system.${at}.prepared`] = prepared.map((p) => ({ ...p }));
      }
    }
    if (Object.keys(patch).length > 0)
      writes.push(async () => {
        await entry.update!(patch);
      });
  }
  const uses = spellcasting.innateUses ?? {};
  for (const spellId of Object.keys(uses).sort()) {
    const spell = innateSpell(actor, spellId);
    if (!spell) {
      warnings.push(`spell_unavailable:${spellId}`);
      continue;
    }
    const stored = spell.system;
    let value = uses[spellId];
    const max = finiteAt(stored, "location.uses.max");
    if (max !== undefined && value > max) {
      value = Math.max(Math.floor(max), 0);
      warnings.push(`spell_uses_clamped:${spellId}`);
    }
    if (valueAt(stored, "location.uses.value") !== value)
      writes.push(async () => {
        await spell.update!({ "system.location.uses.value": value });
      });
  }
  return writes;
}

/** Notes as HTML paragraphs: a run of blank lines separates two, a single
 * line break stays a `<br>`, every character escaped. */
function notesHtml(notes: string): string {
  return notes
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The Foundry source of an app-born item without a slug (source-derived,
 * pf2e 8.5.1 and 8.6.1 `item/physical/data.ts:19-30` level, quantity, bulk,
 * price; `item/base/data/system.ts:45-50` traits): price in gp / sp / cp,
 * zero members omitted; bulk in pf2e's units (0.1 is light). */
export function customAddSource(add: Pf2eResourcesCustomAddV1): Dict {
  const c = add.priceCopper;
  const price: Dict = {};
  if (Math.floor(c / 100) > 0) price.gp = Math.floor(c / 100);
  if (Math.floor(c / 10) % 10 > 0) price.sp = Math.floor(c / 10) % 10;
  if (c % 10 > 0) price.cp = c % 10;
  return {
    name: add.name,
    type: add.itemType,
    system: {
      quantity: add.quantity,
      level: { value: add.level },
      price: { value: price },
      bulk: { value: add.bulkTenths / 10 },
      traits: { rarity: add.rarity },
      description: {
        value: add.notes === undefined ? "" : notesHtml(add.notes),
      },
    },
    flags: { [MODULE_ID]: { appInstanceId: add.key } },
  };
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
  await lookup.prefetch(
    EQUIPMENT_PACK,
    adds.map((a) => a.slug),
  );
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
  const sent = validatePf2eActorResourcesV1(payload);
  assertLaneAuthority(
    PROCEDURE,
    supportsPf2eResourcesV1Runtime,
    PF2E_RESOURCES_REQUIREMENT,
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
  const digest = await canonicalDigest(sent);
  // Compared and written in pf2e's prepared order; the digests stay the
  // request's own, so a replay is recognised byte for byte.
  const req = inPreparedOrder(sent);
  const actor = linkedActor(req, req.actorType);
  const id = docId(actor);
  if (
    typeof actor.increaseCondition !== "function" ||
    typeof actor.createEmbeddedDocuments !== "function" ||
    typeof actor.deleteEmbeddedDocuments !== "function"
  )
    throw new RpcError(
      "unsupported_runtime",
      "the pf2e Actor condition and item APIs are unavailable",
    );
  if (req.coins !== undefined && !hasPf2eCurrencyApis(actor))
    throw new RpcError(
      "unsupported_runtime",
      "the pf2e inventory currency APIs are unavailable",
    );

  const stored = parseStoredResult(actor, FLAG_KEYS.pf2eResources);
  const previous = stored?.result ?? null;
  if (previous && alreadyApplied(previous, req.sequence, digest, "sequence"))
    return {
      ...previous,
      created: storedCreated(stored!.flag),
      warnings: [...previous.warnings],
    };

  const contentDigest = await canonicalDigest({
    ...sent,
    sequence: 0,
    base: undefined,
  });
  const sameContent = stored?.flag.contentDigest === contentDigest;
  const refusedBefore = new Set(
    sameContent
      ? previous!.warnings
          .filter((w) => w.startsWith("condition_refused:"))
          .map((w) => w.slice("condition_refused:".length))
      : [],
  );

  assertBase(
    req,
    req.base,
    (field) => currentValue(actor, field),
    stored?.flag.written,
  );
  const warnings: string[] = [];
  const created: Record<string, string> = {};
  const patch = counterPatch(actor, req, warnings);
  // The contract's order: conditions, items, purse, spells, then the adds and
  // custom adds in one create, then the one counters update.
  const writes = [
    ...(req.conditions
      ? conditionWrites(actor, req.conditions, refusedBefore, warnings)
      : []),
    ...(req.items ? itemWrites(actor, req.items, warnings) : []),
    ...(req.coins ? coinWrites(actor, req.coins, warnings) : []),
    ...(req.spellcasting ? spellWrites(actor, req.spellcasting, warnings) : []),
  ];
  const adds: Array<{ key: string; label: string; source: Dict }> = (
    req.adds ? await addSources(actor, req.adds, created, warnings) : []
  ).map(({ add, source }) => ({ key: add.key, label: add.slug, source }));
  for (const add of req.customAdds ?? []) {
    const existing = byAppKey(actor, add.key);
    if (existing) created[add.key] = docId(existing);
    else
      adds.push({ key: add.key, label: add.key, source: customAddSource(add) });
  }

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

  // Item, condition, purse and spell writes first, then ONE update carrying
  // the counters and the result flag: a failure part-way leaves the sequence
  // unrecorded, so the retry recomputes and finishes (the purse and slots are
  // absolute targets; adds are found again by their key).
  for (const write of writes) await write();
  if (adds.length > 0) {
    await actor.createEmbeddedDocuments!(
      "Item",
      adds.map((a) => a.source),
    );
    for (const { key, label } of adds) {
      const made = byAppKey(actor, key);
      if (made) created[key] = docId(made);
      else warnings.push(`item_refused:${label}`);
    }
  }
  await actor.update({
    ...patch,
    [`flags.${MODULE_ID}.${FLAG_KEYS.pf2eResources}`]: {
      ...result,
      contentDigest,
      // What Foundry holds once this update lands, for the next base compare:
      // the item and condition writes are done, the counters ride this update.
      written: writtenFields(req, (field) => {
        const path = COUNTER_PATHS[field];
        return path !== undefined && `system.${path}` in patch
          ? patch[`system.${path}`]
          : currentValue(actor, field);
      }),
    },
  });
  return result;
};
