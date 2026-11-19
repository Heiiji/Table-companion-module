import { canonicalize } from "../util/canonicalJson.js";
import { type ActorItemLike, type Dict } from "./upsertShared.js";
import {
  type ItemKind,
  type ItemFieldsV1,
  SLOT_KEYS,
  SLOTS,
  type SlotKey,
  type DiceV1,
  type AttackProfileV1,
  PRINTED_RANGES,
  RARITIES,
} from "./actorItems.validate.js";

// ------------------------------------------------- the app's read of an Item

export const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function at(node: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!isDict(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** An integer as the app reads one: a number (truncated) or an integer string. */
export function intValue(v: unknown): number | undefined {
  if (typeof v === "number")
    return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  return undefined;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(v, hi));

export type ItemDoc = ActorItemLike & { name?: string };

function itemName(item: ItemDoc, kind: ItemKind): string {
  const name =
    typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : "Unnamed Item";
  return kind === "module" ? name.normalize("NFC") : name;
}

/** Knight's `qtyMunition` for one module level: exactly one `chargeur N` raw
 * effect and no ammunition options; current is `effets.chargeur`, else N. */
export function moduleCharges(
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

export const ENERGY_PATHS = [
  "energie.tour.value",
  "energie.minute.value",
  "energie.supplementaire",
];

export const firstEnergyPath = (details: unknown) =>
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

/** The raw effect tokens at `path`, strings only. */
function rawAt(system: unknown, path: string): string[] {
  const raw = at(system, path);
  return Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : [];
}

const tokenSet = (tokens: string[]) => [...new Set(tokens)].sort();

/** An `arme` Item's attacks exactly as the app's weapon snapshot encodes them:
 * one-/two-hand profiles, ammunition profiles, else the flat dice. With
 * `withEffects`, each carries its sorted effect tokens: the hand's own list,
 * or the weapon's list plus the ammunition's. */
export function readWeaponAttacks(
  system: unknown,
  name: string,
  withEffects = false,
): AttackProfileV1[] {
  const portee = at(system, "portee");
  const printed =
    typeof portee === "string" && portee.trim() ? portee.trim() : undefined;
  const range =
    printed && Object.hasOwn(PRINTED_RANGES, printed)
      ? PRINTED_RANGES[printed]
      : printed;
  const attack = (
    id: string,
    n: string,
    node: unknown,
    effects: string[],
  ): AttackProfileV1 => {
    const damage = readDice(at(node, "degats"));
    const violence = readDice(at(node, "violence"));
    return {
      id,
      name: n,
      ...(range ? { range } : {}),
      ...(damage ? { damage } : {}),
      ...(violence ? { violence } : {}),
      ...(withEffects ? { effects: tokenSet(effects) } : {}),
    };
  };
  const base = rawAt(system, "effets.raw");
  const type = at(system, "type");
  const kind = typeof type === "string" ? type : "contact";
  const liste = at(system, "optionsmunitions.liste");
  if (kind === "contact" && at(system, "options2mains.has") === true)
    return [
      attack("1main", "Une main", at(system, "options2mains.1main"), base),
      attack(
        "2main",
        "Deux mains",
        at(system, "options2mains.2main"),
        rawAt(system, "effets2mains.raw"),
      ),
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
        return attack(`munition-${k}`, label, liste[k], [
          ...base,
          ...rawAt(liste[k], "raw"),
        ]);
      });
  }
  return [attack("primary", name, system, base)];
}

export function readFields(item: ItemDoc, kind: ItemKind): ItemFieldsV1 {
  if (kind === "module") return readModule(item);
  const name = itemName(item, "weapon");
  const rarete = at(item.system, "rarete");
  return {
    name,
    profiles: readWeaponAttacks(item.system, name, true),
    rarity:
      typeof rarete === "string" && RARITIES.includes(rarete)
        ? rarete
        : "standard",
    cost: intValue(at(item.system, "prix")) ?? 0,
  };
}

/** Read profiles as compared with `value`: a profile the app sends without
 * `effects` ignores the Item's (an older app compares as before); with
 * `effects`, both sides compare as sorted sets. */
function comparable(
  read: unknown,
  value: unknown,
): { read: unknown; value: unknown } {
  if (!Array.isArray(read) || !Array.isArray(value)) return { read, value };
  return {
    read: read.map((r: Dict, i) => {
      const v: unknown = value[i];
      if (isDict(v) && v.effects !== undefined) return r;
      const rest = { ...r };
      delete rest.effects;
      return rest;
    }),
    value: value.map((v: unknown) =>
      isDict(v) && Array.isArray(v.effects)
        ? { ...v, effects: tokenSet(v.effects as string[]) }
        : v,
    ),
  };
}

/** Whether a read field equals the app's value (`profiles` per
 * `comparable`). */
export function sameField(key: string, read: unknown, value: unknown) {
  if (key !== "profiles") return sameValue(read, value);
  const c = comparable(read, value);
  return sameValue(c.read, c.value);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return (
    a !== undefined && b !== undefined && canonicalize(a) === canonicalize(b)
  );
}

/** Names compare after NFC on both sides; with `blankMatches`, an Item whose
 * name is blank matches any name. */
export function sameName(
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
export function holds(
  item: ItemDoc,
  current: Dict,
  key: string,
  value: unknown,
) {
  if (key === "name") return sameName(item, value, false);
  if (key === "profiles" && Array.isArray(value) && value.length === 1) {
    const read = current.profiles as AttackProfileV1[];
    return (
      read.length === 1 &&
      sameField(
        key,
        [{ ...read[0], id: "primary", name: "" }],
        [{ ...(value[0] as AttackProfileV1), id: "primary", name: "" }],
      )
    );
  }
  return sameField(key, current[key], value);
}

// ------------------------------------------------------------ the armour

const anyTrue = (node: unknown): boolean =>
  node === true || (isDict(node) && Object.values(node).some(anyTrue));

const anyApplied = (node: unknown): boolean =>
  isDict(node) &&
  Object.entries(node).some(
    ([key, value]) =>
      (key === "applied" && value === true) || anyApplied(value),
  );

/** Whether deleting this `armure` Item loses data held nowhere else: an
 * applied evolution (regular or special), a pre-evolution archive, or a
 * capacity left active. */
export function armourGuarded(item: ItemDoc): boolean {
  const sy = item.system;
  const liste = at(sy, "evolutions.liste");
  const archivage = at(sy, "archivage");
  const selected = at(sy, "capacites.selected");
  const warriorTypes = at(sy, "capacites.selected.type.type");
  return (
    (isDict(liste) &&
      Object.values(liste).some((e) => at(e, "applied") === true)) ||
    anyApplied(at(sy, "evolutions.special")) ||
    (isDict(archivage) &&
      Object.values(archivage).some((v) =>
        typeof v === "string"
          ? v !== ""
          : typeof v === "object" && v !== null && Object.keys(v).length > 0,
      )) ||
    (isDict(selected) &&
      Object.values(selected).some((c) => anyTrue(at(c, "active")))) ||
    // The Warrior's « type » is active on the chosen type itself.
    (isDict(warriorTypes) &&
      Object.values(warriorTypes).some(
        (t) => at(t, "conflit") === true || at(t, "horsconflit") === true,
      ))
  );
}
