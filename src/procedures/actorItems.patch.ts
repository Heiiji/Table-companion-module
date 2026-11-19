import { deletionEntry } from "../foundry/runtime.js";
import { paragraphsHtml } from "../util/html.js";
import { type Dict } from "./upsertShared.js";
import {
  type ItemDoc,
  isDict,
  at,
  intValue,
  firstEnergyPath,
  ENERGY_PATHS,
  moduleCharges,
} from "./actorItems.read.js";
import {
  type ItemFieldsV1,
  SLOT_KEYS,
  SLOTS,
  PRINTED_RANGES,
  type DiceV1,
  type ItemKind,
} from "./actorItems.validate.js";

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

function warn(warnings: string[], stem: string): void {
  if (!warnings.includes(stem)) warnings.push(stem);
}

/** The effect keys of the running Knight system: a raw token whose key is not
 * one would make its `listEffects` throw while preparing the Actor. */
function effectKeys(): Set<string> {
  const knight = (
    globalThis as { CONFIG?: { KNIGHT?: Record<string, unknown> } }
  ).CONFIG?.KNIGHT;
  const keys = new Set<string>();
  for (const table of ["effets", "effetsfm4", "effetspecial", "effetsadl"]) {
    const t = knight?.[table];
    if (isDict(t)) for (const k of Object.keys(t)) keys.add(k);
  }
  return keys;
}

/** The tokens the system knows, in order; the others are dropped with a
 * warning. */
function knownTokens(tokens: string[], warnings: string[]): string[] {
  const keys = effectKeys();
  const known = tokens.filter((t) => keys.has(t.split(" ")[0]));
  if (known.length !== tokens.length) warn(warnings, "effects_unmapped");
  return known;
}

/** The dotted `arme` update whose read-back is `profiles`, plus the weapon's
 * effects, rarity, cost and (`built`) description. */
function weaponPatch(
  item: ItemDoc,
  f: ItemFieldsV1,
  built: boolean,
  warnings: string[],
): Dict {
  const patch: Dict = {};
  if (f.name !== undefined) patch.name = f.name;
  if (f.rarity !== undefined) patch["system.rarete"] = f.rarity;
  if (f.cost !== undefined) patch["system.prix"] = f.cost;
  if (built && f.description !== undefined)
    patch["system.description"] = paragraphsHtml(f.description);
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
  const setRaw = (path: string, tokens: string[] | undefined) => {
    if (tokens !== undefined) patch[path] = knownTokens(tokens, warnings);
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
    setRaw("system.effets.raw", attacks[0].effects);
    setRaw("system.effets2mains.raw", attacks[1].effects);
  } else if (munitions.length > 0 && munitions.every((k) => k !== undefined)) {
    const keys = munitions as string[];
    patch["system.type"] = "distance";
    patch["system.options2mains.has"] = false;
    patch["system.optionsmunitions.has"] = true;
    patch["system.optionsmunitions.value"] = keys.length;
    // The system rolls the weapon's effects plus the ammunition's: what every
    // ammunition has is the weapon's, the rest its own.
    const lists = attacks.every((a) => a.effects !== undefined)
      ? attacks.map((a) => knownTokens(a.effects!, warnings))
      : undefined;
    const shared = lists?.[0].filter((t) => lists.every((l) => l.includes(t)));
    if (shared) patch["system.effets.raw"] = shared;
    const own = (i: number) => lists?.[i].filter((t) => !shared!.includes(t));
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
        // An existing ammunition keeps its effects unless the app sends them.
        patch[`${base}.nom`] = a.name;
        setDice(`${base}.degats`, a.damage);
        setDice(`${base}.violence`, a.violence);
        if (lists) patch[`${base}.raw`] = own(i);
      } else {
        patch[base] = {
          nom: a.name,
          degats: { dice: a.damage?.count ?? 0, fixe: a.damage?.flat ?? 0 },
          violence: {
            dice: a.violence?.count ?? 0,
            fixe: a.violence?.flat ?? 0,
          },
          raw: own(i) ?? [],
          custom: [],
          liste: [],
        };
      }
    });
    if (!keys.includes(String(at(item.system, "optionsmunitions.actuel"))))
      patch["system.optionsmunitions.actuel"] = keys[0];
  } else {
    // Foundry's flat weapon holds one attack and one range: a further profile
    // has no field to land in and reads back absent.
    if (attacks.length > 1) warn(warnings, "profiles_dropped");
    patch["system.options2mains.has"] = false;
    patch["system.optionsmunitions.has"] = false;
    if (range !== undefined)
      patch["system.type"] = range === "Contact" ? "contact" : "distance";
    setDice("system.degats", first?.damage);
    setDice("system.violence", first?.violence);
    setRaw("system.effets.raw", first?.effects);
  }
  return patch;
}

/** The fill a copied (or re-sent) weapon takes from the app: Foundry's own
 * values win; only what the Item does not carry — an all-zero dice pair, an
 * empty effect list or description of a flat or two-hand weapon — takes the
 * app's. Ammunition entries are the document's whole. Shape, range, rarity,
 * cost and image are never written. */
export function weaponFill(
  item: ItemDoc,
  f: ItemFieldsV1,
  warnings: string[],
): Dict {
  const sy = item.system;
  const patch: Dict = {};
  if (f.name !== undefined) patch.name = f.name;
  const attacks = f.profiles ?? [];
  const fillDice = (base: string, d: DiceV1 | undefined) => {
    const held =
      intValue(at(sy, `${base}.dice`)) || intValue(at(sy, `${base}.fixe`));
    if (d && (d.count || d.flat) && !held) {
      patch[`system.${base}.dice`] = d.count;
      patch[`system.${base}.fixe`] = d.flat;
    }
  };
  const fillRaw = (path: string, tokens: string[] | undefined) => {
    const raw = at(sy, path);
    if (tokens?.length && !(Array.isArray(raw) && raw.length > 0)) {
      const known = knownTokens(tokens, warnings);
      if (known.length > 0) patch[`system.${path}`] = known;
    }
  };
  const type = at(sy, "type");
  const liste = at(sy, "optionsmunitions.liste");
  let modes = 1;
  if (type === "contact" && at(sy, "options2mains.has") === true) {
    modes = 2;
    for (const [hand, raw] of [
      ["1main", "effets.raw"],
      ["2main", "effets2mains.raw"],
    ]) {
      const a = attacks.find((p) => p.id === hand);
      fillDice(`options2mains.${hand}.degats`, a?.damage);
      fillDice(`options2mains.${hand}.violence`, a?.violence);
      fillRaw(raw, a?.effects);
    }
  } else if (
    type === "distance" &&
    at(sy, "optionsmunitions.has") === true &&
    isDict(liste) &&
    Object.keys(liste).length > 0
  )
    modes = Object.keys(liste).length;
  else {
    fillDice("degats", attacks[0]?.damage);
    fillDice("violence", attacks[0]?.violence);
    fillRaw("effets.raw", attacks[0]?.effects);
  }
  if (attacks.length > modes) warn(warnings, "profiles_dropped");
  const description = at(sy, "description");
  if (
    f.description !== undefined &&
    !(
      typeof description === "string" &&
      description.replace(/<[^>]*>/g, "").trim()
    )
  )
    patch["system.description"] = paragraphsHtml(f.description);
  return patch;
}

export function fieldPatch(
  item: ItemDoc,
  kind: ItemKind,
  f: ItemFieldsV1,
  built: boolean,
  warnings: string[],
): Dict {
  return kind === "module"
    ? modulePatch(item, f, built, warnings)
    : weaponPatch(item, f, built, warnings);
}
