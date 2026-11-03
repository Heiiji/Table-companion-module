import { MODULE_ID } from "../constants.js";
import {
  actorImplementation,
  deletionEntry,
  foundryGame,
  foundryGeneration,
  gameActors,
  systemId,
  systemVersion,
  type ActorLike,
  type ActorsLike,
  type Dict,
} from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import { pairedAgentUserId } from "../setup/identity.js";
import { canonicalize } from "../util/canonicalJson.js";

/**
 * Shared plumbing for the durable actor-provisioning procedures
 * (`actor.upsert.v1` for the Knight PC type, `npc.upsert.v1` for the Knight
 * pnj type). Everything here is deliberately actor-type-agnostic: the strict
 * validation primitives, the Foundry collection accessors, the GM + exact
 * runtime gate, the create/lookup/convergence steps both lanes run in the same
 * order, and the `flags["table-companion"].binding` identity that both lanes
 * share so one characterId can never bind two Actors. Type-specific mapping
 * stays in each procedure's own file.
 */

export type {
  ActorItemLike,
  ActorLike,
  ActorsLike,
  Dict,
} from "../foundry/runtime.js";

/** The request/result/flag schema version both provisioning lanes speak. */
export const SCHEMA_VERSION = 1;

/** How an upsert reached its Actor: made it, took over an explicitly assigned
 * unbound one, or found the one already bound to this character. */
export type Outcome = "created" | "adopted" | "updated";

const OUTCOMES: readonly string[] = ["created", "adopted", "updated"];

export interface BindingV1 {
  schemaVersion: 1;
  worldId: string;
  tableId: string;
  characterId: string;
}

/** Foundry document ownership levels used by the provisioning lanes. */
export const OWNERSHIP_NONE = 0;
export const OWNERSHIP_LIMITED = 1;
export const OWNERSHIP_OBSERVER = 2;
export const OWNERSHIP_OWNER = 3;

const utf8 = new TextEncoder();

export function invalid(message: string): never {
  throw new RpcError("invalid_args", message);
}

export function record(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Dict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object`);
  }
  const out = value as Dict;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(out)) {
    if (!allowedSet.has(key)) invalid(`${path}.${key} is not allowed`);
  }
  return out;
}

export function text(
  value: unknown,
  path: string,
  max: number,
  required = false,
): string {
  if (typeof value !== "string") return invalid(`${path} must be a string`);
  if (
    value.includes("\0") ||
    [...value].length > max ||
    (required && value.trim() === "")
  ) {
    return invalid(`${path} is empty, too long, or contains NUL`);
  }
  return value;
}

export function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    return invalid(`${path} must be an integer in ${min}-${max}`);
  }
  return value as number;
}

export function identifier(
  value: unknown,
  path: string,
  pattern: RegExp,
): string {
  const id = text(value, path, 128, true);
  if (!pattern.test(id))
    return invalid(`${path} has an invalid identifier shape`);
  return id;
}

export const bindingId = /^[A-Za-z0-9._-]{1,128}$/;
export const foundryId = /^[A-Za-z0-9_-]{1,64}$/;

/** The five Knight aspects, in the order both actor types store them. */
export const ASPECT_KEYS = [
  "chair",
  "bete",
  "machine",
  "dame",
  "masque",
] as const;
type AspectKey = (typeof ASPECT_KEYS)[number];
export type AspectScoresV1 = Record<AspectKey, number>;

/** Parse the exact five-aspect object. Both the PC base scores and the pnj
 * direct values are whole numbers in 0-20 (the upstream schema default max). */
export function parseAspectScores(value: unknown): AspectScoresV1 {
  const p = record(value, "aspects", ASPECT_KEYS);
  const aspect = (key: AspectKey): number =>
    integer(p[key], `aspects.${key}`, 0, 20);
  return {
    chair: aspect("chair"),
    bete: aspect("bete"),
    machine: aspect("machine"),
    dame: aspect("dame"),
    masque: aspect("masque"),
  };
}

/** Oldest Foundry core generation the Knight actor mapping runs on. There is
 * no upper bound: a newer Foundry generation is accepted, and a release that
 * proves breaking is handled when it happens. */
export const MINIMUM_KNIGHT_UPSERT_FOUNDRY_GENERATION = 13;

/** Oldest Knight system version the actor mappings run on: 3.58.33, which the
 * PC and pnj fixtures were captured on. A floor, not a list: the later releases
 * inspected so far change only the system's data preparation code, outside the
 * source paths these mappings write and read, so a newer Knight release is
 * accepted, and one that proves breaking is handled when it happens. */
export const MINIMUM_KNIGHT_UPSERT_SYSTEM_VERSION = "3.58.33";

/** The admitted versions as the « requires Knight … » messages name them. */
export const KNIGHT_UPSERT_SYSTEM_VERSION_LABEL = `${MINIMUM_KNIGHT_UPSERT_SYSTEM_VERSION} or later`;

const STRICT_VERSION = /^\d+\.\d+\.\d+$/;

/** True only for a plain `major.minor.patch` string at or above the floor
 * ("v3.58.33", "3.58.33-beta", "3.58.32" and non-strings are all refused). */
export function isAdmittedKnightSystemVersion(
  version: unknown,
): version is string {
  return isAtLeastVersion(version, MINIMUM_KNIGHT_UPSERT_SYSTEM_VERSION);
}

/** True only for a plain `major.minor.patch` string at or above `floor`,
 * compared numerically (no prefix, no pre-release suffix). */
export function isAtLeastVersion(
  version: unknown,
  floor: string,
): version is string {
  if (typeof version !== "string" || !STRICT_VERSION.test(version))
    return false;
  const have = version.split(".").map(Number);
  const min = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== min[i]) return have[i] > min[i];
  return true;
}

/** Runtime gate for the Knight actor mappings admitted by this release: a
 * Knight system version at or above the floor, on Foundry 13 or any later
 * generation. It
 * decides whether the two provisioning procedures are registered at all, and
 * each procedure repeats it before touching the world. All three lanes read the
 * same floor, so moving it moves the PC and pnj lanes together. */
export function supportsKnightActorUpsertV1Runtime(): boolean {
  return (
    systemId() === "knight" &&
    isAdmittedKnightSystemVersion(systemVersion()) &&
    foundryGeneration() >= MINIMUM_KNIGHT_UPSERT_FOUNDRY_GENERATION
  );
}

/** Oldest dnd5e system release the Fifth Edition live-resources lane writes
 * to: 6.1.0, the release whose source the write paths were derived from. A
 * floor, not a list; a later release that proves breaking is handled when it
 * happens. */
export const MINIMUM_DND5E_RESOURCES_SYSTEM_VERSION = "6.1.0";

/** dnd5e 6.x itself requires Foundry 14. */
export const MINIMUM_DND5E_RESOURCES_FOUNDRY_GENERATION = 14;

/** The « requires … » wording of the Fifth Edition lane's refusals. */
export const DND5E_RESOURCES_REQUIREMENT = `dnd5e ${MINIMUM_DND5E_RESOURCES_SYSTEM_VERSION} or later on Foundry ${MINIMUM_DND5E_RESOURCES_FOUNDRY_GENERATION} or later`;

/** Runtime gate for `dnd5e.resources.v1`: the dnd5e system at or above the
 * floor, on Foundry 14 or later. It decides registration, and the handler
 * repeats it before touching the world. */
export function supportsDnd5eResourcesV1Runtime(): boolean {
  return (
    systemId() === "dnd5e" &&
    isAtLeastVersion(systemVersion(), MINIMUM_DND5E_RESOURCES_SYSTEM_VERSION) &&
    foundryGeneration() >= MINIMUM_DND5E_RESOURCES_FOUNDRY_GENERATION
  );
}

/** Oldest pf2e system release the Pathfinder 2e character-draft lane writes
 * to: 8.6.1, the release whose source the create path was derived from
 * (source-derived (pf2e 8.6.1), never confirmed against a live world). A floor,
 * not a list; a later release that proves breaking is handled when it
 * happens. */
export const MINIMUM_PF2E_SYSTEM_VERSION = "8.6.1";

/** pf2e 8.x itself runs on Foundry 14 only. */
export const MINIMUM_PF2E_FOUNDRY_GENERATION = 14;

/** The « requires … » wording of the Pathfinder 2e lane's refusals. */
export const PF2E_REQUIREMENT = `pf2e ${MINIMUM_PF2E_SYSTEM_VERSION} or later on Foundry ${MINIMUM_PF2E_FOUNDRY_GENERATION}`;

/** Runtime gate for `pf2e.actor.upsert.v1`: the pf2e system (not a sibling
 * built from the same tree, such as sf2e) at or above the floor, on Foundry 14
 * or later. It decides registration, and the handler repeats it before
 * touching the world. */
export function supportsPf2eActorUpsertV1Runtime(): boolean {
  return (
    systemId() === "pf2e" &&
    isAtLeastVersion(systemVersion(), MINIMUM_PF2E_SYSTEM_VERSION) &&
    foundryGeneration() >= MINIMUM_PF2E_FOUNDRY_GENERATION
  );
}

/** Runtime gate for `pf2e.resources.v1`: the same pf2e floor as the draft
 * lane, kept as its own gate so the live-counters lane can move alone. The
 * handler repeats it and then probes, at call time, the pf2e APIs it writes
 * through (they fail closed when absent). */
export function supportsPf2eResourcesV1Runtime(): boolean {
  return supportsPf2eActorUpsertV1Runtime();
}

/** Every world-writing procedure runs only in a GM responder's browser. */
export function assertGMResponder(procedure: string): void {
  if (!foundryGame()?.user?.isGM)
    throw new RpcError(
      "permission_denied",
      `${procedure} requires a GM responder`,
    );
}

/**
 * The gate both Knight lanes repeat before touching the world: the responder
 * must be a GM, and the runtime must be a Knight/Foundry pair the mapping was
 * verified against (the same check that decides registration).
 * `procedure` names the lane in the error message.
 */
export function assertKnightUpsertAuthority(procedure: string): void {
  assertGMResponder(procedure);
  if (!supportsKnightActorUpsertV1Runtime()) {
    throw new RpcError(
      "unsupported_runtime",
      `${procedure} requires Knight ${KNIGHT_UPSERT_SYSTEM_VERSION_LABEL} on Foundry ${MINIMUM_KNIGHT_UPSERT_FOUNDRY_GENERATION} or later`,
    );
  }
}
export function actorCollection(): ActorsLike {
  const actors = gameActors();
  if (!actors)
    throw new RpcError(
      "unsupported_runtime",
      "Foundry game.actors is unavailable",
    );
  return actors;
}

/** The documents of a Foundry collection, whichever shape the runtime exposes
 * (`contents`, an iterable, or both, depending on the generation). */
export function contentsOf<T>(
  collection: { contents?: T[] } | Iterable<T> | null | undefined,
): T[] {
  if (!collection) return [];
  if ("contents" in collection && Array.isArray(collection.contents))
    return collection.contents;
  if (Symbol.iterator in collection) return [...(collection as Iterable<T>)];
  return [];
}

/** A Foundry document's id, or "" when it has none. */
export function docId(
  doc: { id?: string; _id?: string } | null | undefined,
): string {
  return doc?.id ?? doc?._id ?? "";
}

/** The keys this module stores under `flags["table-companion"]`. */
export const FLAG_KEYS = {
  binding: "binding",
  actorUpsert: "actorUpsertV1",
  actorResources: "actorResourcesV1",
  dnd5eResources: "dnd5eResourcesV1",
  pf2eUpsert: "pf2eUpsertV1",
  pf2eCreated: "pf2eUpsertCreatedV1",
  pf2eComplete: "pf2eCompleteV1",
  pf2eResources: "pf2eResourcesV1",
  npcUpsert: "npcUpsertV1",
  characterCreation: "characterCreationV1",
  minorMotivation: "actorUpsertMinorMotivationV1",
  equipmentCatalogId: "equipmentCatalogId",
  equipmentCatalogVariant: "equipmentCatalogVariantV1",
  equipmentCatalogSource: "equipmentCatalogSourceV1",
  combatSync: "combatSync",
  combatantKey: "key",
} as const;

type FlagDoc = {
  getFlag?(namespace: string, key: string): unknown;
  flags?: Dict;
};

export function flagValue(doc: FlagDoc, key: string): unknown {
  if (typeof doc.getFlag === "function") return doc.getFlag(MODULE_ID, key);
  const namespace = doc.flags?.[MODULE_ID];
  return typeof namespace === "object" && namespace !== null
    ? (namespace as Dict)[key]
    : undefined;
}

/** A schema-1 object flag that `isValid` accepts, or null: a missing or
 * malformed record reads as absent. */
export function flagRecord(
  doc: FlagDoc,
  key: string,
  isValid: (p: Dict) => boolean,
): Dict | null {
  const value = flagValue(doc, key);
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  return p.schemaVersion === 1 && isValid(p) ? p : null;
}

export function bindingOf(actor: ActorLike): BindingV1 | null {
  const p = flagRecord(
    actor,
    FLAG_KEYS.binding,
    (p) =>
      typeof p.worldId === "string" &&
      typeof p.tableId === "string" &&
      typeof p.characterId === "string",
  );
  if (!p) return null;
  return {
    schemaVersion: 1,
    worldId: p.worldId as string,
    tableId: p.tableId as string,
    characterId: p.characterId as string,
  };
}

function exactBinding(binding: BindingV1 | null, expected: BindingV1): boolean {
  return (
    binding?.schemaVersion === 1 &&
    binding.worldId === expected.worldId &&
    binding.tableId === expected.tableId &&
    binding.characterId === expected.characterId
  );
}

/** The binding a request asks for: its world, table and character ids. */
export function bindingFor(req: {
  worldId: string;
  tableId: string;
  characterId: string;
}): BindingV1 {
  return {
    schemaVersion: 1,
    worldId: req.worldId,
    tableId: req.tableId,
    characterId: req.characterId,
  };
}

/** The one Actor carrying exactly this binding, or undefined when none does.
 * Two carriers means the world was hand-edited into an ambiguous state, so the
 * upsert refuses rather than guess which one is the character. */
export function uniqueBoundActor(
  collection: ActorsLike,
  binding: BindingV1,
): ActorLike | undefined {
  const matches = contentsOf(collection).filter((actor) =>
    exactBinding(bindingOf(actor), binding),
  );
  if (matches.length > 1)
    throw new RpcError(
      "binding_collision",
      "multiple Actors carry this Table Companion binding",
    );
  return matches[0];
}

/** The result fields both lanes store on the Actor after an apply. */
export interface StoredResultV1 {
  schemaVersion: 1;
  resultDocId: string;
  outcome: Outcome;
  appliedRevision: number;
  appliedDigest: string;
  warnings: string[];
}

/** The fields every stored result flag carries, with its outcome among
 * `outcomes` (shared by the provisioning lanes and the combat mirror). */
export function storedResultShape(
  p: Dict,
  outcomes: readonly string[],
): boolean {
  return (
    Number.isSafeInteger(p.appliedRevision) &&
    typeof p.appliedDigest === "string" &&
    outcomes.includes(String(p.outcome)) &&
    Array.isArray(p.warnings) &&
    p.warnings.every((w) => typeof w === "string")
  );
}

/**
 * Read the result a previous apply stored under `flags["table-companion"][flagKey]`.
 * Returns the common fields plus the raw flag (so a lane can check and read its
 * own extra fields), or null when the flag is absent or malformed — a malformed
 * record is treated as never applied.
 */
export function parseStoredResult(
  actor: ActorLike,
  flagKey: string,
): { result: StoredResultV1; flag: Dict } | null {
  const p = flagRecord(actor, flagKey, (p) => storedResultShape(p, OUTCOMES));
  if (!p) return null;
  return {
    result: {
      schemaVersion: 1,
      resultDocId: docId(actor),
      outcome: p.outcome as Outcome,
      appliedRevision: p.appliedRevision as number,
      appliedDigest: p.appliedDigest as string,
      warnings: p.warnings as string[],
    },
    flag: p,
  };
}

/**
 * Convergence for re-sends. A newer stored revision refuses the request; the
 * same revision with different content is a conflict; the same revision with
 * the same content returns true, and the caller replays the stored result
 * without writing anything. False means the request must be applied.
 * `revisionKind` names the lane's revision in the error messages.
 */
export function alreadyApplied(
  previous: { appliedRevision: number; appliedDigest: string } | null,
  revision: number,
  digest: string,
  revisionKind: "approved" | "content" | "sequence" | "draft",
): boolean {
  if (!previous) return false;
  if (previous.appliedRevision > revision) {
    throw new RpcError(
      "stale_revision",
      `Actor has a newer ${revisionKind} revision`,
    );
  }
  if (previous.appliedRevision !== revision) return false;
  if (previous.appliedDigest !== digest) {
    throw new RpcError(
      "revision_conflict",
      `the same ${revisionKind} revision carries different content`,
    );
  }
  return true;
}

/** Create an Actor through Foundry's document class, without opening its
 * sheet, and check that Foundry handed back something updatable. */
export async function createActorDocument(data: Dict): Promise<ActorLike> {
  const factory = actorImplementation();
  if (!factory?.create)
    throw new RpcError(
      "unsupported_runtime",
      "Actor.implementation.create is unavailable",
    );
  const created = await factory.create(data, { renderSheet: false });
  const actor = Array.isArray(created) ? created[0] : created;
  if (
    typeof actor !== "object" ||
    actor === null ||
    typeof (actor as ActorLike).update !== "function"
  ) {
    throw new Error("Foundry did not return the created Actor");
  }
  return actor as ActorLike;
}

/**
 * An `ownership` update that REPLACES the Actor's whole ownership map with
 * `default` plus, when given, one OWNER grant. Foundry merges object updates
 * recursively, so sending only the desired map would leave stale grants behind;
 * every other explicit key therefore gets a deletion entry (`deletionEntry`).
 */
export function ownershipReplacement(
  actor: ActorLike,
  defaultLevel: number,
  owner?: string,
): Dict {
  const update: Dict = { default: defaultLevel };
  for (const key of Object.keys(actor.ownership ?? {})) {
    if (key !== "default" && key !== owner) {
      const [k, v] = deletionEntry(key);
      update[k] = v;
    }
  }
  if (owner) update[owner] = OWNERSHIP_OWNER;
  return update;
}

/** The paired Companion user, which the backend reads the world as, unless it
 * is the character's own player (who keeps OWNER). "" before pairing. */
function companionUserId(foundryUserId: string | undefined): string {
  const id = pairedAgentUserId();
  return id && id !== foundryUserId ? id : "";
}

/** The ownership map a provisioning lane creates an Actor with: default NONE,
 * the player OWNER when given, the Companion user OBSERVER (without it the
 * backend never sees the Actor). */
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
export function normalizedOwnershipUpdate(
  actor: ActorLike,
  foundryUserId: string | undefined,
): Dict {
  const update = ownershipReplacement(actor, OWNERSHIP_NONE, foundryUserId);
  const companion = companionUserId(foundryUserId);
  if (companion) {
    // Drop the companion's deletion entry (under Foundry 14's operator the
    // key is the user id itself, which the grant below overwrites anyway).
    delete update[deletionEntry(companion)[0]];
    const current = Number(actor.ownership?.[companion]);
    update[companion] = Math.max(
      OWNERSHIP_OBSERVER,
      Number.isFinite(current) ? current : OWNERSHIP_NONE,
    );
  }
  return update;
}

export async function canonicalDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8.encode(canonicalize(value)),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
