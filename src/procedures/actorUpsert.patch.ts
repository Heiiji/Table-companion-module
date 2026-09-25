import { MODULE_ID } from "../constants.js";
import {
  ASPECT_KEYS,
  OWNERSHIP_NONE,
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

export function normalizedOwnership(foundryUserId: string | undefined): Dict {
  return foundryUserId
    ? { default: OWNERSHIP_NONE, [foundryUserId]: OWNERSHIP_OWNER }
    : { default: OWNERSHIP_NONE };
}

// Actor.create receives the plain normalized map; Actor.update receives the
// merge-safe replacement, which ends with exactly default:NONE plus, when
// supplied, one OWNER — whatever grants an adopted or bound Actor carried.
function normalizedOwnershipUpdate(
  actor: ActorLike,
  foundryUserId: string | undefined,
): Dict {
  return ownershipReplacement(actor, OWNERSHIP_NONE, foundryUserId);
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

function hasPath(root: unknown, path: string): boolean {
  let current = root;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || !(key in current))
      return false;
    current = (current as Dict)[key];
  }
  return true;
}

export async function applyCurrentResources(
  actor: ActorLike,
  resources: CurrentResourcesV1 | undefined,
): Promise<string[]> {
  if (!resources) return [];
  const specs: Array<[keyof CurrentResourcesV1, string]> = [
    ["health", "sante.value"],
    ["hope", "espoir.value"],
    ["armour", "equipements.armure.armure.value"],
    ["energy", "equipements.armure.energie.value"],
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
