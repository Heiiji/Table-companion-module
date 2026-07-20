import type { Procedure } from "../rpc/registry.js";
import {
  actors,
  assertCompanionPermission,
  PermissionActorLike,
  systemId,
} from "./foundry.js";
import { assertPayloadWithinCap, RpcError } from "../rpc/errors.js";

/**
 * Tier-1 oracle (read): expose a fully-prepared actor's system-aware data over the RPC channel for
 * systems whose existing integration contract admits the response.
 *
 * The headless Go connector only ever sees Foundry *source* data; some prepared data exists only
 * inside the live system session. For currently supported systems this legacy procedure returns the
 * prepared `actor.system` plus a small normalized `derived` block.
 *
 * Strictly additive enrichment: when this capability is absent the app keeps its own locally
 * derived baseline (standalone-first), so no widget is ever gated by Foundry being online.
 *
 * `sheet.derived({ actorId })` → `{ actorId, name, type, img, system, items, effects, derived }`
 *
 * PF2e is explicitly unavailable. Its former broad actor.system/Item export was neither a narrow,
 * versioned DTO nor evidence-backed against a real Table Companion PF2e fixture. PF2e registration
 * omits this capability and this handler rejects stale/direct calls before reading an Actor. A new
 * permission-aware projection must pass the M8 authentication and exact-version fixture gate.
 */

interface ItemLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  img?: string | null;
  system?: Record<string, unknown>;
}
interface EffectLike {
  id?: string | null;
  name?: string | null;
  disabled?: boolean;
  // Foundry models an ActiveEffect's `statuses` as a Set<string>, which is iterable; that is the
  // only shape we need to flatten. (A bare {has}-only container cannot be enumerated, so it was
  // never actually handled — the old union member for it was dead.)
  statuses?: Iterable<string>;
  changes?: unknown;
}
interface ActorLike extends PermissionActorLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  img?: string | null;
  system?: Record<string, unknown>;
  items?: Iterable<ItemLike>;
  effects?: Iterable<EffectLike>;
}
/** Safely read a number at a nested path; undefined if any segment is missing or non-numeric. */
function num(obj: unknown, ...path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (
      cur &&
      typeof cur === "object" &&
      key in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return typeof cur === "number" ? cur : undefined;
}

function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Normalize one spell-slot bucket (system.spells.spellN or .pact) into {value,max}, dropping it
 * when neither side is present so non-casters / unused levels don't emit empty buckets.
 */
function slotBucket(
  spells: unknown,
  key: string,
): { value?: number; max?: number } | undefined {
  const value = num(spells, key, "value");
  const max = num(spells, key, "max");
  if (value === undefined && max === undefined) return undefined;
  return defined({ value, max });
}

/**
 * spellSlots: per-level {value: remaining, max: total} for levels 1..9 plus Warlock `pact`.
 * Verified paths: system.spells.spellN.value/.max and system.spells.pact.value/.max (dnd5e
 * Roll-Formulas wiki). Returns undefined when no bucket has data (caller drops it via defined()).
 */
function dnd5eSpellSlots(
  sys: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const spells = sys.spells;
  if (!spells || typeof spells !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (let level = 1; level <= 9; level++) {
    const bucket = slotBucket(spells, `spell${level}`);
    if (bucket) out[`level${level}`] = bucket;
  }
  const pact = slotBucket(spells, "pact");
  if (pact) out.pact = pact;
  return Object.keys(out).length ? out : undefined;
}

/**
 * hitDice {value: remaining, max: total}. v4 stores system.attributes.hd as an object with
 * .value/.max (the HitDice document); v3 stored a bare integer (remaining only, no max here).
 * Coerce both into the same {value,max} shape. Verified: dnd5e v4 HitDice getters value()/max().
 */
function dnd5eHitDice(
  sys: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const attrs = sys.attributes;
  if (!attrs || typeof attrs !== "object") return undefined;
  const hd = (attrs as Record<string, unknown>).hd;
  if (typeof hd === "number") return { value: hd }; // v3: bare remaining count, no max
  const value = num(sys, "attributes", "hd", "value");
  const max = num(sys, "attributes", "hd", "max");
  if (value === undefined && max === undefined) return undefined;
  return defined({ value, max });
}

/** deathSaves {success,failure} — system.attributes.death.success/.failure (0..3). */
function dnd5eDeathSaves(
  sys: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const success = num(sys, "attributes", "death", "success");
  const failure = num(sys, "attributes", "death", "failure");
  if (success === undefined && failure === undefined) return undefined;
  return defined({ success, failure });
}

/**
 * concentration {active, spellName?, effectId?}. dnd5e applies the special status "concentrating"
 * as an ActiveEffect; we detect the (enabled) effect carrying that status and surface its id + the
 * spell name. The spell label is the ONE element that cannot fully degrade standalone (the app
 * falls back to its local concentration_spell field when Foundry is absent).
 */
function dnd5eConcentration(effects: EffectLike[]): Record<string, unknown> {
  const eff = effects.find(
    (e) => !e.disabled && statuses(e).includes("concentrating"),
  );
  if (!eff) return { active: false };
  return defined({
    active: true,
    spellName: eff.name ?? undefined,
    effectId: eff.id ?? undefined,
  });
}

function dnd5eDerived(
  sys: Record<string, unknown>,
  effects: EffectLike[],
): Record<string, unknown> {
  return defined({
    ac: num(sys, "attributes", "ac", "value"),
    proficiency: num(sys, "attributes", "prof"),
    spellcasting: defined({
      dc:
        num(sys, "attributes", "spelldc") ??
        num(sys, "attributes", "spell", "dc"),
      attack: num(sys, "attributes", "spell", "attack"),
    }),
    spellSlots: dnd5eSpellSlots(sys),
    hitDice: dnd5eHitDice(sys),
    deathSaves: dnd5eDeathSaves(sys),
    concentration: dnd5eConcentration(effects),
  });
}

/** A single Knight aspect's pool value (system.aspects.{x}.value). */
function knightAspectPool(
  sys: Record<string, unknown>,
  aspect: string,
): number | undefined {
  return num(sys, "aspects", aspect, "value");
}

/**
 * knightDerived: enrichment for the Knight player dashboard. All paths verified against the apps'
 * own Knight mapper (FoundrySystemMappers.swift / FoundryMapper.kt):
 *   - energyMax: gear-scoped on the equipped meta-armour (system.equipements.{wear}.energie.max),
 *     with a top-level system.energie.max fallback. `wear` is system.wear (e.g. "tenueCivile").
 *   - defense / reaction: system.defense.value / system.reaction.value.
 *   - aspectPools: {chair,bete,machine,dame,masque} each = system.aspects.{x}.value (Knight has
 *     exactly these five aspects — there is no `heaume` aspect).
 * Best-effort and fully defensive (optional chaining, every field dropped when missing) so a sparse
 * actor never throws; the app keeps its locally derived baseline when this is absent.
 */
function knightDerived(sys: Record<string, unknown>): Record<string, unknown> {
  const wear = typeof sys.wear === "string" ? (sys.wear as string) : undefined;
  const energyMax =
    (wear ? num(sys, "equipements", wear, "energie", "max") : undefined) ??
    num(sys, "energie", "max");
  const aspectPools = defined({
    chair: knightAspectPool(sys, "chair"),
    bete: knightAspectPool(sys, "bete"),
    machine: knightAspectPool(sys, "machine"),
    dame: knightAspectPool(sys, "dame"),
    masque: knightAspectPool(sys, "masque"),
  });
  return defined({
    energyMax,
    defense: num(sys, "defense", "value"),
    reaction: num(sys, "reaction", "value"),
    aspectPools: Object.keys(aspectPools).length ? aspectPools : undefined,
  });
}

function extractDerived(actor: ActorLike): Record<string, unknown> {
  const sys = actor.system ?? {};
  switch (systemId()) {
    case "dnd5e":
      return dnd5eDerived(sys, [...(actor.effects ?? [])]);
    case "knight":
      return knightDerived(sys);
    default:
      return {};
  }
}

/** Flatten an effect's `statuses` Set (iterable) to an array; empty when absent or non-iterable. */
function statuses(effect: EffectLike): string[] {
  const s = effect.statuses;
  if (!s || !(Symbol.iterator in (s as object))) return [];
  return [...(s as Iterable<string>)];
}

export const sheetDerived: Procedure = async (payload) => {
  const actorId = String(
    (payload as { actorId?: unknown } | null)?.actorId ?? "",
  ).trim();
  if (!actorId) throw new Error("sheet.derived requires 'actorId'");

  if (systemId() === "pf2e") {
    throw new RpcError(
      "unsupported_runtime",
      "sheet.derived is unavailable for PF2e until a narrow versioned projection is verified",
    );
  }

  const actor = actors<ActorLike>().get(actorId);
  if (!actor) throw new Error(`unknown actor ${actorId}`);
  // A read: require at least OBSERVER ownership for the Companion user.
  assertCompanionPermission(actor, "OBSERVER", actorId);

  const items = [...(actor.items ?? [])].map((item) => ({
    id: item.id ?? "",
    name: item.name ?? "",
    type: item.type ?? "",
    img: item.img ?? undefined,
    system: item.system ?? {},
  }));
  const effects = [...(actor.effects ?? [])].map((effect) => ({
    id: effect.id ?? "",
    name: effect.name ?? "",
    disabled: effect.disabled ?? false,
    statuses: statuses(effect),
  }));

  const response = {
    actorId: actor.id ?? actorId,
    name: actor.name ?? "",
    type: actor.type ?? "",
    img: actor.img ?? undefined,
    system: actor.system ?? {}, // prepared system data (derived values live here)
    items,
    effects,
    derived: extractDerived(actor),
  };
  // A fully-prepared actor (deep system block + items + effects) can exceed the envelope cap;
  // fail loudly with payload_too_large rather than have the peer silently drop the response.
  assertPayloadWithinCap(response);
  return response;
};
