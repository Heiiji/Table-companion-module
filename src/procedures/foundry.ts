import { findCompanionUser } from "../setup/companion-user.js";
import { RpcError } from "../rpc/errors.js";

/**
 * Shared helpers for the procedure layer.
 *
 * Procedures run inside the elected GM responder's browser, so a handler has full
 * GM authority over the world — the signed agent key on the channel is the trust
 * boundary, NOT Foundry's own permission model. To keep the oracle scoped to the
 * actors the table actually shared with the Companion user, actor-touching
 * procedures additionally gate on the Companion user's per-actor ownership via
 * `assertCompanionPermission`.
 */

/** Structural view of `game.actors` (get by id). `A` is the caller's own actor shape,
 * so each procedure keeps its specific actor interface while sharing this accessor. */
export interface ActorsLike<A = unknown> {
  get(id: string): A | undefined;
}

/** `game.actors`, or throw if Foundry isn't ready. */
export function actors<A = unknown>(): ActorsLike<A> {
  const g = globalThis as unknown as { game?: { actors?: ActorsLike<A> } };
  const a = g.game?.actors;
  if (!a) throw new Error("Foundry game.actors is unavailable");
  return a;
}

/** The active game system id (e.g. "pf2e", "dnd5e", "knight"), or "" if unknown. */
export function systemId(): string {
  const g = globalThis as unknown as { game?: { system?: { id?: string } } };
  return g.game?.system?.id ?? "";
}

/** The active system package version, or "" before system initialization. */
export function systemVersion(): string {
  const g = globalThis as unknown as {
    game?: { system?: { version?: string } };
  };
  return g.game?.system?.version ?? "";
}

/** Foundry's major generation, normalized across the v13/v14 runtime shapes. */
export function foundryGeneration(): number {
  const g = globalThis as unknown as {
    game?: { release?: { generation?: number }; version?: string };
  };
  if (Number.isInteger(g.game?.release?.generation))
    return g.game!.release!.generation!;
  const parsed = Number.parseInt(g.game?.version ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Exact fixture gate for the only Knight actor mapping admitted by this release. */
export function supportsKnightActorUpsertV1Runtime(): boolean {
  return (
    systemId() === "knight" &&
    systemVersion() === "3.58.33" &&
    [13, 14].includes(foundryGeneration())
  );
}

/** The active Foundry world id (`game.world.id`), or "" if unknown. Bound into
 * the module response-signing string (M8) so the agent can pin it and rebuild
 * the canonical bytes. Foundry world ids are `[A-Za-z0-9_-]` — no `|`. */
export function worldId(): string {
  const g = globalThis as unknown as { game?: { world?: { id?: string } } };
  return g.game?.world?.id ?? "";
}

/** Foundry document-ownership levels we gate procedures on. */
export type OwnershipLevel = "OBSERVER" | "OWNER";

/** Minimal view of an actor for the permission gate — a live Foundry actor always
 * carries `testUserPermission`; plain test fakes need not. */
export interface PermissionActorLike {
  testUserPermission?(
    user: unknown,
    permission: OwnershipLevel | number,
    options?: { exact?: boolean },
  ): boolean;
}

/**
 * Assert the paired Companion user holds at least `level` ownership on this actor,
 * throwing a structured `permission_denied` RpcError otherwise. Reads want OBSERVER,
 * writes / rolls-on-behalf want OWNER. This confines the oracle to actors the GM
 * explicitly shared with the Companion user, rather than every actor in the world.
 *
 * Only enforceable against a live Foundry actor (which always exposes
 * `testUserPermission`); the unit harness passes plain fakes without it, where the
 * check is a no-op — the channel's signed agent key remains the trust boundary.
 */
export function assertCompanionPermission(
  actor: PermissionActorLike,
  level: OwnershipLevel,
  actorId: string,
): void {
  if (typeof actor.testUserPermission !== "function") return;
  const companion = findCompanionUser();
  if (!companion) {
    throw new RpcError(
      "permission_denied",
      "no Companion user is configured to authorize actor access",
    );
  }
  if (!actor.testUserPermission(companion, level)) {
    throw new RpcError(
      "permission_denied",
      `Companion user lacks ${level} permission on actor ${actorId}`,
    );
  }
}
