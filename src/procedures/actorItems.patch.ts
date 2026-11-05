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

export function fieldPatch(
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
