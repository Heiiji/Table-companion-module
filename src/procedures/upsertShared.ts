import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import { canonicalize } from "../rpc/responseSigning.js";
import { supportsKnightActorUpsertV1Runtime } from "./foundry.js";

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

export type Dict = Record<string, unknown>;

/** The request/result/flag schema version both provisioning lanes speak. */
export const SCHEMA_VERSION = 1;

/** How an upsert reached its Actor: made it, took over an explicitly assigned
 * unbound one, or found the one already bound to this character. */
export type Outcome = "created" | "adopted" | "updated";

const OUTCOMES: readonly string[] = ["created", "adopted", "updated"];

export interface ActorLike {
  id?: string;
  _id?: string;
  name?: string;
  type?: string;
  flags?: Dict;
  ownership?: Dict;
  system?: unknown;
  items?: { contents?: ActorItemLike[] } | Iterable<ActorItemLike>;
  getFlag?(namespace: string, key: string): unknown;
  update(changes: Dict): Promise<unknown>;
  prepareData?(): void;
  createEmbeddedDocuments?(type: "Item", data: Dict[]): Promise<unknown>;
  deleteEmbeddedDocuments?(type: "Item", ids: string[]): Promise<unknown>;
}

export interface ActorItemLike {
  id?: string;
  _id?: string;
  type?: string;
  system?: unknown;
  getFlag?(namespace: string, key: string): unknown;
  flags?: Dict;
  update?(changes: Dict): Promise<unknown>;
}

export interface ActorsLike {
  contents?: ActorLike[];
  get(id: string): ActorLike | undefined;
  [Symbol.iterator]?(): Iterator<ActorLike>;
}

export interface UserCollectionLike {
  get(id: string): unknown;
}

export interface PackLike {
  getDocument(id: string): Promise<{ toObject(): unknown } | null | undefined>;
}

export interface PacksLike {
  get(id: string): PackLike | undefined;
}

export interface ModuleLike {
  active?: boolean;
  version?: string;
}

export interface ModulesLike {
  get(id: string): ModuleLike | undefined;
}

export interface BindingV1 {
  schemaVersion: 1;
  worldId: string;
  tableId: string;
  characterId: string;
}

/** Foundry document ownership levels used by the provisioning lanes. */
export const OWNERSHIP_NONE = 0;
export const OWNERSHIP_LIMITED = 1;
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
export const ASPECT_KEYS = ["chair", "bete", "machine", "dame", "masque"] as const;
export type AspectKey = (typeof ASPECT_KEYS)[number];
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

/**
 * The gate both Knight lanes repeat before touching the world: the responder
 * must be a GM, and the runtime must be the exact Knight/Foundry pair the
 * mapping was verified against (the same check that decides registration).
 * `procedure` names the lane in the error message.
 */
export function assertKnightUpsertAuthority(procedure: string): void {
  const g = currentGame();
  if (!g.user?.isGM)
    throw new RpcError(
      "permission_denied",
      `${procedure} requires a GM responder`,
    );
  if (!supportsKnightActorUpsertV1Runtime()) {
    throw new RpcError(
      "unsupported_runtime",
      `${procedure} requires Knight 3.58.33 on Foundry 13 or 14`,
    );
  }
}
export function currentGame(): {
  user?: { isGM?: boolean };
  users?: UserCollectionLike;
  actors?: ActorsLike;
  packs?: PacksLike;
  modules?: ModulesLike;
  system?: { id?: string };
  release?: { generation?: number };
  version?: string;
} {
  return (
    (globalThis as unknown as { game?: ReturnType<typeof currentGame> }).game ??
    {}
  );
}

export function actorCollection(): ActorsLike {
  const actors = currentGame().actors;
  if (!actors)
    throw new RpcError(
      "unsupported_runtime",
      "Foundry game.actors is unavailable",
    );
  return actors;
}

export function allActors(collection: ActorsLike): ActorLike[] {
  if (Array.isArray(collection.contents)) return collection.contents;
  const iterator = collection[Symbol.iterator];
  if (iterator)
    return [
      ...({
        [Symbol.iterator]: iterator.bind(collection),
      } as Iterable<ActorLike>),
    ];
  return [];
}

export function actorID(actor: ActorLike): string {
  return actor.id ?? actor._id ?? "";
}

/** An Actor's embedded Items, whichever collection shape the runtime exposes. */
export function actorItems(actor: ActorLike): ActorItemLike[] {
  const items = actor.items;
  if (!items) return [];
  if ("contents" in items && Array.isArray(items.contents))
    return items.contents;
  if (Symbol.iterator in items) return [...(items as Iterable<ActorItemLike>)];
  return [];
}

export function itemID(item: ActorItemLike): string {
  return item.id ?? item._id ?? "";
}

export function flagValue(
  actor: ActorLike | ActorItemLike,
  key: string,
): unknown {
  if (typeof actor.getFlag === "function") return actor.getFlag(MODULE_ID, key);
  const namespace = actor.flags?.[MODULE_ID];
  return typeof namespace === "object" && namespace !== null
    ? (namespace as Dict)[key]
    : undefined;
}

export function bindingOf(actor: ActorLike): BindingV1 | null {
  const value = flagValue(actor, "binding");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    typeof p.worldId !== "string" ||
    typeof p.tableId !== "string" ||
    typeof p.characterId !== "string"
  )
    return null;
  return {
    schemaVersion: 1,
    worldId: p.worldId,
    tableId: p.tableId,
    characterId: p.characterId,
  };
}

export function exactBinding(
  binding: BindingV1 | null,
  expected: BindingV1,
): boolean {
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
  const matches = allActors(collection).filter((actor) =>
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
  const value = flagValue(actor, flagKey);
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    !Number.isSafeInteger(p.appliedRevision) ||
    typeof p.appliedDigest !== "string" ||
    !OUTCOMES.includes(String(p.outcome)) ||
    !Array.isArray(p.warnings) ||
    !p.warnings.every((w) => typeof w === "string")
  )
    return null;
  return {
    result: {
      schemaVersion: 1,
      resultDocId: actorID(actor),
      outcome: p.outcome as Outcome,
      appliedRevision: p.appliedRevision as number,
      appliedDigest: p.appliedDigest,
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
  revisionKind: "approved" | "content",
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
  const factory = (
    globalThis as unknown as {
      Actor?: {
        implementation?: {
          create(data: Dict, options?: Dict): Promise<unknown>;
        };
      };
    }
  ).Actor?.implementation;
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
 * every other explicit key therefore gets a `-=key` deletion directive.
 */
export function ownershipReplacement(
  actor: ActorLike,
  defaultLevel: number,
  owner?: string,
): Dict {
  const update: Dict = { default: defaultLevel };
  for (const key of Object.keys(actor.ownership ?? {})) {
    if (key !== "default" && key !== owner) update[`-=${key}`] = null;
  }
  if (owner) update[owner] = OWNERSHIP_OWNER;
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
