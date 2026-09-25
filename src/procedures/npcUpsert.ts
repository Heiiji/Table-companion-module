import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  ASPECT_KEYS,
  OWNERSHIP_LIMITED,
  OWNERSHIP_NONE,
  SCHEMA_VERSION,
  actorCollection,
  actorID,
  alreadyApplied,
  assertKnightUpsertAuthority,
  bindingFor,
  bindingId,
  canonicalDigest,
  createActorDocument,
  foundryId,
  identifier,
  integer,
  invalid,
  ownershipReplacement,
  parseAspectScores,
  parseStoredResult,
  record,
  text,
  uniqueBoundActor,
  type ActorLike,
  type AspectScoresV1,
  type BindingV1,
  type Dict,
  type Outcome,
  type StoredResultV1,
} from "./upsertShared.js";

/**
 * Durable Knight NPC provisioning (`npc.upsert.v1`). The Foundry target is the
 * Knight `pnj` actor type — a different data model from the PC `knight` type:
 * NPC aspects are direct values plus aspects exceptionnels, there are no
 * caractéristiques, and defense/reaction/initiative are GM-authored bases.
 * Contract: docs/game-systems/knight/foundry-interop.md § "NPC provisioning",
 * fixtures test/fixtures/knight-pnj-3.58.33-foundry{13,14}.json (pnj data model
 * verified byte-identical 3.58.33 → 3.58.35, so this shares the PC lane's exact
 * runtime gate and widens with it).
 *
 * Unlike the PC lane there is no draft/approved state, no creation provenance,
 * no equipment, no foundryUserId and no unbound-actor adoption: lookup is
 * exclusively the shared `flags["table-companion"].binding`, and a missing
 * binding always creates. The app is the source of truth for its own NPCs, so a
 * hand-deleted bound Actor is deliberately recreated on the next send.
 */

const NPC_ACTOR_TYPE = "pnj";

/** Foundry CONST.TOKEN_DISPOSITIONS values (stable across Foundry 13/14). */
const DISPOSITION_SECRET = -2;
const DISPOSITION_NEUTRAL = 0;

type Visibility = "hidden" | "visible";

/** pnj aspect values are direct scores (not bases), in the shared 0-20 range. */
type NpcAspectsV1 = AspectScoresV1;

interface NpcPoolV1 {
  max: number;
  current: number;
}

interface NpcResourcesV1 {
  health?: NpcPoolV1;
  armour?: NpcPoolV1;
  energy?: NpcPoolV1;
  forceField?: number;
}

interface NpcDefensesV1 {
  defense?: number;
  reaction?: number;
  initiative?: number;
}

export interface KnightNpcUpsertV1 {
  schemaVersion: 1;
  actorType: "pnj";
  worldId: string;
  tableId: string;
  characterId: string;
  contentRevision: number;
  name: string;
  visibility: Visibility;
  aspects: NpcAspectsV1;
  resources?: NpcResourcesV1;
  defenses?: NpcDefensesV1;
}

export type NpcUpsertResultV1 = StoredResultV1;

function parsePool(value: unknown, path: string): NpcPoolV1 {
  const p = record(value, path, ["max", "current"]);
  return {
    max: integer(p.max, `${path}.max`, 0, 100_000),
    current: integer(p.current, `${path}.current`, 0, 100_000),
  };
}

function parseResources(value: unknown): NpcResourcesV1 {
  const p = record(value, "resources", [
    "health",
    "armour",
    "energy",
    "forceField",
  ]);
  return {
    health:
      p.health === undefined ? undefined : parsePool(p.health, "resources.health"),
    armour:
      p.armour === undefined ? undefined : parsePool(p.armour, "resources.armour"),
    energy:
      p.energy === undefined ? undefined : parsePool(p.energy, "resources.energy"),
    forceField:
      p.forceField === undefined
        ? undefined
        : integer(p.forceField, "resources.forceField", 0, 100_000),
  };
}

function parseDefenses(value: unknown): NpcDefensesV1 {
  const p = record(value, "defenses", ["defense", "reaction", "initiative"]);
  const field = (key: keyof NpcDefensesV1): number | undefined =>
    p[key] === undefined
      ? undefined
      : integer(p[key], `defenses.${key}`, 0, 100_000);
  return {
    defense: field("defense"),
    reaction: field("reaction"),
    initiative: field("initiative"),
  };
}

export function validateKnightNpcUpsertV1(payload: unknown): KnightNpcUpsertV1 {
  const keys = [
    "schemaVersion",
    "actorType",
    "worldId",
    "tableId",
    "characterId",
    "contentRevision",
    "name",
    "visibility",
    "aspects",
    "resources",
    "defenses",
  ] as const;
  const p = record(payload, "npcUpsert", keys);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.actorType !== NPC_ACTOR_TYPE) invalid("actorType must be pnj");
  if (p.visibility !== "hidden" && p.visibility !== "visible")
    invalid("visibility must be hidden or visible");
  if (p.aspects === undefined) invalid("aspects is required");
  return {
    schemaVersion: 1,
    actorType: "pnj",
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    characterId: identifier(p.characterId, "characterId", bindingId),
    // The app derives this from the sheet's GM-authoritative updatedAt in epoch
    // milliseconds, so the bound must admit the full safe-integer range.
    contentRevision: integer(
      p.contentRevision,
      "contentRevision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    name: text(p.name, "name", 200, true),
    visibility: p.visibility as Visibility,
    aspects: parseAspectScores(p.aspects),
    resources:
      p.resources === undefined ? undefined : parseResources(p.resources),
    defenses: p.defenses === undefined ? undefined : parseDefenses(p.defenses),
  };
}

/** Fail-closed visibility projection: only the exact "visible" value widens
 * anything; every other input keeps the Actor invisible to players. */
function ownershipDefault(visibility: Visibility): number {
  return visibility === "visible" ? OWNERSHIP_LIMITED : OWNERSHIP_NONE;
}

function tokenDisposition(visibility: Visibility): number {
  return visibility === "visible" ? DISPOSITION_NEUTRAL : DISPOSITION_SECRET;
}

// NPC actors never receive per-user grants (owner delegation in the app does
// not become Foundry OWNER): every apply replaces the whole map with the
// visibility default, which keeps a Masqué NPC unreadable however the app-side
// roster changes.
function npcOwnershipUpdate(actor: ActorLike, visibility: Visibility): Dict {
  return ownershipReplacement(actor, ownershipDefault(visibility));
}

function npcSyncOf(actor: ActorLike): NpcUpsertResultV1 | null {
  return parseStoredResult(actor, "npcUpsertV1")?.result ?? null;
}

function createNpcActor(
  req: KnightNpcUpsertV1,
  binding: BindingV1,
): Promise<ActorLike> {
  return createActorDocument({
    name: req.name,
    type: NPC_ACTOR_TYPE,
    flags: { [MODULE_ID]: { binding } },
    ownership: { default: ownershipDefault(req.visibility) },
    prototypeToken: { disposition: tokenDisposition(req.visibility) },
  });
}

/** The complete authored write allowlist. Every `system.` path below exists in
 * the pnj fixtures; aspects exceptionnels, bouclier, resilience, descriptions,
 * origin/type, option toggles, Items and img are deliberately absent so the
 * GM's hand-authored Foundry edits survive every re-send. */
function authoredNpcPatch(
  actor: ActorLike,
  req: KnightNpcUpsertV1,
  binding: BindingV1,
): Dict {
  const patch: Dict = {
    name: req.name,
    ownership: npcOwnershipUpdate(actor, req.visibility),
    "prototypeToken.disposition": tokenDisposition(req.visibility),
    [`flags.${MODULE_ID}.binding`]: binding,
  };
  for (const key of ASPECT_KEYS) {
    patch[`system.aspects.${key}.value`] = req.aspects[key];
  }
  const resources = req.resources;
  if (resources?.health) {
    patch["system.sante.base"] = resources.health.max;
    patch["system.sante.value"] = resources.health.current;
  }
  if (resources?.armour) {
    patch["system.armure.base"] = resources.armour.max;
    patch["system.armure.value"] = resources.armour.current;
  }
  if (resources?.energy) {
    patch["system.energie.base"] = resources.energy.max;
    patch["system.energie.value"] = resources.energy.current;
  }
  if (resources?.forceField !== undefined) {
    patch["system.champDeForce.base"] = resources.forceField;
  }
  const defenses = req.defenses;
  if (defenses?.defense !== undefined) {
    patch["system.defense.base"] = defenses.defense;
  }
  if (defenses?.reaction !== undefined) {
    patch["system.reaction.base"] = defenses.reaction;
  }
  if (defenses?.initiative !== undefined) {
    // The pnj fixed-initiative slot is the user bonus; diceBase stays authored
    // in Foundry (KNT-R-007's 3d6 default).
    patch["system.initiative.bonus.user"] = defenses.initiative;
  }
  return patch;
}

/**
 * Durable Knight NPC provisioning. Lookup is exclusively the shared Table
 * Companion binding (names are never a key); a missing binding creates a new
 * `pnj` Actor. Visibility maps fail-closed onto ownership + prototype token
 * disposition. Re-sends converge by revision/digest exactly like the PC lane.
 */
export const npcUpsertV1: Procedure = async (payload) => {
  const req = validateKnightNpcUpsertV1(payload);
  assertKnightUpsertAuthority("npc.upsert.v1");
  const digest = await canonicalDigest(req);
  const binding = bindingFor(req);
  let actor = uniqueBoundActor(actorCollection(), binding);
  let outcome: Outcome = "updated";
  if (actor && actor.type !== NPC_ACTOR_TYPE) {
    throw new RpcError(
      "binding_conflict",
      "the binding points at a non-pnj Actor",
    );
  }
  if (!actor) {
    actor = await createNpcActor(req, binding);
    outcome = "created";
  }
  const id = actorID(actor);
  if (!foundryId.test(id))
    throw new Error("Foundry returned an invalid Actor id");

  const previous = npcSyncOf(actor);
  if (previous && alreadyApplied(previous, req.contentRevision, digest, "content")) {
    return {
      schemaVersion: 1,
      resultDocId: id,
      outcome: previous.outcome,
      appliedRevision: previous.appliedRevision,
      appliedDigest: previous.appliedDigest,
      warnings: [...previous.warnings],
    } satisfies NpcUpsertResultV1;
  }

  await actor.update(authoredNpcPatch(actor, req, binding));
  const result: NpcUpsertResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome,
    appliedRevision: req.contentRevision,
    appliedDigest: digest,
    warnings: [],
  };
  await actor.update({ [`flags.${MODULE_ID}.npcUpsertV1`]: result });
  return result;
};
