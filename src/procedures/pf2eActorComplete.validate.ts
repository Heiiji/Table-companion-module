import {
  bindingId,
  foundryId,
  identifier,
  integer,
  invalid,
  list,
  oneOf,
  record,
  text,
  type Dict,
} from "./upsertShared.js";

export const PROCEDURE = "pf2e.actor.complete.v1";
export const ACTOR_TYPE = "character";
const MAX_REVISION = 2_147_483_647;
const MAX_BODY_BYTES = 40 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEAT_LOCATION = /^[a-z]+(?:-[a-z]+)*-(?:[1-9]|1\d|20)$/;
const CHOICE_FLAG = /^[A-Za-z0-9-]{1,64}$/;

const ATTRIBUTES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Attribute = (typeof ATTRIBUTES)[number];
const BOOST_LEVELS = ["1", "5", "10", "15", "20"] as const;
type BoostLevel = (typeof BOOST_LEVELS)[number];
/** source-derived (pf2e 8.6.1): `CORE_SKILL_SLUGS`. */
const SKILLS = [
  "acrobatics",
  "arcana",
  "athletics",
  "crafting",
  "deception",
  "diplomacy",
  "intimidation",
  "medicine",
  "nature",
  "occultism",
  "performance",
  "religion",
  "society",
  "stealth",
  "survival",
  "thievery",
] as const;
const TRADITIONS = ["arcane", "divine", "occult", "primal"] as const;
const CASTING_KINDS = ["prepared", "spontaneous", "innate", "focus"] as const;

/** The system compendium pack each family is looked up in, by `system.slug`
 * (source-derived (pf2e 8.6.1): `system.pf2e.json` packs). */
export const PACKS = {
  feat: "pf2e.feats-srd",
  spell: "pf2e.spells-srd",
  equipment: "pf2e.equipment-srd",
} as const;

export interface Pf2eActorCompleteV1 {
  worldId: string;
  tableId: string;
  characterId: string;
  actorId: string;
  foundryUserId: string;
  memberId: string;
  completionRevision: number;
  level: number;
  boosts: Partial<Record<BoostLevel, Attribute[]>>;
  boostSelections: { ancestry?: Attribute[]; background?: Attribute[] };
  keyAbility?: Attribute;
  skills: Partial<Record<(typeof SKILLS)[number], number>>;
  lores: Array<{ name: string; rank: number }>;
  feats: Array<{
    slug: string;
    location: string;
    choices?: Record<string, string>;
  }>;
  spellcasting: Array<{
    slug?: string;
    tradition: (typeof TRADITIONS)[number];
    kind: (typeof CASTING_KINDS)[number];
    spells: Array<{ slug: string; rank: number }>;
  }>;
  equipment: Array<{ slug: string; quantity: number }>;
}

export interface Pf2eActorCompleteResultV1 {
  completeness: "full" | "partial";
  warnings: string[];
  written: { feats: number; spells: number; equipment: number; lores: number };
}

function slug(value: unknown, path: string): string {
  const s = text(value, path, 64, true);
  if (!SLUG.test(s) || new TextEncoder().encode(s).length > 64)
    invalid(`${path} must be a lowercase hyphenated slug`);
  return s;
}

function attributes(value: unknown, path: string): Attribute[] {
  const out = list(value, path, 4).map((a, i) =>
    oneOf(a, `${path}[${i}]`, ATTRIBUTES),
  );
  if (new Set(out).size !== out.length) invalid(`${path} repeats an attribute`);
  return out;
}

export function validatePf2eActorCompleteV1(
  payload: unknown,
): Pf2eActorCompleteV1 {
  if (JSON.stringify(payload ?? null).length > MAX_BODY_BYTES)
    invalid(`the request exceeds ${MAX_BODY_BYTES} bytes`);
  const p = record(payload, "pf2eActorComplete", [
    "worldId",
    "tableId",
    "characterId",
    "actorId",
    "foundryUserId",
    "memberId",
    "completionRevision",
    "level",
    "boosts",
    "boostSelections",
    "keyAbility",
    "skills",
    "lores",
    "feats",
    "spellcasting",
    "equipment",
  ]);
  const foundryUserId = identifier(p.foundryUserId, "foundryUserId", foundryId);
  if (foundryUserId === "default")
    invalid("foundryUserId cannot be the reserved ownership key default");

  const b = record(p.boosts, "boosts", BOOST_LEVELS);
  const boosts: Pf2eActorCompleteV1["boosts"] = {};
  for (const level of BOOST_LEVELS)
    if (b[level] !== undefined)
      boosts[level] = attributes(b[level], `boosts.${level}`);

  const s = record(p.boostSelections, "boostSelections", [
    "ancestry",
    "background",
  ]);
  const boostSelections: Pf2eActorCompleteV1["boostSelections"] = {};
  for (const kind of ["ancestry", "background"] as const)
    if (s[kind] !== undefined)
      boostSelections[kind] = attributes(s[kind], `boostSelections.${kind}`);

  const sk = record(p.skills, "skills", SKILLS);
  const skills: Pf2eActorCompleteV1["skills"] = {};
  for (const skill of SKILLS)
    if (sk[skill] !== undefined)
      skills[skill] = integer(sk[skill], `skills.${skill}`, 0, 4);

  const lores = list(p.lores, "lores", 16).map((value, i) => {
    const l = record(value, `lores[${i}]`, ["name", "rank"]);
    return {
      name: text(l.name, `lores[${i}].name`, 64, true),
      rank: integer(l.rank, `lores[${i}].rank`, 1, 4),
    };
  });

  const feats = list(p.feats, "feats", 64).map((value, i) => {
    const f = record(value, `feats[${i}]`, ["slug", "location", "choices"]);
    const location = text(f.location, `feats[${i}].location`, 64, true);
    if (!FEAT_LOCATION.test(location))
      invalid(`feats[${i}].location must be <group>-<level>`);
    const feat: Pf2eActorCompleteV1["feats"][number] = {
      slug: slug(f.slug, `feats[${i}].slug`),
      location,
    };
    if (f.choices !== undefined) {
      if (
        typeof f.choices !== "object" ||
        f.choices === null ||
        Array.isArray(f.choices) ||
        Object.keys(f.choices).length > 8
      )
        invalid(`feats[${i}].choices must be an object of at most 8 entries`);
      const choices: Record<string, string> = {};
      for (const [flag, choice] of Object.entries(f.choices as Dict)) {
        if (!CHOICE_FLAG.test(flag))
          invalid(`feats[${i}].choices has an invalid flag`);
        choices[flag] = text(choice, `feats[${i}].choices.${flag}`, 256, true);
      }
      feat.choices = choices;
    }
    return feat;
  });

  let spellCount = 0;
  const spellcasting = list(p.spellcasting, "spellcasting", 16).map(
    (value, i) => {
      const e = record(value, `spellcasting[${i}]`, [
        "slug",
        "tradition",
        "kind",
        "spells",
      ]);
      const spells = list(e.spells, `spellcasting[${i}].spells`, 300).map(
        (sp, j) => {
          const path = `spellcasting[${i}].spells[${j}]`;
          const r = record(sp, path, ["slug", "rank"]);
          return {
            slug: slug(r.slug, `${path}.slug`),
            rank: integer(r.rank, `${path}.rank`, 0, 10),
          };
        },
      );
      spellCount += spells.length;
      return {
        ...(e.slug === undefined
          ? {}
          : { slug: slug(e.slug, `spellcasting[${i}].slug`) }),
        tradition: oneOf(
          e.tradition,
          `spellcasting[${i}].tradition`,
          TRADITIONS,
        ),
        kind: oneOf(e.kind, `spellcasting[${i}].kind`, CASTING_KINDS),
        spells,
      };
    },
  );
  if (spellCount > 300) invalid("at most 300 spells");

  const equipment = list(p.equipment, "equipment", 200).map((value, i) => {
    const q = record(value, `equipment[${i}]`, ["slug", "quantity"]);
    return {
      slug: slug(q.slug, `equipment[${i}].slug`),
      quantity: integer(q.quantity, `equipment[${i}].quantity`, 1, 999_999),
    };
  });

  return {
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    characterId: identifier(p.characterId, "characterId", bindingId),
    actorId: identifier(p.actorId, "actorId", foundryId),
    foundryUserId,
    memberId: identifier(p.memberId, "memberId", bindingId),
    completionRevision: integer(
      p.completionRevision,
      "completionRevision",
      1,
      MAX_REVISION,
    ),
    level: integer(p.level, "level", 1, 20),
    boosts,
    boostSelections,
    ...(p.keyAbility === undefined
      ? {}
      : { keyAbility: oneOf(p.keyAbility, "keyAbility", ATTRIBUTES) }),
    skills,
    lores,
    feats,
    spellcasting,
    equipment,
  };
}
