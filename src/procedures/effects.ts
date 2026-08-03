import type { Procedure } from "../rpc/registry.js";
import {
  actors,
  assertCompanionPermission,
  assertOracleSystemAdmitted,
  PermissionActorLike,
} from "./foundry.js";
import { RpcError } from "../rpc/errors.js";

/**
 * Tier-1 oracle (system-aware writes): apply / remove / set the value of conditions & effects
 * through the game system's OWN API, so supported-system side-effects (for example dnd5e
 * concentration teardown) are handled correctly — unlike a blind document write.
 * Mechanical, side-effect-free embedded writes (e.g. toggling a Knight module field) stay on the
 * Go connector's write path; only mutations needing system behaviour route here.
 *
 * TRUST MODEL: this runs in the elected GM responder's browser (the channel dispatches rpc.request
 * only when isResponder()), so the handler executes with full GM authority — Foundry does NOT scope
 * it to the Companion user. The signed agent key on the channel is the real trust boundary. To keep
 * these writes confined to actors the GM actually shared with the Companion user, we additionally
 * gate on OWNER ownership for the Companion user and return a structured `permission_denied` error
 * when it is missing.
 *
 * `effect.apply({ actorId, statusId, value? })`  → { ok, applied }
 * `effect.remove({ actorId, effectId })`         → { ok, removed }
 * `effect.setValue({ actorId, statusId, value })`→ { ok, value }
 *
 * PF2e is intentionally unavailable here. Its conditions/effects are normally embedded Items and
 * the former generic mapping was not an exact, fixture-proven semantic contract. PF2e must use new
 * narrow, versioned procedures after the M8 authentication/fixture gate. The explicit handler guard
 * protects against stale callers even though capability registration also omits these procedures.
 */

interface EffectDocLike {
  id?: string | null;
  delete(): Promise<unknown>;
}
interface EffectsCollectionLike {
  get(id: string): EffectDocLike | undefined;
}
interface ActorLike extends PermissionActorLike {
  effects?: EffectsCollectionLike;
  toggleStatusEffect?: (
    statusId: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}

function assertEffectProceduresSupported(): void {
  // These write to the world, so an unverified system mapping is a mutation we
  // cannot vouch for — not merely a read we cannot interpret. PF2e is one such
  // system (its embedded condition Items are not modelled here); so is every
  // system we have never proven.
  assertOracleSystemAdmitted("generic effect procedures");
}

function requireActor(payload: unknown): {
  actor: ActorLike;
  p: Record<string, unknown>;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const actorId = String(p.actorId ?? "").trim();
  if (!actorId) throw new Error("effect procedures require 'actorId'");
  const actor = actors<ActorLike>().get(actorId);
  if (!actor) throw new Error(`unknown actor ${actorId}`);
  // Writes act on behalf of the actor's owner: require OWNER for the Companion user.
  assertCompanionPermission(actor, "OWNER", actorId);
  return { actor, p };
}

export const effectApply: Procedure = async (payload) => {
  assertEffectProceduresSupported();
  const { actor, p } = requireActor(payload);
  const statusId = String(p.statusId ?? "").trim();
  if (!statusId) throw new Error("effect.apply requires 'statusId'");

  if (!actor.toggleStatusEffect)
    throw new Error("this system cannot apply status effects via the API");
  await actor.toggleStatusEffect(statusId, { active: true });
  return { ok: true, applied: statusId };
};

export const effectRemove: Procedure = async (payload) => {
  assertEffectProceduresSupported();
  const { actor, p } = requireActor(payload);
  const effectId = String(p.effectId ?? "").trim();
  if (!effectId) throw new Error("effect.remove requires 'effectId'");
  const effect = actor.effects?.get(effectId);
  if (!effect) throw new Error(`unknown effect ${effectId}`);
  await effect.delete(); // stable core API; covers dnd5e concentration drop and generic effects
  return { ok: true, removed: effectId };
};

/**
 * TOMBSTONE — `effect.setValue` is no longer registered or advertised.
 *
 * No system ever had a working implementation: every call validated its
 * arguments and then threw unconditionally, so the capability was a promise the
 * module could not keep. An advertised capability is a claim the apps
 * feature-detect on, so a never-succeeding one is worse than an absent one.
 *
 * It is kept exported, and rejects BEFORE any Actor lookup or permission check,
 * so a stale or direct call is cheap and leaks nothing (the old shape let a
 * caller distinguish "unknown actor" from "permission denied" on a procedure
 * that could not work either way). Same posture as the retired PF2e names.
 */
export const effectSetValue: Procedure = async () => {
  throw new RpcError(
    "unsupported_runtime",
    "effect.setValue is not implemented for any system and is no longer advertised",
  );
};
