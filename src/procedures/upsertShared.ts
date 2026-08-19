import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import { canonicalize } from "../rpc/responseSigning.js";

/**
 * Shared plumbing for the durable actor-provisioning procedures
 * (`actor.upsert.v1` for the Knight PC type, `npc.upsert.v1` for the Knight
 * pnj type). Everything here is deliberately actor-type-agnostic: the strict
 * validation primitives, the Foundry collection accessors, and the
 * `flags["table-companion"].binding` identity that both lanes share so one
 * characterId can never bind two Actors. Type-specific mapping stays in each
 * procedure's own file.
 */

export type Dict = Record<string, unknown>;

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

export async function canonicalDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8.encode(canonicalize(value)),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
