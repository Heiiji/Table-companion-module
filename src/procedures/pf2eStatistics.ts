import { gameActors } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  PF2E_RESOURCES_REQUIREMENT,
  actorCollection,
  assertLaneAuthority,
  bindingId,
  contentsOf,
  docId,
  documentId,
  identifier,
  invalid,
  oneOf,
  record,
  supportsPf2eResourcesV1Runtime,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";

/**
 * Foundry's prepared numbers for one Pathfinder 2e Actor
 * (`pf2e.statistics.v1`): armor class, perception, saves, skills (lores
 * included), class DC, each spellcasting entry's attack and DC, and the
 * strikes with their three multiple-attack-penalty modifiers and damage
 * formulas. A read: it never writes, rolls, posts to chat or opens a sheet.
 *
 * pf2e raises proficiencies and applies bonuses through rule elements the app
 * does not run, so the app rolls with these values rather than deriving its
 * own. Every API below is source-derived (pf2e 8.6.1), never confirmed against
 * a live world: `Statistic` (`system/statistic/statistic.ts`: `mod`,
 * `dc.value`, `rank`, `label`, `lore`), the Actor's `armorClass`,
 * `perception`, `saves`, `skills` (`actor/creature/document.ts`), the
 * character's `classDC` (`actor/character/document.ts`), each spellcasting
 * entry's `statistic` (`item/spellcasting-entry/document.ts`), and the strikes
 * of `system.actions` (`actor/character/document.ts` prepareStrike,
 * `actor/helpers.ts` attackFromMeleeItem): `totalModifier`, `variants[].penalty`,
 * `damage` / `critical` with `{ getFormula: true }`.
 */

const PROCEDURE = "pf2e.statistics.v1";
const ACTOR_TYPES = ["character", "npc"] as const;
type StatisticsActorType = (typeof ACTOR_TYPES)[number];

const MAX_SKILLS = 64;
const MAX_SPELLCASTING = 16;
const MAX_STRIKES = 50;
const MAX_TRAITS = 30;
const MAX_LABEL = 120;
const MAX_FORMULA = 200;
const MAX_INT = 999;

/** C0 and C1 control characters, DEL included. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** pf2e's action glyphs (`util/misc.ts` getActionGlyph: "1".."3"; the
 * character sheet's strike uses the font letter "A"). */
const ACTION_GLYPHS: Record<string, 1 | 2 | 3> = {
  "1": 1,
  A: 1,
  "2": 2,
  D: 2,
  "3": 3,
  T: 3,
};

export interface Pf2eStatV1 {
  mod: number;
  dc: number | null;
  rank: 0 | 1 | 2 | 3 | 4 | null;
}

export interface Pf2eStatisticsV1 {
  schemaVersion: 1;
  actorId: string;
  actorType: StatisticsActorType;
  ac: number | null;
  perception: Pf2eStatV1 | null;
  saves: {
    fortitude: Pf2eStatV1 | null;
    reflex: Pf2eStatV1 | null;
    will: Pf2eStatV1 | null;
  };
  skills: ({ slug: string; label: string; lore: boolean } & Pf2eStatV1)[];
  classDC: Pf2eStatV1 | null;
  spellcasting: {
    entryId: string;
    attack: number | null;
    dc: number | null;
  }[];
  strikes: {
    label: string;
    itemId: string | null;
    slug: string | null;
    actionCost: 1 | 2 | 3 | null;
    traits: string[];
    variants: [number, number, number];
    damage: string | null;
    critical: string | null;
  }[];
}

/** The prepared members this procedure reads, as pf2e 8.6.1 shapes them. */
interface StatisticsActor extends ActorLike {
  armorClass?: { value?: unknown } | null;
  perception?: unknown;
  saves?: Dict;
  skills?: Dict;
  classDC?: unknown;
}

/** The Actor answers like a prepared pf2e creature. */
export function hasPf2eStatisticApis(actor: ActorLike): boolean {
  const a = actor as StatisticsActor;
  return (
    isDict(a.perception) &&
    isDict(a.saves) &&
    isDict(a.skills) &&
    Array.isArray(dictAt(a.system, "actions"))
  );
}

/** Gate of `pf2e.statistics.v1`: the resources lane's pf2e floor, with the
 * prepared statistics on the world's creatures. A world without one answers
 * by the floor; the handler probes the read Actor again. */
export function supportsPf2eStatisticsV1Runtime(): boolean {
  if (!supportsPf2eResourcesV1Runtime()) return false;
  const creature = contentsOf(gameActors()).find((a) =>
    (ACTOR_TYPES as readonly unknown[]).includes(a.type),
  );
  return creature === undefined || hasPf2eStatisticApis(creature);
}

export const pf2eStatisticsV1: Procedure = async (payload) => {
  const p = record(payload, "payload", [
    "schemaVersion",
    "worldId",
    "expectedActorId",
    "actorType",
  ]);
  if (p.schemaVersion !== 1) invalid("schemaVersion must be 1");
  identifier(p.worldId, "worldId", bindingId);
  const actorId = identifier(p.expectedActorId, "expectedActorId", documentId);
  const actorType = oneOf(p.actorType, "actorType", ACTOR_TYPES);
  assertLaneAuthority(
    PROCEDURE,
    supportsPf2eStatisticsV1Runtime,
    PF2E_RESOURCES_REQUIREMENT,
  );
  const actor = actorCollection().get(actorId) as StatisticsActor | undefined;
  if (!actor) throw new RpcError("actor_not_found", "no Actor has that id");
  if (actor.type !== actorType) invalid(`the Actor is not a ${actorType}`);
  if (!hasPf2eStatisticApis(actor))
    throw new RpcError(
      "unsupported_runtime",
      "the Actor has no prepared pf2e statistics",
    );

  const saves = isDict(actor.saves) ? actor.saves : {};
  return {
    schemaVersion: 1,
    actorId,
    actorType,
    ac: safely(() => int(actor.armorClass?.value)),
    perception: stat(actor.perception),
    saves: {
      fortitude: stat(saves.fortitude),
      reflex: stat(saves.reflex),
      will: stat(saves.will),
    },
    skills: skills(actor),
    classDC: actorType === "character" ? stat(actor.classDC) : null,
    spellcasting: spellcasting(actor),
    strikes: await strikes(actor),
  } satisfies Pf2eStatisticsV1;
};

function skills(actor: StatisticsActor): Pf2eStatisticsV1["skills"] {
  const out: Pf2eStatisticsV1["skills"] = [];
  for (const [key, s] of Object.entries(actor.skills ?? {})) {
    const value = stat(s);
    const slug = name(dictAt(s, "slug")) ?? name(key);
    if (!value || !slug) continue;
    out.push({
      slug,
      label: label(dictAt(s, "label")) || slug,
      lore: dictAt(s, "lore") === true,
      ...value,
    });
  }
  bounded(out, MAX_SKILLS, "skills");
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function spellcasting(
  actor: StatisticsActor,
): Pf2eStatisticsV1["spellcasting"] {
  const out: Pf2eStatisticsV1["spellcasting"] = [];
  for (const item of contentsOf(actor.items)) {
    const entryId = docId(item);
    if (item.type !== "spellcastingEntry" || !documentId.test(entryId))
      continue;
    const statistic = dictAt(item, "statistic");
    out.push({
      entryId,
      attack: safely(() => int(dictAt(statistic, "mod"))),
      dc: safely(() => int(dictAt(dictAt(statistic, "dc"), "value"))),
    });
  }
  return bounded(out, MAX_SPELLCASTING, "spellcasting");
}

async function strikes(
  actor: StatisticsActor,
): Promise<Pf2eStatisticsV1["strikes"]> {
  const actions = dictAt(actor.system, "actions") as unknown[];
  // What pf2e's sheet prints: strikes only (not area or auto-fire), and not
  // the ones it hides (a stowed weapon, the hidden basic unarmed attack).
  const shown = actions.filter(
    (s) => dictAt(s, "type") === "strike" && dictAt(s, "visible") !== false,
  );
  bounded(shown, MAX_STRIKES, "strikes");
  const out: Pf2eStatisticsV1["strikes"] = [];
  for (const s of shown as Dict[]) {
    const variants = safely(() => mapVariants(s));
    if (!variants) continue;
    const item = dictAt(s, "item") as { id?: string; _id?: string } | null;
    const itemId = docId(item);
    const traits = [
      ...new Set(
        [dictAt(s, "traits"), dictAt(s, "weaponTraits")]
          .flatMap((list) => (Array.isArray(list) ? list : []))
          .map((t) => name(dictAt(t, "name")))
          .filter((t): t is string => t !== null),
      ),
    ];
    out.push({
      label: label(dictAt(s, "label")),
      itemId: documentId.test(itemId) ? itemId : null,
      slug: name(dictAt(s, "slug")),
      actionCost: ACTION_GLYPHS[String(dictAt(s, "glyph"))] ?? null,
      traits: bounded(traits, MAX_TRAITS, "strike traits"),
      variants,
      damage: await formula(s.damage),
      critical: await formula(s.critical),
    });
  }
  return out;
}

/** The three attack modifiers pf2e prints (`totalModifier + penalty`). A
 * strike not subject to the multiple attack penalty has one variant: the same
 * modifier for every attack. */
function mapVariants(s: Dict): [number, number, number] | null {
  const total = dictAt(s, "totalModifier");
  const list = dictAt(s, "variants");
  if (typeof total !== "number" || !Array.isArray(list)) return null;
  const mods = list.map((v) => int(total + Number(dictAt(v, "penalty") ?? 0)));
  if (mods.length === 1) mods.push(mods[0], mods[0]);
  if (mods.length !== 3 || mods.some((m) => m === null)) return null;
  return mods as [number, number, number];
}

/** A damage function's formula, or null when it is absent, throws, answers
 * nothing or is too long: never a failure of the whole read. */
async function formula(fn: unknown): Promise<string | null> {
  if (typeof fn !== "function") return null;
  try {
    const f: unknown = await fn({ getFormula: true });
    return typeof f === "string" && f.trim() !== "" && f.length <= MAX_FORMULA
      ? f
      : null;
  } catch {
    return null;
  }
}

function stat(s: unknown): Pf2eStatV1 | null {
  return safely(() => {
    if (!isDict(s)) return null;
    const mod = int(s.mod);
    if (mod === null) return null;
    const rank = s.rank;
    return {
      mod,
      dc: int(dictAt(s.dc, "value")),
      rank:
        rank === 0 || rank === 1 || rank === 2 || rank === 3 || rank === 4
          ? rank
          : null,
    };
  });
}

/** Refuse, never truncate: a cut list would read as complete. */
function bounded<T>(list: T[], max: number, what: string): T[] {
  if (list.length > max)
    throw new RpcError(
      "payload_too_large",
      `${what}: ${list.length} entries, at most ${max}`,
    );
  return list;
}

function int(v: unknown): number | null {
  return Number.isSafeInteger(v) && Math.abs(v as number) <= MAX_INT
    ? (v as number)
    : null;
}

/** pf2e's localized label with markup and control characters removed, cut to
 * 120 UTF-16 units on a character boundary. */
function label(v: unknown): string {
  if (typeof v !== "string") return "";
  const clean = v
    .replace(/<[^>]*>/g, "")
    .replace(CONTROL, "")
    .trim();
  let out = "";
  for (const ch of clean) {
    if (out.length + ch.length > MAX_LABEL) break;
    out += ch;
  }
  return out;
}

/** A slug-like identifier as pf2e writes one, or null. */
function name(v: unknown): string | null {
  return typeof v === "string" &&
    v !== "" &&
    v.length <= MAX_LABEL &&
    !/[\s\u0000-\u001f\u007f-\u009f]/.test(v)
    ? v
    : null;
}

function safely<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dictAt(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null ? (v as Dict)[key] : undefined;
}
