import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import { gameItems, gameUsers } from "../foundry/runtime.js";
import type { Procedure } from "../rpc/registry.js";
import { pairedAgentUserId } from "../setup/identity.js";
import {
  actorCollection,
  assertLaneAuthority,
  bindingOf,
  canonicalDigest,
  contentsOf,
  FLAG_KEYS,
  flagRecord,
  flagValue,
  OWNERSHIP_OWNER,
  parseStoredResult,
  PF2E_REQUIREMENT,
  replayDigests,
  sameCharacter,
  supportsPf2eActorUpsertV1Runtime,
  valueAt,
  type ActorItemLike,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";
import { PackLookup } from "./pf2ePacks.js";
import {
  type Pf2eActorCompleteV1,
  ACTOR_TYPE,
  type Pf2eActorCompleteResultV1,
  type Attribute,
  PROCEDURE,
  validatePf2eActorCompleteV1,
  PACKS,
} from "./pf2eActorComplete.validate.js";

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

/** The Actor named by the request, bound to this character and created by
 * this module's draft lane; anything else is refused before any write. */
function targetActor(req: Pf2eActorCompleteV1): ActorLike {
  const actor = actorCollection().get(req.actorId);
  if (!actor)
    throw new RpcError("actor_not_found", "the character's Actor is gone");
  if (actor.type !== ACTOR_TYPE || !sameCharacter(bindingOf(actor), req))
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
  assertLaneAuthority(
    PROCEDURE,
    supportsPf2eActorUpsertV1Runtime,
    PF2E_REQUIREMENT,
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
      if (!(await replayDigests(req, actor, digest)).includes(previous.digest))
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
    const current = Number(valueAt(system, `skills.${skill}.rank`) ?? 0);
    if (rank > current) update[`system.skills.${skill}.rank`] = rank;
  }
  for (const [level, wanted] of Object.entries(req.boosts)) {
    const current = valueAt(system, `build.attributes.boosts.${level}`);
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
