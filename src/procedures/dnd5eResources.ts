import { MODULE_ID } from "../constants.js";
import { dnd5eRulesVersion } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { hasPath, valueAt } from "./actorUpsert.patch.js";
import {
  DND5E_RESOURCES_REQUIREMENT,
  FLAG_KEYS,
  SCHEMA_VERSION,
  actorCollection,
  alreadyApplied,
  assertGMResponder,
  bindingFor,
  bindingId,
  bindingOf,
  canonicalDigest,
  contentsOf,
  docId,
  identifier,
  integer,
  invalid,
  parseStoredResult,
  record,
  supportsDnd5eResourcesV1Runtime,
  uniqueBoundActor,
  type ActorLike,
  type Dict,
  type StoredResultV1,
} from "./upsertShared.js";

/**
 * Live counters of a Fifth Edition (dnd5e) player character
 * (`dnd5e.resources.v1`): hit points, temporary hit points, spell slots
 * remaining, exhaustion, the standard conditions, death saves and inspiration.
 * Like `actor.resources.v1`
 * it touches ONLY the Actor bound to the character or, for a character
 * imported from Foundry, the unbound Actor the app names by id; re-sends
 * converge by sequence/digest.
 *
 * Every dnd5e path and behaviour below is source-derived (dnd5e 6.1.0), not
 * confirmed against a live world. The writes run in the GM responder's client,
 * so dnd5e's own client-side follow-ups (the exhaustion effect, bloodied,
 * death-save reset, condition riders) run as they would for a GM edit.
 */

const PROCEDURE = "dnd5e.resources.v1";

/** dnd5e's player-character actor type (source-derived, dnd5e 6.1.0). */
const ACTOR_TYPE = "character";

/** The spell slot keys of `system.spells` (source-derived, dnd5e 6.1.0:
 * `spell1`…`spell9` and `pact`). */
export const DND5E_SLOT_KEYS = [
  "spell1",
  "spell2",
  "spell3",
  "spell4",
  "spell5",
  "spell6",
  "spell7",
  "spell8",
  "spell9",
  "pact",
] as const;
type SlotKey = (typeof DND5E_SLOT_KEYS)[number];

/** The standard condition ids this lane writes (source-derived, dnd5e 6.1.0
 * `CONFIG.DND5E.conditionTypes`, minus exhaustion — a level, written as a
 * number — and the pseudo conditions). Concentrating, bloodied, cover and the
 * other status effects are dnd5e's own and never touched. */
export const DND5E_CONDITION_IDS = [
  "blinded",
  "charmed",
  "deafened",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
] as const;
const KNOWN_CONDITIONS: ReadonlySet<string> = new Set(DND5E_CONDITION_IDS);

/** dnd5e's exhaustion levels (source-derived, dnd5e 6.1.0: `levels: 6`). */
const MAX_EXHAUSTION = 6;

/** Three successes or three failures end the death saves (dnd5e 6.1.0 rolls
 * them to 3; the schema itself has no max). */
const MAX_DEATH_SAVES = 3;

/** Bound of the temporary maximum hit points the lane accepts. dnd5e 6.1.0's
 * `hp.tempmax` is an integer with no min (a negative value lowers the max). */
const MAX_HP_TEMP_MAX = 9999;

export interface Dnd5eActorResourcesV1 {
  schemaVersion: 1;
  actorType: "character";
  worldId: string;
  tableId: string;
  characterId: string;
  expectedActorId: string;
  sequence: number;
  hp?: number;
  hpTemp?: number;
  /** Temporary maximum hit points (`hp.tempmax`), -9999..9999. */
  hpTempMax?: number;
  /** Slots REMAINING per key; all ten keys when present. */
  slots?: Record<SlotKey, number>;
  exhaustion?: number;
  /** The FULL set of standard conditions the sheet holds; absent leaves
   * Foundry's conditions alone, empty clears them. */
  conditions?: string[];
  /** Death save successes and failures, both 0..3. */
  deathSaves?: { success: number; failure: number };
  inspiration?: boolean;
}

/** The lane's result: the common stored fields plus the prepared maximum hit
 * points read after the write, when the Actor exposes a finite one. */
export interface Dnd5eResourcesResultV1 extends StoredResultV1 {
  hpEffectiveMax?: number;
}

/** Foundry's randomID(16) shape. */
const actorDocumentId = /^[A-Za-z0-9]{16}$/;

const count = (value: unknown, path: string): number =>
  integer(value, path, 0, Number.MAX_SAFE_INTEGER);

export function validateDnd5eActorResourcesV1(
  payload: unknown,
): Dnd5eActorResourcesV1 {
  const p = record(payload, "dnd5eResources", [
    "schemaVersion",
    "actorType",
    "worldId",
    "tableId",
    "characterId",
    "expectedActorId",
    "sequence",
    "hp",
    "hpTemp",
    "hpTempMax",
    "slots",
    "exhaustion",
    "conditions",
    "deathSaves",
    "inspiration",
  ]);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.actorType !== ACTOR_TYPE) invalid("actorType must be character");
  const req: Dnd5eActorResourcesV1 = {
    schemaVersion: 1,
    actorType: ACTOR_TYPE,
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    characterId: identifier(p.characterId, "characterId", bindingId),
    expectedActorId: identifier(
      p.expectedActorId,
      "expectedActorId",
      actorDocumentId,
    ),
    sequence: integer(p.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
  };
  if (p.hp !== undefined) req.hp = count(p.hp, "hp");
  if (p.hpTemp !== undefined) req.hpTemp = count(p.hpTemp, "hpTemp");
  if (p.hpTempMax !== undefined)
    req.hpTempMax = integer(
      p.hpTempMax,
      "hpTempMax",
      -MAX_HP_TEMP_MAX,
      MAX_HP_TEMP_MAX,
    );
  if (p.slots !== undefined) {
    const s = record(p.slots, "slots", DND5E_SLOT_KEYS);
    const slots = {} as Record<SlotKey, number>;
    for (const key of DND5E_SLOT_KEYS)
      slots[key] = count(s[key], `slots.${key}`);
    req.slots = slots;
  }
  if (p.exhaustion !== undefined)
    req.exhaustion = integer(p.exhaustion, "exhaustion", 0, MAX_EXHAUSTION);
  if (p.conditions !== undefined) {
    if (!Array.isArray(p.conditions)) invalid("conditions must be an array");
    const seen = new Set<string>();
    for (const id of p.conditions as unknown[]) {
      if (typeof id !== "string" || !KNOWN_CONDITIONS.has(id))
        invalid("conditions holds an unknown condition id");
      if (seen.has(id)) invalid("conditions holds a duplicate id");
      seen.add(id);
    }
    req.conditions = [...seen];
  }
  if (p.deathSaves !== undefined) {
    const d = record(p.deathSaves, "deathSaves", ["success", "failure"]);
    req.deathSaves = {
      success: integer(d.success, "deathSaves.success", 0, MAX_DEATH_SAVES),
      failure: integer(d.failure, "deathSaves.failure", 0, MAX_DEATH_SAVES),
    };
  }
  if (p.inspiration !== undefined) {
    if (typeof p.inspiration !== "boolean")
      invalid("inspiration must be a boolean");
    req.inspiration = p.inspiration;
  }
  if (
    req.hp === undefined &&
    req.hpTemp === undefined &&
    req.hpTempMax === undefined &&
    req.slots === undefined &&
    req.exhaustion === undefined &&
    req.conditions === undefined &&
    req.deathSaves === undefined &&
    req.inspiration === undefined
  )
    invalid("dnd5eResources needs at least one value");
  return req;
}

/** The standard conditions the Actor holds: the PRIMARY id (`system.type`) of
 * each `condition`-type effect (source-derived, dnd5e 6.1.0). Never
 * `actor.statuses`: it also carries implied ids (a stunned effect implies
 * incapacitated), and comparing on it would delete the stunned effect when
 * the app's set lacks « incapacitated ». */
function currentConditions(actor: ActorLike): Set<string> {
  const held = new Set<string>();
  for (const effect of contentsOf(actor.effects)) {
    if (effect.type !== "condition") continue;
    const id = valueAt(effect.system, "type");
    if (typeof id === "string" && KNOWN_CONDITIONS.has(id)) held.add(id);
  }
  return held;
}

function finiteAt(root: unknown, path: string): number | undefined {
  const v = valueAt(root, path);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** source-derived (dnd5e 6.1.0, data/actor/templates/attributes.mjs L473):
 * the PREPARED `attributes.hp.effectiveMax` (`max + tempmax`, floored at 0) —
 * the stored `hp.max` is only an override, null unless the GM typed one. */
function effectiveMaxOf(actor: ActorLike): { hpEffectiveMax?: number } {
  const max = finiteAt(actor.system, "attributes.hp.effectiveMax");
  return max === undefined
    ? {}
    : { hpEffectiveMax: Math.max(0, Math.floor(max)) };
}

/** The `hpEffectiveMax` a stored flag recorded, when well-formed. */
function storedEffectiveMax(flag: Dict): { hpEffectiveMax?: number } {
  const max = flag.hpEffectiveMax;
  return Number.isSafeInteger(max) && (max as number) >= 0
    ? { hpEffectiveMax: max as number }
    : {};
}

/** The `actor.update` keys whose value differs from the prepared Actor. */
function counterPatch(
  actor: ActorLike,
  req: Dnd5eActorResourcesV1,
  warnings: string[],
): Dict {
  const patch: Dict = {};
  const set = (path: string, value: number | boolean) => {
    if (valueAt(actor.system, path) !== value) patch[`system.${path}`] = value;
  };
  // source-derived (dnd5e 6.1.0): `attributes.hp.tempmax`, written in the same
  // update; the hit point ceiling below is the effective maximum after it
  // (`max + tempmax`, floored at 0, templates/attributes.mjs L473), computed
  // from the prepared `hp.max` rather than read back.
  let effectiveMax = finiteAt(actor.system, "attributes.hp.effectiveMax");
  if (req.hpTempMax !== undefined) {
    if (!hasPath(actor.system, "attributes.hp")) {
      warnings.push("resource_unavailable:hpTempMax");
    } else {
      set("attributes.hp.tempmax", req.hpTempMax);
      const max = finiteAt(actor.system, "attributes.hp.max");
      effectiveMax =
        max === undefined ? undefined : Math.max(max + req.hpTempMax, 0);
    }
  }
  // source-derived (dnd5e 6.1.0): `attributes.hp.value` has min 0 and no
  // schema max; the prepared `hp.effectiveMax` is the ceiling dnd5e displays.
  if (req.hp !== undefined) {
    if (!hasPath(actor.system, "attributes.hp")) {
      warnings.push("resource_unavailable:hp");
    } else {
      let hp = req.hp;
      const max = effectiveMax;
      if (max !== undefined && hp > max) {
        hp = Math.max(0, Math.floor(max));
        warnings.push("resource_clamped:hp");
      }
      set("attributes.hp.value", hp);
    }
  }
  // source-derived (dnd5e 6.1.0): `attributes.hp.temp`, written as an absolute
  // value (dnd5e's applyTempHP only ever raises it).
  if (req.hpTemp !== undefined) {
    if (!hasPath(actor.system, "attributes.hp"))
      warnings.push("resource_unavailable:hpTemp");
    else set("attributes.hp.temp", req.hpTemp);
  }
  // source-derived (dnd5e 6.1.0): `spells.<key>.value` is the slots REMAINING;
  // `max` is prepared, never stored. A key without a prepared max above 0 is
  // a slot level the character does not have: skipped.
  if (req.slots) {
    for (const key of DND5E_SLOT_KEYS) {
      const max = finiteAt(actor.system, `spells.${key}.max`);
      if (max === undefined || max <= 0) continue;
      let value = req.slots[key];
      if (value > max) {
        value = Math.floor(max);
        warnings.push(`resource_clamped:${key}`);
      }
      set(`spells.${key}.value`, value);
    }
  }
  // source-derived (dnd5e 6.1.0): exhaustion is the number
  // `attributes.exhaustion`; dnd5e's own update hook moves the exhaustion
  // effect. Never toggled as a status: dnd5e ignores `active` for a levelled
  // condition and ADDS a level. The app counts the 2024 levels; a world on the
  // 2014 rules (`rulesVersion` "legacy") keeps its own: left to Foundry.
  if (req.exhaustion !== undefined) {
    if (dnd5eRulesVersion() === "legacy")
      warnings.push("exhaustion_unavailable:legacy_rules");
    else set("attributes.exhaustion", req.exhaustion);
  }
  // source-derived (dnd5e 6.1.0, data/actor/character.mjs L73-83): stored
  // `attributes.death.success` / `.failure` (integers, min 0) and the boolean
  // `attributes.inspiration`. dnd5e's preUpdateHP (templates/attributes.mjs
  // L664-669) still zeroes both death counters when the same update heals a
  // character up from 0 hit points.
  if (req.deathSaves) {
    if (!hasPath(actor.system, "attributes.death")) {
      warnings.push("resource_unavailable:deathSaves");
    } else {
      set("attributes.death.success", req.deathSaves.success);
      set("attributes.death.failure", req.deathSaves.failure);
    }
  }
  if (req.inspiration !== undefined) {
    if (!hasPath(actor.system, "attributes"))
      warnings.push("resource_unavailable:inspiration");
    else set("attributes.inspiration", req.inspiration);
  }
  return patch;
}

export const dnd5eResourcesV1: Procedure = async (payload) => {
  const req = validateDnd5eActorResourcesV1(payload);
  assertGMResponder(PROCEDURE);
  if (!supportsDnd5eResourcesV1Runtime())
    throw new RpcError(
      "unsupported_runtime",
      `${PROCEDURE} requires ${DND5E_RESOURCES_REQUIREMENT}`,
    );
  const digest = await canonicalDigest(req);
  const collection = actorCollection();
  let actor = uniqueBoundActor(collection, bindingFor(req));
  if (!actor) {
    // An imported character carries no binding: only the unbound Actor the
    // app names qualifies.
    actor = collection.get(req.expectedActorId);
    if (!actor)
      throw new RpcError("deleted_link", "the linked Actor no longer exists");
    if (bindingOf(actor))
      throw new RpcError(
        "binding_conflict",
        "the Actor is bound to another character",
      );
  }
  const id = docId(actor);
  if (actor.type !== ACTOR_TYPE || id !== req.expectedActorId)
    throw new RpcError(
      "binding_conflict",
      "the binding points at a different Actor",
    );

  const stored = parseStoredResult(actor, FLAG_KEYS.dnd5eResources);
  const previous = stored?.result ?? null;
  if (previous && alreadyApplied(previous, req.sequence, digest, "sequence"))
    return {
      ...previous,
      warnings: [...previous.warnings],
      ...storedEffectiveMax(stored!.flag),
    } satisfies Dnd5eResourcesResultV1;

  const warnings: string[] = [];
  const patch = counterPatch(actor, req, warnings);
  const toggles: Array<[string, boolean]> = [];
  if (req.conditions) {
    const wanted = new Set(req.conditions);
    const held = currentConditions(actor);
    for (const cid of DND5E_CONDITION_IDS)
      if (wanted.has(cid) !== held.has(cid))
        toggles.push([cid, wanted.has(cid)]);
  }
  if (toggles.length > 0 && typeof actor.toggleStatusEffect !== "function")
    throw new RpcError(
      "unsupported_runtime",
      "Actor#toggleStatusEffect is unavailable",
    );

  const result: StoredResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome: "updated",
    appliedRevision: req.sequence,
    appliedDigest: digest,
    warnings,
  };
  // Loop breaker, as actor.resources.v1: a new sequence re-sending what the
  // flag already records, with nothing to change, writes nothing.
  const contentDigest = await canonicalDigest({ ...req, sequence: 0 });
  if (
    Object.keys(patch).length === 0 &&
    toggles.length === 0 &&
    stored?.flag.contentDigest === contentDigest
  )
    return { ...result, ...effectiveMaxOf(actor) };

  // Conditions first, then ONE update carrying the counters, then the result
  // flag with the prepared maximum read after that update: a failure part-way
  // leaves the sequence unrecorded, so the retry recomputes and finishes (an
  // explicit `active` toggle is idempotent, a written counter no longer
  // differs).
  for (const [cid, active] of toggles)
    await actor.toggleStatusEffect!(cid, { active });
  if (Object.keys(patch).length > 0) await actor.update(patch);
  const final: Dnd5eResourcesResultV1 = { ...result, ...effectiveMaxOf(actor) };
  await actor.update({
    [`flags.${MODULE_ID}.${FLAG_KEYS.dnd5eResources}`]: {
      ...final,
      contentDigest,
    },
  });
  return final;
};
