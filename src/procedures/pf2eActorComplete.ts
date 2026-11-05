import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import {
  gameItems,
  gamePacks,
  gameUsers,
  type PackDocumentLike,
} from "../foundry/runtime.js";
import type { Procedure } from "../rpc/registry.js";
import { pairedAgentUserId } from "../setup/identity.js";
import {
  actorCollection,
  assertGMResponder,
  bindingId,
  bindingOf,
  canonicalDigest,
  contentsOf,
  FLAG_KEYS,
  flagRecord,
  flagValue,
  foundryId,
  identifier,
  integer,
  invalid,
  OWNERSHIP_OWNER,
  packDocuments,
  parseStoredResult,
  PF2E_REQUIREMENT,
  record,
  supportsPf2eActorUpsertV1Runtime,
  text,
  type ActorItemLike,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";

/**
 * `pf2e.actor.complete.v1`: the character's player completes, from the apps,
 * the build of a Pathfinder 2e character this module created as a draft
 * (`pf2e.actor.upsert.v1`).
 *
 * Every pf2e path below is source-derived (pf2e 8.6.1) and was never confirmed
 * against a live world. The request names the build by slug: attribute boosts,
 * skill ranks, lores, feats, spells and equipment. The procedure only ADDS:
 * it never deletes or rewrites an item already on the Actor, never lowers a
 * rank, never replaces a boost already chosen, and never writes
 * `system.abilities` (manual mode), saves, perception, class DC, level or hit
 * points. The completing user must own the Actor in Foundry at apply time.
 */

const PROCEDURE = "pf2e.actor.complete.v1";
const ACTOR_TYPE = "character";
const MAX_REVISION = 2_147_483_647;
const MAX_BODY_BYTES = 40 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEAT_LOCATION = /^[a-z]+(?:-[a-z]+)*-(?:[1-9]|1\d|20)$/;
const CHOICE_FLAG = /^[A-Za-z0-9-]{1,64}$/;

const ATTRIBUTES = ["str", "dex", "con", "int", "wis", "cha"] as const;
type Attribute = (typeof ATTRIBUTES)[number];
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
const PACKS = {
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

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T))
    invalid(`${path} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    invalid(`${path} must be an array of at most ${max} entries`);
  return value;
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

/** The Actor named by the request, bound to this character and created by
 * this module's draft lane; anything else is refused before any write. */
function targetActor(req: Pf2eActorCompleteV1): ActorLike {
  const actor = actorCollection().get(req.actorId);
  if (!actor)
    throw new RpcError("actor_not_found", "the character's Actor is gone");
  const binding = bindingOf(actor);
  if (
    actor.type !== ACTOR_TYPE ||
    binding?.worldId !== req.worldId ||
    binding.tableId !== req.tableId ||
    binding.characterId !== req.characterId
  )
    throw new RpcError(
      "binding_conflict",
      "the Actor is not this character's bound character Actor",
    );
  const draft = parseStoredResult(actor, FLAG_KEYS.pf2eUpsert);
  if (
    flagValue(actor, FLAG_KEYS.pf2eCreated) !== true &&
    draft?.result.outcome !== "created"
  )
    throw new RpcError(
      "binding_conflict",
      "the Actor was not created by the companion app",
    );
  return actor;
}

/** The completing user must exist, be a plain player (not a GM, not the
 * paired service user) and own the Actor right now. */
function assertCompletingOwner(actor: ActorLike, userId: string): void {
  const user = gameUsers()?.get(userId);
  if (
    userId === "default" ||
    !user ||
    user.isGM === true ||
    userId === pairedAgentUserId() ||
    actor.ownership?.[userId] !== OWNERSHIP_OWNER
  )
    throw new RpcError(
      "permission_denied",
      "the completing user must be a player who owns the Actor",
    );
}

function actorLevel(actor: ActorLike): unknown {
  const system = actor.system as Dict | undefined;
  return ((system?.details as Dict | undefined)?.level as Dict | undefined)
    ?.value;
}

interface StoredCompletion extends Pf2eActorCompleteResultV1 {
  revision: number;
  digest: string;
}

function storedCompletion(actor: ActorLike): StoredCompletion | null {
  const p = flagRecord(
    actor,
    FLAG_KEYS.pf2eComplete,
    (p) =>
      Number.isSafeInteger(p.revision) &&
      typeof p.digest === "string" &&
      (p.completeness === "full" || p.completeness === "partial") &&
      Array.isArray(p.warnings) &&
      typeof p.written === "object" &&
      p.written !== null,
  );
  return p ? (p as unknown as StoredCompletion) : null;
}

function resultOf(c: Pf2eActorCompleteResultV1): Pf2eActorCompleteResultV1 {
  return {
    completeness: c.completeness,
    warnings: [...c.warnings],
    written: { ...c.written },
  };
}

function itemSlug(item: ActorItemLike | Dict): unknown {
  return ((item as Dict).system as Dict | undefined)?.slug;
}

/** A compendium index entry's `system.slug`, whichever shape the index uses. */
function indexSlug(entry: Dict): unknown {
  const system = entry.system;
  if (typeof system === "object" && system !== null)
    return (system as Dict).slug;
  return entry["system.slug"];
}

/** pf2e's default ChoiceSet flag (source-derived (pf2e 8.6.1),
 * `#setDefaultFlag`): the rule's flag stripped to `[-a-z0-9]`, else the
 * rule's or the item's slug in dromedary case. */
function choiceFlag(rule: Dict, itemSlugValue: unknown): string | null {
  if (typeof rule.flag === "string" && rule.flag.length > 0)
    return rule.flag.replace(/[^-a-z0-9]/gi, "");
  const base = typeof rule.slug === "string" ? rule.slug : itemSlugValue;
  if (typeof base !== "string" || base === "") return null;
  return base
    .split("-")
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

/**
 * The ChoiceSet pre-check. Source-derived (pf2e 8.6.1): a ChoiceSet without a
 * stored `selection` matching one of its choices opens a blocking dialog in
 * the creating (GM) browser, which no one answers. Each such rule takes the
 * request's preselection for its flag; when the rule lists its choices, the
 * preselection must be one of them. Returns false when any rule stays
 * unresolved: the item is then skipped, never embedded.
 */
function preselect(source: Dict, choices: Record<string, string>): boolean {
  const system = source.system as Dict | undefined;
  const rules = system?.rules;
  if (!Array.isArray(rules)) return true;
  for (const rule of rules as Dict[]) {
    if (typeof rule !== "object" || rule === null) continue;
    if (rule.key !== "ChoiceSet" || rule.selection != null) continue;
    const flag = choiceFlag(rule, system?.slug);
    const value = flag === null ? undefined : choices[flag];
    if (value === undefined) return false;
    if (
      Array.isArray(rule.choices) &&
      !(rule.choices as Dict[]).some((c) => c?.value === value)
    )
      return false;
    rule.selection = value;
  }
  return true;
}

/** Compendium sources by slug: one index read per pack, and the documents of
 * every slug `prefetch`ed together in one request rather than one each. */
export class PackLookup {
  #indexes = new Map<string, Map<string, string> | null>();
  /** Fetched documents by `pack/id`; null when the pack does not hold it. */
  #docs = new Map<string, PackDocumentLike | null>();

  async prefetch(packId: string, slugs: string[]): Promise<void> {
    if (!this.#indexes.has(packId)) {
      const pack = gamePacks()?.get(packId);
      const index = pack
        ? [...(await pack.getIndex({ fields: ["system.slug"] }))]
        : null;
      this.#indexes.set(
        packId,
        index &&
          new Map(index.map((e) => [String(indexSlug(e)), String(e._id)])),
      );
    }
    const index = this.#indexes.get(packId);
    const ids = slugs
      .map((s) => index?.get(s))
      .filter((id): id is string => !!id && !this.#docs.has(`${packId}/${id}`));
    if (ids.length === 0) return;
    const docs = await packDocuments(packId, ids);
    for (const id of ids)
      this.#docs.set(`${packId}/${id}`, docs.get(id) ?? null);
  }

  async source(packId: string, wanted: string): Promise<Dict | "missing"> {
    await this.prefetch(packId, [wanted]);
    const id = this.#indexes.get(packId)?.get(wanted);
    const doc = id ? this.#docs.get(`${packId}/${id}`) : null;
    if (!doc) return "missing";
    // fromCompendium stamps `_stats.compendiumSource` (the Item's identity).
    return gameItems()!.fromCompendium!(doc);
  }
}

function sluggified(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sourceSystem(actor: ActorLike): Dict {
  const source = (actor as { _source?: { system?: unknown } })._source;
  return ((source?.system ?? actor.system) as Dict | undefined) ?? {};
}

function sourceAt(root: Dict, dotted: string): unknown {
  let cursor: unknown = root;
  for (const part of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Dict)[part];
  }
  return cursor;
}

type BoostSlots = Record<string, { value?: unknown; selected?: unknown }>;

/** The keys to fill on an ABC item's boost slots, following pf2e's attribute
 * builder (source-derived (pf2e 8.6.1), `#findOpenSlot`): for each requested
 * attribute not already selected, the narrowest unselected slot offering it.
 * A slot already chosen in Foundry is never changed. */
function boostSlotUpdates(
  slots: BoostSlots,
  wanted: Attribute[],
  kind: string,
  warnings: string[],
): Dict {
  const open = Object.entries(slots).map(([k, s]) => ({
    key: k,
    selected: s.selected ?? null,
    value: Array.isArray(s.value) ? (s.value as unknown[]) : [],
  }));
  const updates: Dict = {};
  for (const attribute of wanted) {
    if (open.some((s) => s.selected === attribute)) continue;
    const slot = open
      .filter((s) => !s.selected && s.value.includes(attribute))
      .sort((a, b) => a.value.length - b.value.length)[0];
    if (!slot) {
      warnings.push(`boost_skipped:${kind}:${attribute}`);
      continue;
    }
    slot.selected = attribute;
    updates[`system.boosts.${slot.key}.selected`] = attribute;
  }
  return updates;
}

async function createItems(actor: ActorLike, sources: Dict[]): Promise<Dict[]> {
  if (sources.length === 0) return [];
  const created = await actor.createEmbeddedDocuments!("Item", sources);
  return Array.isArray(created) ? (created as Dict[]) : [];
}

/**
 * Checks, in order: GM responder, runtime gate, strict validation, the bound
 * app-created character Actor, the completing user's ownership now, the
 * level, the stored completion (replay or stale revision). Every slug is then
 * resolved before the first write, so a refusal writes nothing. The
 * completion flag is written LAST: until then the revision is unrecorded and
 * a re-send applies again (additively, so nothing doubles).
 */
export const pf2eActorCompleteV1: Procedure = async (payload) => {
  assertGMResponder(PROCEDURE);
  if (!supportsPf2eActorUpsertV1Runtime())
    throw new RpcError(
      "unsupported_runtime",
      `${PROCEDURE} requires ${PF2E_REQUIREMENT}`,
    );
  const req = validatePf2eActorCompleteV1(payload);
  const actor = targetActor(req);
  assertCompletingOwner(actor, req.foundryUserId);
  if (actorLevel(actor) !== req.level)
    throw new RpcError(
      "level_mismatch",
      "the Actor's level differs from the completed build's",
    );
  const digest = await canonicalDigest(req);
  const previous = storedCompletion(actor);
  if (previous) {
    if (previous.revision > req.completionRevision)
      throw new RpcError(
        "stale_revision",
        "the Actor has a newer completion revision",
      );
    if (previous.revision === req.completionRevision) {
      if (previous.digest !== digest)
        throw new RpcError(
          "revision_conflict",
          "the same completion revision carries different content",
        );
      return resultOf(previous);
    }
  }
  if (
    typeof gameItems()?.fromCompendium !== "function" ||
    typeof actor.createEmbeddedDocuments !== "function"
  )
    throw new RpcError(
      "unsupported_runtime",
      "item creation from the system compendiums is unavailable",
    );

  const warnings: string[] = [];
  const items = contentsOf(actor.items);
  const present = (type: string, s: string, location?: string): boolean =>
    items.some(
      (i) =>
        i.type === type &&
        itemSlug(i) === s &&
        (location === undefined ||
          ((i.system as Dict | undefined)?.location as Dict | undefined)
            ?.value === location),
    );
  const packs = new PackLookup();
  await Promise.all([
    packs.prefetch(
      PACKS.feat,
      req.feats.map((f) => f.slug),
    ),
    packs.prefetch(
      PACKS.spell,
      req.spellcasting.flatMap((c) => c.spells.map((s) => s.slug)),
    ),
    packs.prefetch(
      PACKS.equipment,
      req.equipment.map((e) => e.slug),
    ),
  ]);
  const resolve = async (
    packId: string,
    s: string,
    choices: Record<string, string> = {},
  ): Promise<Dict | null> => {
    const source = await packs.source(packId, s);
    if (source === "missing") {
      warnings.push(`item_not_found:${s}`);
      return null;
    }
    if (!preselect(source, choices)) {
      warnings.push(`item_skipped:${s}`);
      return null;
    }
    return source;
  };

  // Resolve everything before the first write.
  const feats: Dict[] = [];
  for (const feat of req.feats) {
    if (present("feat", feat.slug)) {
      warnings.push(`item_present:${feat.slug}`);
      continue;
    }
    const source = await resolve(PACKS.feat, feat.slug, feat.choices);
    if (source)
      feats.push({
        ...source,
        system: { ...(source.system as Dict), location: feat.location },
      });
  }
  const entries = contentsOf(actor.items).filter(
    (i) => i.type === "spellcastingEntry",
  );
  const castings: Array<{ entryId?: string; entry?: Dict; spells: Dict[] }> =
    [];
  for (const casting of req.spellcasting) {
    // The apps send no entry slug: key the entry on tradition-kind, stamped on
    // the entry it creates, so a second completion finds it again.
    const key = casting.slug ?? `${casting.tradition}-${casting.kind}`;
    const keyed = entries
      .filter((e) => itemSlug(e) === key)
      .map((e) => String(e.id ?? e._id));
    const entryId = keyed[0];
    const spells: Dict[] = [];
    for (const spell of casting.spells) {
      if (keyed.some((id) => present("spell", spell.slug, id))) {
        warnings.push(`item_present:${spell.slug}`);
        continue;
      }
      const source = await resolve(PACKS.spell, spell.slug);
      if (!source) continue;
      const system = source.system as Dict;
      const base = Number((system.level as Dict | undefined)?.value);
      spells.push({
        ...source,
        system: {
          ...system,
          location: {
            value: null,
            ...(spell.rank > base ? { heightenedLevel: spell.rank } : {}),
          },
        },
      });
    }
    castings.push({
      ...(entryId
        ? { entryId }
        : {
            entry: {
              name: `${casting.tradition} ${casting.kind} spells`,
              type: "spellcastingEntry",
              system: {
                slug: key,
                tradition: { value: casting.tradition },
                prepared: { value: casting.kind },
              },
            },
          }),
      spells,
    });
  }
  const equipment: Dict[] = [];
  for (const entry of req.equipment) {
    const source = await packs.source(PACKS.equipment, entry.slug);
    if (source === "missing") warnings.push(`item_not_found:${entry.slug}`);
    else if (present(String(source.type), entry.slug))
      warnings.push(`item_present:${entry.slug}`);
    else if (!preselect(source, {}))
      warnings.push(`item_skipped:${entry.slug}`);
    else
      equipment.push({
        ...source,
        system: { ...(source.system as Dict), quantity: entry.quantity },
      });
  }
  const lores: Dict[] = [];
  for (const lore of req.lores) {
    const wanted = lore.name.trim().toLowerCase();
    if (
      items.some(
        (i) =>
          i.type === "lore" &&
          String((i as Dict).name ?? "")
            .trim()
            .toLowerCase() === wanted,
      )
    ) {
      warnings.push(`item_present:${sluggified(lore.name)}`);
      continue;
    }
    lores.push({
      name: lore.name,
      type: "lore",
      system: { proficient: { value: lore.rank } },
    });
  }

  // ONE actor update: skill ranks (raised, never lowered) and the level
  // boosts (a level Foundry already filled is left alone).
  const system = sourceSystem(actor);
  const update: Dict = {};
  for (const [skill, rank] of Object.entries(req.skills)) {
    const current = Number(sourceAt(system, `skills.${skill}.rank`) ?? 0);
    if (rank > current) update[`system.skills.${skill}.rank`] = rank;
  }
  for (const [level, wanted] of Object.entries(req.boosts)) {
    const current = sourceAt(system, `build.attributes.boosts.${level}`);
    if (Array.isArray(current) && current.length > 0) {
      if ([...current].sort().join() !== [...wanted].sort().join())
        warnings.push(`boosts_present:${level}`);
      continue;
    }
    if (wanted.length > 0)
      update[`system.build.attributes.boosts.${level}`] = [...wanted];
  }
  if (Object.keys(update).length > 0) await actor.update(update);

  // The ABC choices live on the ABC items themselves (pf2e's attribute
  // builder writes them there): only open slots are filled.
  for (const kind of ["ancestry", "background"] as const) {
    const wanted = req.boostSelections[kind];
    if (!wanted?.length) continue;
    const item = items.find((i) => i.type === kind);
    if (!item?.update) {
      warnings.push(`abc_missing:${kind}`);
      continue;
    }
    const boosts = (item.system as Dict | undefined)?.boosts;
    const changes = boostSlotUpdates(
      (boosts ?? {}) as BoostSlots,
      wanted,
      kind,
      warnings,
    );
    if (Object.keys(changes).length > 0) await item.update(changes);
  }
  if (req.keyAbility) {
    const item = items.find((i) => i.type === "class");
    const key = (item?.system as Dict | undefined)?.keyAbility as
      Dict | undefined;
    const offered = Array.isArray(key?.value) ? (key.value as unknown[]) : [];
    if (!item?.update) warnings.push("abc_missing:class");
    else if (key?.selected === req.keyAbility) {
      // already chosen
    } else if (key?.selected || !offered.includes(req.keyAbility))
      warnings.push(`key_ability_skipped:${req.keyAbility}`);
    else await item.update({ "system.keyAbility.selected": req.keyAbility });
  }

  // One createEmbeddedDocuments per family; spells after their entries so
  // each spell carries its entry's new id.
  const written = { feats: 0, spells: 0, equipment: 0, lores: 0 };
  written.feats = (await createItems(actor, feats)).length;
  const newEntries = castings.filter((c) => c.entry);
  const createdEntries = await createItems(
    actor,
    newEntries.map((c) => c.entry!),
  );
  if (createdEntries.length !== newEntries.length)
    throw new Error("Foundry did not return the created spellcasting entries");
  newEntries.forEach((c, i) => {
    c.entryId = String(createdEntries[i].id ?? createdEntries[i]._id);
  });
  const spells = castings.flatMap((c) =>
    c.spells.map((s) => {
      const system = s.system as Dict;
      return {
        ...s,
        system: {
          ...system,
          location: { ...(system.location as Dict), value: c.entryId },
        },
      };
    }),
  );
  written.spells = (await createItems(actor, spells)).length;
  written.equipment = (await createItems(actor, equipment)).length;
  written.lores = (await createItems(actor, lores)).length;

  const result: Pf2eActorCompleteResultV1 = {
    completeness: warnings.every((w) => w.startsWith("item_present:"))
      ? "full"
      : "partial",
    warnings,
    written,
  };
  await actor.update({
    [`flags.${MODULE_ID}.${FLAG_KEYS.pf2eComplete}`]: {
      schemaVersion: 1,
      revision: req.completionRevision,
      digest,
      ...resultOf(result),
    },
  });
  return result;
};
