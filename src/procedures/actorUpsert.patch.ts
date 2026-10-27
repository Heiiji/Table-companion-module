import { MODULE_ID } from "../constants.js";
import { pairedAgentUserId } from "../setup/identity.js";
import {
  ASPECT_KEYS,
  OWNERSHIP_NONE,
  OWNERSHIP_OBSERVER,
  OWNERSHIP_OWNER,
  ownershipReplacement,
  type ActorLike,
  type BindingV1,
  type Dict,
} from "./upsertShared.js";
import type {
  CurrentResourcesV1,
  KnightActorUpsertV1,
  StoredCharacterCreationV1,
} from "./actorUpsert.types.js";

/**
 * What `actor.upsert.v1` writes onto the Knight Actor itself: the ownership
 * map, the binding and creation-provenance flags, the fixed allowlist of
 * authored source fields, and — after Foundry has prepared the Actor — the
 * current resource values.
 */

/** The paired Companion user, which the backend reads the world as, unless it
 * is the character's own player (who keeps OWNER). "" before pairing. */
function companionUserId(foundryUserId: string | undefined): string {
  const id = pairedAgentUserId();
  return id && id !== foundryUserId ? id : "";
}

export function normalizedOwnership(foundryUserId: string | undefined): Dict {
  const ownership: Dict = { default: OWNERSHIP_NONE };
  if (foundryUserId) ownership[foundryUserId] = OWNERSHIP_OWNER;
  const companion = companionUserId(foundryUserId);
  if (companion) ownership[companion] = OWNERSHIP_OBSERVER;
  return ownership;
}

// Actor.create receives the plain normalized map; Actor.update receives the
// merge-safe replacement, which ends with exactly default:NONE, one OWNER when
// supplied, and the Companion user at its existing level but at least OBSERVER
// — whatever other grants an adopted or bound Actor carried. The Companion
// grant is never deleted or lowered, so setup's « Share » survives a revision.
function normalizedOwnershipUpdate(
  actor: ActorLike,
  foundryUserId: string | undefined,
): Dict {
  const update = ownershipReplacement(actor, OWNERSHIP_NONE, foundryUserId);
  const companion = companionUserId(foundryUserId);
  if (companion) {
    delete update[`-=${companion}`];
    const current = Number(actor.ownership?.[companion]);
    update[companion] = Math.max(
      OWNERSHIP_OBSERVER,
      Number.isFinite(current) ? current : OWNERSHIP_NONE,
    );
  }
  return update;
}

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
    [`flags.${MODULE_ID}.binding`]: binding,
  };
  const creation = storedCharacterCreation(req);
  if (creation) patch[`flags.${MODULE_ID}.characterCreationV1`] = creation;
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
  const characteristicGroups: Record<string, Record<string, number>> = {
    chair: chars.chair,
    bete: chars.bete,
    machine: chars.machine,
    dame: chars.dame,
    masque: chars.masque,
  };
  for (const [aspect, group] of Object.entries(characteristicGroups)) {
    for (const [characteristic, value] of Object.entries(group)) {
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

/** The gear subtree the Actor currently wears: Knight keeps the equipped
 * armour's (or Guardian's, or civilian outfit's) armour and energy under
 * `system.equipements.<system.wear>`. An absent or malformed selector reads as
 * the default `armure`, so the path checks below still decide. */
export function wornGear(actor: ActorLike): string {
  const wear = (actor.system as Dict | undefined)?.wear;
  return typeof wear === "string" && /^[A-Za-z0-9_]{1,64}$/.test(wear)
    ? wear
    : "armure";
}

export async function applyCurrentResources(
  actor: ActorLike,
  resources: CurrentResourcesV1 | undefined,
): Promise<string[]> {
  if (!resources) return [];
  const gear = `equipements.${wornGear(actor)}`;
  const specs: Array<[keyof CurrentResourcesV1, string]> = [
    ["health", "sante.value"],
    ["hope", "espoir.value"],
    ["armour", `${gear}.armure.value`],
    ["energy", `${gear}.energie.value`],
    ["contact", "contacts.actuel"],
  ];
  const patch: Dict = {};
  const warnings: string[] = [];
  for (const [key, path] of specs) {
    const value = resources[key];
    if (value === undefined) continue;
    if (!hasPath(actor.system, path)) {
      warnings.push(`resource_unavailable:${key}`);
      continue;
    }
    patch[`system.${path}`] = value;
  }
  if (Object.keys(patch).length > 0) await actor.update(patch);
  return warnings;
}
