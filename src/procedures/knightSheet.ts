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
  age?: string;
  nickname?: string;
  majorMotivation?: string;
}

function bounded(value: unknown, path: string, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  )
    invalid(`${path} outside 0-${max}`);
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
  if (group === "experienceCurrent") {
    const v = valueAt(system, "progression.experience.actuel");
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

/** A planned stat or experience write, checked once the update landed: the
 * field (`aspects.chair`), the prepared path to read, the target, and the
 * stored path with the value it held before (to undo it). */
export interface SheetWrite {
  field: string;
  prepared: string;
  target: number;
  stored: string;
  before: number;
}

/**
 * Plan the sheet's writes into `patch` (`system.*` keys). Returns the stat and
 * experience writes to check after the update, and `written`: the `sheet.*`
 * fields the flag records for the next base compare (the target of each field
 * written or already in place; nothing for a skipped one). Warnings known
 * before the update: `stat_overridden:` (Knight's override wins),
 * `stat_unavailable:` (no whole prepared number), `stat_clamped:` (no base
 * within Knight's 0-9 changes anything).
 */
export function planKnightSheet(
  system: unknown,
  sheet: KnightSheetV1,
  patch: Dict,
  warnings: string[],
): { checks: SheetWrite[]; written: Dict } {
  const checks: SheetWrite[] = [];
  const written: Dict = {};
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
      stored: `${at}.base`,
      before: node.base,
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
          stored: "progression.experience.total",
          before: total,
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
  return { checks, written };
}
