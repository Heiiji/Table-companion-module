import { MODULE_ID } from "../constants.js";
import { deletionEntry, gameItems, gamePacks } from "../foundry/runtime.js";
import { KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1 } from "../refdata/knightCompendiumCrosswalkV14_0_1.js";
import { RpcError } from "../rpc/errors.js";
import { MAX_ROLL_DICE } from "./rollExecute.js";
import type { Procedure } from "../rpc/registry.js";
import { canonicalize } from "../util/canonicalJson.js";
import { paragraphsHtml } from "../util/html.js";
import { actorDocumentId, linkedKnightActor } from "./actorResources.js";
import { pairedAgentUser } from "../setup/identity.js";
import { compendiumAvailabilityWarning } from "./actorUpsert.equipment.js";
import { catalogId as catalogIdShape } from "./actorUpsert.types.js";
import { readable } from "./compendium.js";
import {
  SCHEMA_VERSION,
  assertKnightUpsertAuthority,
  bindingId,
  canonicalDigest,
  contentsOf,
  docId,
  FLAG_KEYS,
  flagValue,
  identifier,
  integer,
  invalid,
  record,
  text,
  type ActorItemLike,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";

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

const ACTOR_TYPE = "knight";
const PROCEDURE = "actor.items.v1";
const MAX_NAME = 200;
const MAX_DESCRIPTION_BYTES = 8192;
const MAX_PROFILES = 8;
/** The weapon snapshot envelope's own ceiling bounds every profile string. */
const MAX_PROFILE_TEXT = 4096;
const entryIdShape =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ItemKind = "module" | "weapon";
const FOUNDRY_TYPE: Record<ItemKind, string> = {
  module: "module",
  weapon: "arme",
};

/** The app's slot keys → the Knight `module` schema's. */
const SLOTS = {
  tete: "tete",
  torse: "torse",
  bras_gauche: "brasGauche",
  bras_droit: "brasDroit",
  jambe_gauche: "jambeGauche",
  jambe_droite: "jambeDroite",
} as const;
type SlotKey = keyof typeof SLOTS;
const SLOT_KEYS = Object.keys(SLOTS) as SlotKey[];

const PRINTED_RANGES: Record<string, string> = {
  personnelle: "Personnelle",
  contact: "Contact",
  courte: "Courte",
  moyenne: "Moyenne",
  longue: "Longue",
  lointaine: "Lointaine",
};

export interface DiceV1 {
  count: number;
  faces: number;
  flat: number;
  expr?: string;
}

/** One attack of the app's weapon snapshot. */
export interface AttackProfileV1 {
  id: string;
  name: string;
  range?: string;
  damage?: DiceV1;
  violence?: DiceV1;
}

export interface ItemFieldsV1 {
  name?: string;
  level?: number;
  energy?: number;
  slots?: Record<SlotKey, number>;
  active?: boolean;
  chargesCurrent?: number;
  chargesMax?: number;
  profiles?: AttackProfileV1[];
  description?: string;
}

export type ItemSourceV1 =
  | { live: { pack: string; docId: string } }
  | { catalogId: string }
  | { custom: true };

export type ActorItemsOpV1 =
  | {
      add: {
        entryId: string;
        kind: ItemKind;
        source: ItemSourceV1;
        item: ItemFieldsV1;
      };
    }
  | {
      update: {
        itemId: string;
        kind: ItemKind;
        item: ItemFieldsV1;
        expected: ItemFieldsV1;
        entryId?: string;
      };
    }
  | { remove: { itemId: string; kind: ItemKind; expectedName: string } };

export interface KnightActorItemsV1 {
  schemaVersion: 1;
  actorType: "knight";
  worldId: string;
  tableId: string;
  characterId: string;
  expectedActorId: string;
  op: ActorItemsOpV1;
}

export interface ActorItemsResultV1 {
  schemaVersion: 1;
  resultDocId: string;
  outcome: "updated";
  appliedDigest: string;
  warnings: string[];
  itemId: string;
}

// ---------------------------------------------------------------- validation

const MODULE_KEYS = [
  "name",
  "level",
  "energy",
  "slots",
  "active",
  "chargesCurrent",
  "chargesMax",
];

function itemKind(value: unknown, path: string): ItemKind {
  if (value !== "module" && value !== "weapon")
    invalid(`${path} must be module or weapon`);
  return value;
}

/** The dice an attack may carry: Knight rolls `count` d6 for damage and
 * violence, so a count is bounded like `roll.execute`'s dice budget (zero is
 * a flat-only attack) and faces like a real die. */
const MAX_DICE_FACES = 1000;

function dice(value: unknown, path: string): DiceV1 {
  const d = record(value, path, ["count", "faces", "flat", "expr"]);
  return {
    count: integer(d.count, `${path}.count`, 0, MAX_ROLL_DICE),
    faces: integer(d.faces, `${path}.faces`, 1, MAX_DICE_FACES),
    flat: integer(
      d.flat,
      `${path}.flat`,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(d.expr === undefined
      ? {}
      : { expr: text(d.expr, `${path}.expr`, MAX_PROFILE_TEXT, true) }),
  };
}

function profiles(value: unknown, path: string): AttackProfileV1[] {
  if (!Array.isArray(value) || value.length > MAX_PROFILES)
    invalid(`${path} must be an array of at most ${MAX_PROFILES} attacks`);
  const out = value.map((raw, i): AttackProfileV1 => {
    const at = `${path}[${i}]`;
    const a = record(raw, at, ["id", "name", "range", "damage", "violence"]);
    return {
      id: text(a.id, `${at}.id`, MAX_PROFILE_TEXT, true),
      name: text(a.name, `${at}.name`, MAX_PROFILE_TEXT),
      ...(a.range === undefined
        ? {}
        : { range: text(a.range, `${at}.range`, MAX_PROFILE_TEXT, true) }),
      ...(a.damage === undefined
        ? {}
        : { damage: dice(a.damage, `${at}.damage`) }),
      ...(a.violence === undefined
        ? {}
        : { violence: dice(a.violence, `${at}.violence`) }),
    };
  });
  if (new Set(out.map((a) => a.id)).size !== out.length)
    invalid(`${path} ids must be unique`);
  return out;
}

function itemFields(
  value: unknown,
  path: string,
  kind: ItemKind,
  options: { requireName: boolean; description: boolean },
): ItemFieldsV1 {
  const allowed =
    kind === "weapon"
      ? ["name", "profiles"]
      : options.description
        ? [...MODULE_KEYS, "description"]
        : MODULE_KEYS;
  const p = record(value, path, allowed);
  const out: ItemFieldsV1 = {};
  if (p.name !== undefined)
    out.name = text(p.name, `${path}.name`, MAX_NAME, true);
  else if (options.requireName) invalid(`${path}.name is required`);
  if (p.level !== undefined)
    out.level = integer(p.level, `${path}.level`, 1, 5);
  if (p.energy !== undefined)
    out.energy = integer(p.energy, `${path}.energy`, 0, 20);
  if (p.slots !== undefined) {
    const s = record(p.slots, `${path}.slots`, SLOT_KEYS);
    out.slots = Object.fromEntries(
      SLOT_KEYS.map((k) => [k, integer(s[k], `${path}.slots.${k}`, 0, 9)]),
    ) as Record<SlotKey, number>;
  }
  if (p.active !== undefined) {
    if (typeof p.active !== "boolean") invalid(`${path}.active must be a bool`);
    out.active = p.active;
  }
  if ((p.chargesCurrent === undefined) !== (p.chargesMax === undefined))
    invalid(`${path}.chargesCurrent and chargesMax go together`);
  if (p.chargesCurrent !== undefined) {
    out.chargesCurrent = integer(
      p.chargesCurrent,
      `${path}.chargesCurrent`,
      0,
      99,
    );
    out.chargesMax = integer(p.chargesMax, `${path}.chargesMax`, 0, 99);
    if (out.chargesCurrent > out.chargesMax)
      invalid(`${path}.chargesCurrent must not exceed chargesMax`);
  }
  if (p.profiles !== undefined)
    out.profiles = profiles(p.profiles, `${path}.profiles`);
  if (p.description !== undefined) {
    if (
      typeof p.description !== "string" ||
      new TextEncoder().encode(p.description).length > MAX_DESCRIPTION_BYTES
    )
      invalid(
        `${path}.description must be text of at most ${MAX_DESCRIPTION_BYTES} bytes`,
      );
    out.description = p.description;
  }
  return out;
}

function itemSource(value: unknown, path: string): ItemSourceV1 {
  const s = record(value, path, ["live", "catalogId", "custom"]);
  if (Object.keys(s).length !== 1)
    invalid(`${path} must carry exactly one of live, catalogId, custom`);
  if (s.live !== undefined) {
    const l = record(s.live, `${path}.live`, ["pack", "docId"]);
    if (l.pack !== "") identifier(l.pack, `${path}.live.pack`, bindingId);
    return {
      live: {
        pack: l.pack as string,
        docId: identifier(l.docId, `${path}.live.docId`, actorDocumentId),
      },
    };
  }
  if (s.catalogId !== undefined)
    return {
      catalogId: identifier(s.catalogId, `${path}.catalogId`, catalogIdShape),
    };
  if (s.custom !== true) invalid(`${path}.custom must be true`);
  return { custom: true };
}

function itemsOp(value: unknown): ActorItemsOpV1 {
  const o = record(value, "op", ["add", "update", "remove"]);
  if (Object.keys(o).length !== 1)
    invalid("op must carry exactly one of add, update, remove");
  if (o.add !== undefined) {
    const a = record(o.add, "op.add", ["entryId", "kind", "source", "item"]);
    const kind = itemKind(a.kind, "op.add.kind");
    const source = itemSource(a.source, "op.add.source");
    return {
      add: {
        entryId: identifier(a.entryId, "op.add.entryId", entryIdShape),
        kind,
        source,
        // A copied document keeps its own description.
        item: itemFields(a.item, "op.add.item", kind, {
          requireName: true,
          description: !("live" in source),
        }),
      },
    };
  }
  if (o.update !== undefined) {
    const u = record(o.update, "op.update", [
      "itemId",
      "kind",
      "item",
      "expected",
      "entryId",
    ]);
    const kind = itemKind(u.kind, "op.update.kind");
    const options = { requireName: false, description: false };
    const item = itemFields(u.item, "op.update.item", kind, options);
    const expected = itemFields(
      u.expected,
      "op.update.expected",
      kind,
      options,
    );
    const keys = Object.keys(item).sort().join();
    if (keys !== Object.keys(expected).sort().join())
      invalid("op.update.item and op.update.expected must carry the same keys");
    if (keys === "" && u.entryId === undefined)
      invalid("op.update needs a field or an entryId");
    return {
      update: {
        itemId: identifier(u.itemId, "op.update.itemId", actorDocumentId),
        kind,
        item,
        expected,
        ...(u.entryId === undefined
          ? {}
          : {
              entryId: identifier(u.entryId, "op.update.entryId", entryIdShape),
            }),
      },
    };
  }
  const r = record(o.remove, "op.remove", ["itemId", "kind", "expectedName"]);
  return {
    remove: {
      itemId: identifier(r.itemId, "op.remove.itemId", actorDocumentId),
      kind: itemKind(r.kind, "op.remove.kind"),
      expectedName: text(
        r.expectedName,
        "op.remove.expectedName",
        MAX_NAME,
        true,
      ),
    },
  };
}

export function validateKnightActorItemsV1(
  payload: unknown,
): KnightActorItemsV1 {
  const p = record(payload, "actorItems", [
    "schemaVersion",
    "actorType",
    "worldId",
    "tableId",
    "characterId",
    "expectedActorId",
    "op",
  ]);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.actorType !== ACTOR_TYPE) invalid("actorType must be knight");
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
    op: itemsOp(p.op),
  };
}

// ------------------------------------------------- the app's read of an Item

const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function at(node: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!isDict(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** An integer as the app reads one: a number (truncated) or an integer string. */
function intValue(v: unknown): number | undefined {
  if (typeof v === "number")
    return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  return undefined;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(v, hi));

type ItemDoc = ActorItemLike & { name?: string };

function itemName(item: ItemDoc, kind: ItemKind): string {
  const name =
    typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : "Unnamed Item";
  return kind === "module" ? name.normalize("NFC") : name;
}

/** Knight's `qtyMunition` for one module level: exactly one `chargeur N` raw
 * effect and no ammunition options; current is `effets.chargeur`, else N. */
function moduleCharges(
  details: unknown,
): { current: number; max: number } | undefined {
  const arme = at(details, "arme");
  const raw = at(arme, "effets.raw");
  if (!Array.isArray(raw) || at(arme, "optionsmunitions.has") === true)
    return undefined;
  const found = raw.filter(
    (r): r is string => typeof r === "string" && r.includes("chargeur"),
  );
  if (found.length !== 1) return undefined;
  const n = intValue(found[0].split(" ")[1]);
  if (n === undefined || n < 0) return undefined;
  const max = Math.min(n, 99);
  const current = intValue(at(arme, "effets.chargeur"));
  return { current: current === undefined ? max : clamp(current, 0, max), max };
}

const ENERGY_PATHS = [
  "energie.tour.value",
  "energie.minute.value",
  "energie.supplementaire",
];

const firstEnergyPath = (details: unknown) =>
  ENERGY_PATHS.find((p) => (intValue(at(details, p)) ?? 0) !== 0);

/** A `module` Item's fields as the app reads them back. */
function readModule(item: ItemDoc): ItemFieldsV1 {
  const sy = item.system;
  const rawLevel = intValue(at(sy, "niveau.value"));
  const details = at(sy, `niveau.details.n${rawLevel ?? 1}`);
  const energyPath = firstEnergyPath(details);
  const charges = moduleCharges(details);
  return {
    name: itemName(item, "module"),
    level: rawLevel === undefined ? 1 : clamp(rawLevel, 1, 5),
    energy: energyPath ? clamp(intValue(at(details, energyPath))!, 0, 20) : 0,
    slots: Object.fromEntries(
      SLOT_KEYS.map((k) => [k, intValue(at(sy, `slots.${SLOTS[k]}`)) ?? 0]),
    ) as Record<SlotKey, number>,
    active: at(sy, "active.base") === true,
    chargesCurrent: charges?.current,
    chargesMax: charges?.max,
  };
}

function readDice(node: unknown): DiceV1 | undefined {
  if (!isDict(node)) return undefined;
  const count = intValue(node.dice) ?? 0;
  const flat = intValue(node.fixe) ?? 0;
  return count <= 0 && flat <= 0 ? undefined : { count, faces: 6, flat };
}

/** An `arme` Item's attacks exactly as the app's weapon snapshot encodes them:
 * one-/two-hand profiles, ammunition profiles, else the flat dice. */
export function readWeaponAttacks(
  system: unknown,
  name: string,
): AttackProfileV1[] {
  const portee = at(system, "portee");
  const printed =
    typeof portee === "string" && portee.trim() ? portee.trim() : undefined;
  const range =
    printed && Object.hasOwn(PRINTED_RANGES, printed)
      ? PRINTED_RANGES[printed]
      : printed;
  const attack = (id: string, n: string, node: unknown): AttackProfileV1 => {
    const damage = readDice(at(node, "degats"));
    const violence = readDice(at(node, "violence"));
    return {
      id,
      name: n,
      ...(range ? { range } : {}),
      ...(damage ? { damage } : {}),
      ...(violence ? { violence } : {}),
    };
  };
  const type = at(system, "type");
  const kind = typeof type === "string" ? type : "contact";
  const liste = at(system, "optionsmunitions.liste");
  if (kind === "contact" && at(system, "options2mains.has") === true)
    return [
      attack("1main", "Une main", at(system, "options2mains.1main")),
      attack("2main", "Deux mains", at(system, "options2mains.2main")),
    ];
  if (
    kind === "distance" &&
    at(system, "optionsmunitions.has") === true &&
    isDict(liste) &&
    Object.keys(liste).length > 0
  ) {
    const rank = (k: string) => (/^-*\d+$/.test(k) ? Number(k) : Infinity);
    return Object.keys(liste)
      .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => {
        const nom = at(liste[k], "nom");
        const label =
          typeof nom === "string" && nom.trim() ? nom.trim() : `Munition ${k}`;
        return attack(`munition-${k}`, label, liste[k]);
      });
  }
  return [attack("primary", name, system)];
}

function readFields(item: ItemDoc, kind: ItemKind): ItemFieldsV1 {
  if (kind === "module") return readModule(item);
  const name = itemName(item, "weapon");
  return { name, profiles: readWeaponAttacks(item.system, name) };
}

function sameValue(a: unknown, b: unknown): boolean {
  return (
    a !== undefined && b !== undefined && canonicalize(a) === canonicalize(b)
  );
}

/** Names compare after NFC on both sides; with `blankMatches`, an Item whose
 * name is blank matches any name. */
function sameName(
  item: ItemDoc,
  name: unknown,
  blankMatches: boolean,
): boolean {
  if (blankMatches && !(typeof item.name === "string" && item.name.trim()))
    return true;
  return (
    typeof name === "string" &&
    itemName(item, "weapon").normalize("NFC") === name.normalize("NFC")
  );
}

/** Whether the Item already holds `value` for `key`. A lone attack lands as
 * the flat `primary` profile, named after the Item: its id and name are not
 * compared. */
function holds(item: ItemDoc, current: Dict, key: string, value: unknown) {
  if (key === "name") return sameName(item, value, false);
  if (key === "profiles" && Array.isArray(value) && value.length === 1) {
    const read = current.profiles as AttackProfileV1[];
    return (
      read.length === 1 &&
      sameValue(
        { ...read[0], id: "primary", name: "" },
        { ...(value[0] as AttackProfileV1), id: "primary", name: "" },
      )
    );
  }
  return sameValue(current[key], value);
}

// ------------------------------------------------------------ Item writes

/** The dotted Item update a module's fields make. `built` adds the
 * description (a copied document keeps its own). */
function modulePatch(
  item: ItemDoc,
  f: ItemFieldsV1,
  built: boolean,
  warnings: string[],
): Dict {
  const sy = item.system;
  const patch: Dict = {};
  if (f.name !== undefined) patch.name = f.name;
  const details = isDict(at(sy, "niveau.details"))
    ? (at(sy, "niveau.details") as Dict)
    : {};
  const level = f.level ?? intValue(at(sy, "niveau.value")) ?? 1;
  const filled: Record<number, Dict> = {};
  if (f.level !== undefined) {
    patch["system.niveau.value"] = f.level;
    if ((intValue(at(sy, "niveau.max")) ?? 1) < f.level)
      patch["system.niveau.max"] = f.level;
    // As the system's own sheet does when the maximum rises: a missing level
    // starts as a copy of level 1.
    for (let i = 1; i <= f.level; i++)
      if (!isDict(details[`n${i}`]) && isDict(details.n1))
        patch[`system.niveau.details.n${i}`] = filled[i] = structuredClone(
          details.n1,
        );
  }
  const levelDetails = filled[level] ?? details[`n${level}`];
  const setLevel = (sub: string, value: unknown) => {
    const fill = filled[level];
    if (!fill) patch[`system.niveau.details.n${level}.${sub}`] = value;
    else {
      const parts = sub.split(".");
      let cursor = fill;
      for (const part of parts.slice(0, -1)) {
        if (!isDict(cursor[part])) cursor[part] = {};
        cursor = cursor[part] as Dict;
      }
      cursor[parts.at(-1)!] = value;
    }
  };
  if (f.energy !== undefined)
    setLevel(firstEnergyPath(levelDetails) ?? ENERGY_PATHS[0], f.energy);
  if (f.slots)
    for (const k of SLOT_KEYS) patch[`system.slots.${SLOTS[k]}`] = f.slots[k];
  if (f.active !== undefined) patch["system.active.base"] = f.active;
  if (built && f.description !== undefined)
    patch["system.description"] = paragraphsHtml(f.description);
  if (f.chargesCurrent !== undefined) {
    // The maximum is the effect's own N: never written.
    if (moduleCharges(levelDetails))
      setLevel("arme.effets.chargeur", f.chargesCurrent);
    else warnings.push("charges_unmapped");
  }
  return patch;
}

const MUNITION_ID = /^munition-([A-Za-z0-9_-]+)$/;

/** The dotted `arme` update whose read-back is `profiles`. */
function weaponPatch(item: ItemDoc, f: ItemFieldsV1): Dict {
  const patch: Dict = {};
  if (f.name !== undefined) patch.name = f.name;
  const attacks = f.profiles;
  if (!attacks) return patch;
  const first = attacks[0];
  const range = first?.range;
  patch["system.portee"] =
    range === undefined
      ? ""
      : (Object.keys(PRINTED_RANGES).find((k) => PRINTED_RANGES[k] === range) ??
        range);
  const setDice = (base: string, d: DiceV1 | undefined) => {
    patch[`${base}.dice`] = d?.count ?? 0;
    patch[`${base}.fixe`] = d?.flat ?? 0;
  };
  const ids = attacks.map((a) => a.id);
  const munitions = ids.map((id) => MUNITION_ID.exec(id)?.[1]);
  if (ids.length === 2 && ids[0] === "1main" && ids[1] === "2main") {
    patch["system.type"] = "contact";
    patch["system.options2mains.has"] = true;
    patch["system.optionsmunitions.has"] = false;
    for (const [i, hand] of ["1main", "2main"].entries()) {
      setDice(`system.options2mains.${hand}.degats`, attacks[i].damage);
      setDice(`system.options2mains.${hand}.violence`, attacks[i].violence);
    }
  } else if (munitions.length > 0 && munitions.every((k) => k !== undefined)) {
    const keys = munitions as string[];
    patch["system.type"] = "distance";
    patch["system.options2mains.has"] = false;
    patch["system.optionsmunitions.has"] = true;
    patch["system.optionsmunitions.value"] = keys.length;
    const liste = at(item.system, "optionsmunitions.liste");
    const current = isDict(liste) ? liste : {};
    for (const k of Object.keys(current))
      if (!keys.includes(k)) {
        const [key, value] = deletionEntry(k);
        patch[`system.optionsmunitions.liste.${key}`] = value;
      }
    keys.forEach((k, i) => {
      const a = attacks[i];
      const base = `system.optionsmunitions.liste.${k}`;
      if (isDict(current[k])) {
        // An existing ammunition keeps its effects.
        patch[`${base}.nom`] = a.name;
        setDice(`${base}.degats`, a.damage);
        setDice(`${base}.violence`, a.violence);
      } else {
        patch[base] = {
          nom: a.name,
          degats: { dice: a.damage?.count ?? 0, fixe: a.damage?.flat ?? 0 },
          violence: {
            dice: a.violence?.count ?? 0,
            fixe: a.violence?.flat ?? 0,
          },
          raw: [],
          custom: [],
          liste: [],
        };
      }
    });
    if (!keys.includes(String(at(item.system, "optionsmunitions.actuel"))))
      patch["system.optionsmunitions.actuel"] = keys[0];
  } else {
    // ponytail: Foundry's flat weapon holds one attack; any further profile
    // has no field to land in and reads back absent.
    patch["system.options2mains.has"] = false;
    patch["system.optionsmunitions.has"] = false;
    if (range !== undefined)
      patch["system.type"] = range === "Contact" ? "contact" : "distance";
    setDice("system.degats", first?.damage);
    setDice("system.violence", first?.violence);
  }
  return patch;
}

function fieldPatch(
  item: ItemDoc,
  kind: ItemKind,
  f: ItemFieldsV1,
  built: boolean,
  warnings: string[],
): Dict {
  return kind === "module"
    ? modulePatch(item, f, built, warnings)
    : weaponPatch(item, f);
}

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
  const actor = linkedKnightActor(req);
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
