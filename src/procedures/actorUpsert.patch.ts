import { MODULE_ID } from "../constants.js";
import {
  ASPECT_KEYS,
  FLAG_KEYS,
  contentsOf,
  normalizedOwnershipUpdate,
  type ActorLike,
  type BindingV1,
  type Dict,
} from "./upsertShared.js";
import {
  UPSERT_RESOURCE_KEYS,
  type CurrentResourcesV1,
  type ResourceKey,
  type KnightActorUpsertV1,
  type StoredCharacterCreationV1,
} from "./actorUpsert.types.js";

/**
 * What `actor.upsert.v1` writes onto the Knight Actor itself: the ownership
 * map, the binding and creation-provenance flags, the fixed allowlist of
 * authored source fields, and — after Foundry has prepared the Actor — the
 * current resource values.
 */

function storedCharacterCreation(
  req: KnightActorUpsertV1,
): StoredCharacterCreationV1 | undefined {
  if (!req.characterCreation) return undefined;
  return {
    ...req.characterCreation,
    approvedRevision: req.approvedRevision,
  };
}

export function authoredPatch(
  actor: ActorLike,
  req: KnightActorUpsertV1,
  binding: BindingV1,
): Dict {
  const patch: Dict = {
    name: req.name,
    ownership: normalizedOwnershipUpdate(actor, req.foundryUserId),
    [`flags.${MODULE_ID}.${FLAG_KEYS.binding}`]: binding,
  };
  const creation = storedCharacterCreation(req);
  if (creation)
    patch[`flags.${MODULE_ID}.${FLAG_KEYS.characterCreation}`] = creation;
  if (req.state !== "approved") return patch;
  const p = req.profile!;
  const aspects = req.aspects!;
  const chars = req.characteristics!;
  Object.assign(patch, {
    "system.description": p.description,
    "system.descriptionLimitee": p.limitedDescription,
    "system.histoire": p.history,
    "system.origin": p.origin,
    "system.age": p.age,
    "system.archetype": p.archetype,
    "system.metaarmure": p.metaArmour,
    "system.blason": p.coatOfArms,
    "system.surnom": p.nickname,
    "system.section": p.section,
    "system.hautFait": p.highFeat,
    "system.motivations.majeure": p.majorMotivation,
  });
  if (req.ai) {
    patch["system.equipements.ia.code"] = req.ai.code;
    patch["system.equipements.ia.surnom"] = req.ai.nickname;
    patch["system.equipements.ia.caractere"] = req.ai.personality;
  }
  for (const aspect of ASPECT_KEYS) {
    patch[`system.aspects.${aspect}.base`] = aspects[aspect];
  }
  for (const aspect of ASPECT_KEYS) {
    for (const [characteristic, value] of Object.entries(chars[aspect])) {
      patch[
        `system.aspects.${aspect}.caracteristiques.${characteristic}.base`
      ] = value;
    }
  }
  return patch;
}

export function hasPath(root: unknown, path: string): boolean {
  let current = root;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || !(key in current))
      return false;
    current = (current as Dict)[key];
  }
  return true;
}

/** The gear subtree Foundry reads the worn armour and energy from:
 * `system.equipements.<system.wear>`. As the Knight system prepares a PC, the
 * first embedded `armure` Item of generation 4 or later is always worn,
 * whatever `wear` stores, so writes go where Foundry reads. An absent or
 * malformed selector reads as the schema's initial `tenueCivile`. */
function wornGear(actor: ActorLike): string {
  const armour = contentsOf(actor.items).find((item) => item.type === "armure");
  const generation = Number((armour?.system as Dict | undefined)?.generation);
  if (generation >= 4) return "armure";
  const wear = (actor.system as Dict | undefined)?.wear;
  return typeof wear === "string" && /^[A-Za-z0-9_]{1,64}$/.test(wear)
    ? wear
    : "tenueCivile";
}

/** Stored current path and prepared-maximum path of each Knight resource (PC
 * model, 3.58.33 or later), relative to `system`. Armour and energy live on the
 * worn gear; their prepared maxima are the top-level `armure.max` /
 * `energie.max`. Contact has no max. Shared by `actor.upsert.v1` and
 * `actor.resources.v1`, which both clamp a current to the prepared max. */
export function resourcePaths(
  actor: ActorLike,
): Record<ResourceKey, [string, string?]> {
  const gear = `equipements.${wornGear(actor)}`;
  return {
    health: ["sante.value", "sante.max"],
    hope: ["espoir.value", "espoir.max"],
    armour: [`${gear}.armure.value`, "armure.max"],
    energy: [`${gear}.energie.value`, "energie.max"],
    heroism: ["heroisme.value", "heroisme.max"],
    contact: ["contacts.actuel"],
  };
}

/** The value at a dotted path, or undefined. */
export function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Dict)[key];
  }
  return current;
}

/** A current over the prepared maximum, when the Actor exposes a finite one,
 * lands on that maximum with a `resource_clamped:<key>` warning. */
export function clampToPrepared(
  actor: ActorLike,
  key: ResourceKey,
  value: number,
  maxPath: string | undefined,
  warnings: string[],
): number {
  const max = maxPath ? valueAt(actor.system, maxPath) : undefined;
  if (typeof max !== "number" || !Number.isFinite(max) || value <= max)
    return value;
  warnings.push(`resource_clamped:${key}`);
  return Math.max(0, Math.floor(max));
}

/** Current values after Foundry has prepared the Actor: each lands on its
 * stored field, clamped to the prepared maximum when the Actor exposes one. */
export async function applyCurrentResources(
  actor: ActorLike,
  resources: CurrentResourcesV1 | undefined,
): Promise<string[]> {
  if (!resources) return [];
  const paths = resourcePaths(actor);
  const patch: Dict = {};
  const warnings: string[] = [];
  for (const key of UPSERT_RESOURCE_KEYS) {
    let value = resources[key];
    if (value === undefined) continue;
    const [path, maxPath] = paths[key];
    if (!hasPath(actor.system, path)) {
      warnings.push(`resource_unavailable:${key}`);
      continue;
    }
    value = clampToPrepared(actor, key, value, maxPath, warnings);
    patch[`system.${path}`] = value;
  }
  if (Object.keys(patch).length > 0) await actor.update(patch);
  return warnings;
}
