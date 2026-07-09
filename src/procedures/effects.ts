import type { Procedure } from "../rpc/registry.js";
import { assertCompanionPermission, PermissionActorLike } from "./foundry.js";

/**
 * Tier-1 oracle (system-aware writes): apply / remove / set the value of conditions & effects
 * through the game system's OWN API, so rule side-effects (pf2e valued conditions and their rule
 * elements, dnd5e concentration teardown) are handled correctly — unlike a blind document write.
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
 * NOTE: the per-system methods are best-effort and pending verification against a real Foundry
 * world per system; effect.remove uses the stable core ActiveEffect.delete path.
 */

interface EffectDocLike {
  id?: string | null;
  delete(): Promise<unknown>;
}
interface EffectsCollectionLike {
  get(id: string): EffectDocLike | undefined;
}
type ConditionMethod = (...args: unknown[]) => Promise<unknown> | unknown;
interface ActorLike extends PermissionActorLike {
  effects?: EffectsCollectionLike;
  toggleStatusEffect?: (statusId: string, options?: Record<string, unknown>) => Promise<unknown>;
  increaseCondition?: ConditionMethod; // pf2e
  decreaseCondition?: ConditionMethod; // pf2e
}
interface ActorsLike {
  get(id: string): ActorLike | undefined;
}

function actors(): ActorsLike {
  const g = globalThis as unknown as { game?: { actors?: ActorsLike } };
  const a = g.game?.actors;
  if (!a) throw new Error("Foundry game.actors is unavailable");
  return a;
}

function systemId(): string {
  const g = globalThis as unknown as { game?: { system?: { id?: string } } };
  return g.game?.system?.id ?? "";
}

function requireActor(payload: unknown): { actor: ActorLike; p: Record<string, unknown> } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const actorId = String(p.actorId ?? "").trim();
  if (!actorId) throw new Error("effect procedures require 'actorId'");
  const actor = actors().get(actorId);
  if (!actor) throw new Error(`unknown actor ${actorId}`);
  // Writes act on behalf of the actor's owner: require OWNER for the Companion user.
  assertCompanionPermission(actor, "OWNER", actorId);
  return { actor, p };
}

export const effectApply: Procedure = async (payload) => {
  const { actor, p } = requireActor(payload);
  const statusId = String(p.statusId ?? "").trim();
  if (!statusId) throw new Error("effect.apply requires 'statusId'");
  const value = typeof p.value === "number" ? p.value : undefined;

  // pf2e valued conditions increment via the system API so rule elements fire correctly.
  if (systemId() === "pf2e" && actor.increaseCondition) {
    await actor.increaseCondition(statusId, value !== undefined ? { value } : undefined);
    return { ok: true, applied: statusId };
  }
  if (!actor.toggleStatusEffect) throw new Error("this system cannot apply status effects via the API");
  await actor.toggleStatusEffect(statusId, { active: true });
  return { ok: true, applied: statusId };
};

export const effectRemove: Procedure = async (payload) => {
  const { actor, p } = requireActor(payload);
  const effectId = String(p.effectId ?? "").trim();
  if (!effectId) throw new Error("effect.remove requires 'effectId'");
  const effect = actor.effects?.get(effectId);
  if (!effect) throw new Error(`unknown effect ${effectId}`);
  await effect.delete(); // stable core API; covers dnd5e concentration drop and generic effects
  return { ok: true, removed: effectId };
};

export const effectSetValue: Procedure = async (payload) => {
  const { actor, p } = requireActor(payload);
  const statusId = String(p.statusId ?? "").trim();
  const value = typeof p.value === "number" ? p.value : NaN;
  if (!statusId) throw new Error("effect.setValue requires 'statusId'");
  if (Number.isNaN(value) || value < 0) throw new Error("effect.setValue requires a non-negative 'value'");

  // pf2e valued conditions: drive toward the target with the system's increase/decrease API so
  // the badge and any linked rule elements stay consistent. value 0 ⇒ fully remove.
  if (systemId() === "pf2e" && actor.increaseCondition && actor.decreaseCondition) {
    if (value === 0) {
      // decrease to zero; the system removes the condition when it hits 0.
      await actor.decreaseCondition(statusId, { forceRemove: true });
    } else {
      await actor.increaseCondition(statusId, { value });
    }
    return { ok: true, value };
  }
  throw new Error("this system cannot set a condition value via the API");
};
