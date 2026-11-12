import { deletionEntry } from "../foundry/runtime.js";
import { CHARACTERISTIC_KEYS } from "./actorUpsert.types.js";
import {
  ASPECT_KEYS,
  invalid,
  record,
  valueAt,
  type Dict,
} from "./upsertShared.js";

/**
 * The optional `sheet` group of `actor.resources.v1` on a Knight player
 * character: aspects and characteristics, unspent experience, Glory total and
 * three texts. The app sends Foundry's PREPARED aspect and characteristic
 * values; the lane writes the stored `.base` that makes Knight prepare the
 * requested value (the exact inverse of Knight's formula, its sums read on the
 * prepared Actor, so wounds, experience purchases, capacities and advantages
 * count as Foundry counts them). Unspent experience is written by difference
 * on the experience total; Glory total and the texts are written as is.
 *
 * Unspent Glory is what Knight prepares as `total − spent`, the spent part
 * summing the Items' prices and the « other expense » lines of
 * `progression.gloire.depense.autre`. The lane owns ONE such line, whose id
 * the result flag records (`gloryLineId`): a change of unspent Glory moves that
 * line's cost, never the total. A line the Gamemaster deleted is created again
 * at the next difference; one renamed is still found by its id.
 */

type AspectKey = (typeof ASPECT_KEYS)[number];

/** The aspect each characteristic lives under (names are unique). */
const ASPECT_OF: Record<string, AspectKey> = Object.fromEntries(
  ASPECT_KEYS.flatMap((a) => CHARACTERISTIC_KEYS[a].map((c) => [c, a])),
);
const CHARACTERISTICS = Object.keys(ASPECT_OF);

/** Each text field's stored path and longest length in code points. */
const TEXTS = {
  age: ["age", 100],
  nickname: ["surnom", 200],
  majorMotivation: ["motivations.majeure", 2000],
} as const;
type TextKey = keyof typeof TEXTS;

const MAX_STAT = 20;
const MAX_PROGRESSION = 99_999;
/** Knight's own sheet dialog bounds a stored base to 0-9. */
const MAX_BASE = 9;

export interface KnightSheetV1 {
  aspects?: Partial<Record<AspectKey, number>>;
  characteristics?: Record<string, number>;
  experienceCurrent?: number;
  gloryTotal?: number;
  gloryCurrent?: number;
  age?: string;
  nickname?: string;
  majorMotivation?: string;
}

function bounded(value: unknown, path: string, max: number, min = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    invalid(`${path} outside ${min}-${max}`);
  return value as number;
}

function stats(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, number> {
  const r = record(value, path, keys);
  const out: Record<string, number> = {};
  for (const key of keys)
    if (r[key] !== undefined)
      out[key] = bounded(r[key], `${path}.${key}`, MAX_STAT);
  if (Object.keys(out).length === 0) invalid(`${path} needs at least one key`);
  return out;
}

export function parseKnightSheet(value: unknown, path: string): KnightSheetV1 {
  const r = record(value, path, [
    "aspects",
    "characteristics",
    "experienceCurrent",
    "gloryTotal",
    "gloryCurrent",
    ...Object.keys(TEXTS),
  ]);
  const sheet: KnightSheetV1 = {};
  if (r.aspects !== undefined)
    sheet.aspects = stats(r.aspects, `${path}.aspects`, ASPECT_KEYS);
  if (r.characteristics !== undefined)
    sheet.characteristics = stats(
      r.characteristics,
      `${path}.characteristics`,
      CHARACTERISTICS,
    );
  for (const key of ["experienceCurrent", "gloryTotal"] as const)
    if (r[key] !== undefined)
      sheet[key] = bounded(r[key], `${path}.${key}`, MAX_PROGRESSION);
  // A Knight can be overspent: unspent Glory may be negative.
  if (r.gloryCurrent !== undefined)
    sheet.gloryCurrent = bounded(
      r.gloryCurrent,
      `${path}.gloryCurrent`,
      MAX_PROGRESSION,
      -MAX_PROGRESSION,
    );
  for (const [key, [, max]] of Object.entries(TEXTS)) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.includes("\0") || [...v].length > max)
      invalid(
        `${path}.${key} must be text of at most ${max} characters without NUL`,
      );
    sheet[key as TextKey] = v;
  }
  if (Object.keys(sheet).length === 0)
    invalid(`${path} needs at least one field`);
  return sheet;
}

/** The node of an aspect or characteristic on `actor.system`. */
function statNode(group: string, key: string): string {
  return group === "aspects"
    ? `aspects.${key}`
    : `aspects.${ASPECT_OF[key]}.caracteristiques.${key}`;
}

const safe = (v: unknown): v is number => Number.isSafeInteger(v);

/** The prepared (`defineProperty`'d) unspent counts. */
const PREPARED_COUNTS = {
  experienceCurrent: "progression.experience.actuel",
  gloryCurrent: "progression.gloire.actuel",
} as const;
const AUTRE = "progression.gloire.depense.autre";
/** The name of the « other expense » line the lane creates. */
const GLORY_LINE_NAME = "Table Companion";

/** What Foundry holds now for a `sheet.*` field, as the app's base names it:
 * the PREPARED value of a stat and of unspent experience (undefined when it
 * is not a whole number: the field is skipped, so not compared), the stored
 * value of Glory total and the texts. */
export function currentSheetValue(system: unknown, field: string): unknown {
  const [, group, key] = field.split(".");
  if (group === "aspects" || group === "characteristics") {
    const v = valueAt(system, `${statNode(group, key)}.value`);
    return safe(v) ? v : undefined;
  }
  if (group === "experienceCurrent" || group === "gloryCurrent") {
    const v = valueAt(system, PREPARED_COUNTS[group]);
    return safe(v) ? v : undefined;
  }
  if (group === "gloryTotal")
    return valueAt(system, "progression.gloire.total");
  return group in TEXTS
    ? valueAt(system, TEXTS[group as TextKey][0])
    : undefined;
}

/** Knight's sum of a bonus / malus object (`Number(v) || 0`). */
const sum = (o: unknown): number =>
  Object.values((o ?? {}) as Dict).reduce<number>(
    (acc, v) => acc + (Number(v) || 0),
    0,
  );

/** A planned stat, experience or Glory write, checked once the update
 * landed: the field (`aspects.chair`), the prepared path to read, the target,
 * the `system.*` update that undoes it, and what the undo puts back in the
 * result flag besides. */
export interface SheetWrite {
  field: string;
  prepared: string;
  target: number;
  undo: Dict;
  flag?: Dict;
}

/**
 * Plan the sheet's writes into `patch` (`system.*` keys). Returns the stat and
 * experience writes to check after the update, and `written`: the `sheet.*`
 * fields the flag records for the next base compare (the target of each field
 * written or already in place; nothing for a skipped one). Warnings known
 * before the update: `stat_overridden:` (Knight's override wins),
 * `stat_unavailable:` (no whole prepared number), `stat_clamped:` (no base
 * within Knight's 0-9 changes anything). `gloryLineId` is the lane's Glory
 * line as the flag records it; the plan returns the id to record when it
 * writes that line.
 */
export function planKnightSheet(
  system: unknown,
  sheet: KnightSheetV1,
  patch: Dict,
  warnings: string[],
  gloryLineId?: string,
): { checks: SheetWrite[]; written: Dict; gloryLineId?: string } {
  const checks: SheetWrite[] = [];
  const written: Dict = {};
  let lineId: string | undefined;
  const stat = (group: string, key: string, target: number) => {
    const field = `${group}.${key}`;
    const at = statNode(group, key);
    const node = valueAt(system, at) as Dict | undefined;
    if (typeof node !== "object" || node === null) {
      warnings.push(`stat_unavailable:${field}`);
      return;
    }
    const override = Object.values(
      (node.override ?? {}) as Dict,
    ).reduce<number>((max, v) => Math.max(max, Number(v) || 0), 0);
    if (override > 0) {
      warnings.push(`stat_overridden:${field}`);
      return;
    }
    if (!safe(node.value) || !safe(node.base)) {
      warnings.push(`stat_unavailable:${field}`);
      return;
    }
    if (node.value === target) {
      written[`sheet.${field}`] = target;
      return;
    }
    const opti = node.optimisation as Dict | undefined;
    const base = Math.min(
      Math.max(
        target -
          (sum(opti?.bonus) - sum(opti?.malus)) -
          (sum(node.bonus) - sum(node.malus)),
        0,
      ),
      MAX_BASE,
    );
    if (base === node.base) {
      warnings.push(`stat_clamped:${field}`);
      return;
    }
    patch[`system.${at}.base`] = base;
    written[`sheet.${field}`] = target;
    checks.push({
      field,
      prepared: `${at}.value`,
      target,
      undo: { [`system.${at}.base`]: node.base },
    });
  };
  for (const [key, n] of Object.entries(sheet.aspects ?? {}))
    stat("aspects", key, n as number);
  for (const [key, n] of Object.entries(sheet.characteristics ?? {}))
    stat("characteristics", key, n);

  const xp = sheet.experienceCurrent;
  if (xp !== undefined) {
    const now = valueAt(system, "progression.experience.actuel");
    const total = valueAt(system, "progression.experience.total");
    if (!safe(now) || !safe(total))
      warnings.push("stat_unavailable:experienceCurrent");
    else if (now === xp) written["sheet.experienceCurrent"] = xp;
    else {
      const next = Math.max(0, total + xp - now);
      if (next === total) warnings.push("stat_clamped:experienceCurrent");
      else {
        patch["system.progression.experience.total"] = next;
        written["sheet.experienceCurrent"] = xp;
        checks.push({
          field: "experienceCurrent",
          prepared: "progression.experience.actuel",
          target: xp,
          undo: { "system.progression.experience.total": total },
        });
      }
    }
  }

  const glory = sheet.gloryCurrent;
  if (glory !== undefined) {
    const now = valueAt(system, PREPARED_COUNTS.gloryCurrent);
    const total = valueAt(system, "progression.gloire.total");
    if (!safe(now) || !safe(total))
      warnings.push("stat_unavailable:gloryCurrent");
    else {
      // The spend that leaves `glory` unspent under the total this update
      // leaves, beyond what is spent now.
      const delta = (sheet.gloryTotal ?? total) - glory - (total - now);
      written["sheet.gloryCurrent"] = glory;
      if (delta !== 0) {
        const write = gloryLine(system, delta, gloryLineId, patch);
        lineId = write.id;
        checks.push({
          field: "gloryCurrent",
          prepared: PREPARED_COUNTS.gloryCurrent,
          target: glory,
          undo: write.undo,
          flag:
            gloryLineId === undefined
              ? Object.fromEntries([deletionEntry("gloryLineId")])
              : { gloryLineId },
        });
      }
    }
  }

  const absolute: Array<[string, string, unknown]> = [
    ["gloryTotal", "progression.gloire.total", sheet.gloryTotal],
    ...Object.entries(TEXTS).map(
      ([key, [path]]) =>
        [key, path, sheet[key as TextKey]] as [string, string, unknown],
    ),
  ];
  for (const [key, path, v] of absolute) {
    if (v === undefined) continue;
    if (valueAt(system, path) !== v) patch[`system.${path}`] = v;
    written[`sheet.${key}`] = v;
  }
  return {
    checks,
    written,
    ...(lineId === undefined ? {} : { gloryLineId: lineId }),
  };
}

/** Move the lane's Glory line's cost by `delta` into `patch`: the line the
 * flag records when it is still there, else a new one after the highest
 * numeric key (Knight's own « + » takes the last key plus one, so a numeric
 * key keeps that working), at Knight's next order. Returns its id and the
 * update that undoes the write (the previous cost, or the line deleted). */
function gloryLine(
  system: unknown,
  delta: number,
  recorded: string | undefined,
  patch: Dict,
): { id: string; undo: Dict } {
  const autre = (valueAt(system, AUTRE) ?? {}) as Dict;
  const line =
    recorded !== undefined && Object.hasOwn(autre, recorded)
      ? (autre[recorded] as Dict | undefined)
      : undefined;
  if (recorded !== undefined && typeof line === "object" && line !== null) {
    const at = `system.${AUTRE}.${recorded}.cout`;
    patch[at] = (Number(line.cout) || 0) + delta;
    return { id: recorded, undo: { [at]: line.cout } };
  }
  const keys = Object.keys(autre)
    .filter((key) => /^\d+$/.test(key))
    .map(Number);
  const id = String(Math.max(0, ...keys) + 1);
  // Knight's next order: the highest order of the prepared spend list plus
  // one, or the number of entries when none carries one (as its sheet does).
  const liste = Object.values(
    (valueAt(system, "progression.gloire.depense.liste") ?? {}) as Dict,
  ).filter((e) => !(e as Dict | null)?.isEmpty);
  const orders = liste
    .map((e) => Number((e as Dict | null)?.order))
    .filter(Number.isFinite);
  const order = (orders.length > 0 ? Math.max(...orders) : liste.length) + 1;
  patch[`system.${AUTRE}.${id}`] = {
    order: String(order),
    nom: GLORY_LINE_NAME,
    cout: delta,
    gratuit: false,
  };
  const [key, value] = deletionEntry(id);
  return { id, undo: { [`system.${AUTRE}.${key}`]: value } };
}
