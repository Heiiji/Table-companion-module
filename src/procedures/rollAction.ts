import type { Procedure } from "../rpc/registry.js";
import { assertCompanionPermission, PermissionActorLike } from "./foundry.js";

/**
 * Tier-1 oracle (roll): resolve a system-contextual roll through the game system's OWN pipeline,
 * so the app gets ground-truth results — pf2e degrees-of-success, dnd5e advantage, a Knight aspect
 * d6-pool — instead of approximating the modifier stack locally.
 *
 * `roll.action({ actorId, type, options })` → `{ formula, total, dice, system }`
 *   type: "save" | "check" | "skill" | "aspect" (extend per system)
 *   options: system-specific knobs (statistic / ability / skill / aspect / advantage / dc)
 *   system: enrichment carried through verbatim (e.g. { degreeOfSuccess }) for the app to render
 *
 * Strictly additive: when this capability is absent — or it throws for an unsupported type — the
 * app resolves the roll with its local dice engine (standalone-first). NOTE: the exact system roll
 * method names are pending verification against a real Foundry world per system.
 */

interface DieTermLike {
  faces?: number | null;
  results?: Array<{ result: number }>;
}
interface RollLike {
  formula?: string;
  total?: number | null;
  dice?: DieTermLike[];
  degreeOfSuccess?: number;
  options?: { degreeOfSuccess?: number } & Record<string, unknown>;
  evaluate?: () => Promise<RollLike>;
}
type RollMethod = (...args: unknown[]) => Promise<RollLike | null | undefined> | RollLike | null | undefined;

interface StatisticLike {
  roll?: RollMethod;
}
interface ActorLike extends PermissionActorLike {
  saves?: Record<string, StatisticLike | undefined>;
  skills?: Record<string, StatisticLike | undefined>;
  perception?: StatisticLike;
  system?: Record<string, unknown>;
  rollSavingThrow?: RollMethod;
  rollAbilitySave?: RollMethod;
  rollAbilityTest?: RollMethod;
  rollAbilityCheck?: RollMethod;
  rollSkill?: RollMethod;
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

interface ActionOptions {
  statistic?: string;
  ability?: string;
  skill?: string;
  aspect?: string;
  characteristic?: string;
  advantage?: boolean;
  disadvantage?: boolean;
  dc?: number;
}

/** Normalize any system Roll into our wire shape plus optional enrichment. */
function packageRoll(roll: RollLike, enrichment?: Record<string, unknown>): Record<string, unknown> {
  const dice = (roll.dice ?? []).map((term) => ({
    faces: Number(term.faces ?? 0),
    results: (term.results ?? []).map((r) => r.result),
  }));
  const degree = roll.degreeOfSuccess ?? roll.options?.degreeOfSuccess;
  const system: Record<string, unknown> = { ...(enrichment ?? {}) };
  if (degree !== undefined) system.degreeOfSuccess = degree;
  return {
    formula: roll.formula ?? "",
    total: roll.total ?? 0,
    dice,
    ...(Object.keys(system).length > 0 ? { system } : {}),
  };
}

async function awaitRoll(value: ReturnType<RollMethod>): Promise<RollLike> {
  const roll = await value;
  if (!roll) throw new Error("system roll returned nothing");
  return roll;
}

async function rollPf2e(actor: ActorLike, type: string, opts: ActionOptions): Promise<Record<string, unknown>> {
  switch (type) {
    case "save": {
      const stat = actor.saves?.[opts.statistic ?? ""];
      if (!stat?.roll) throw new Error(`pf2e save '${opts.statistic}' is unavailable`);
      return packageRoll(await awaitRoll(stat.roll({ dc: opts.dc })), { type: "save", statistic: opts.statistic });
    }
    case "check":
    case "skill": {
      const slug = opts.skill ?? opts.statistic ?? "";
      const stat = slug === "perception" ? actor.perception : actor.skills?.[slug];
      if (!stat?.roll) throw new Error(`pf2e check '${slug}' is unavailable`);
      return packageRoll(await awaitRoll(stat.roll({ dc: opts.dc })), { type, statistic: slug });
    }
    default:
      throw new Error(`pf2e roll type '${type}' is not supported`);
  }
}

async function rollDnd5e(actor: ActorLike, type: string, opts: ActionOptions): Promise<Record<string, unknown>> {
  const cfg = { advantage: opts.advantage, disadvantage: opts.disadvantage };
  switch (type) {
    case "save": {
      const ability = opts.ability ?? opts.statistic ?? "";
      const fn = actor.rollSavingThrow ?? actor.rollAbilitySave;
      if (!fn) throw new Error("dnd5e save roll is unavailable");
      return packageRoll(await awaitRoll(fn.call(actor, actor.rollSavingThrow ? { ability, ...cfg } : ability, cfg)), {
        type: "save",
        ability,
      });
    }
    case "check": {
      const ability = opts.ability ?? opts.statistic ?? "";
      const fn = actor.rollAbilityCheck ?? actor.rollAbilityTest;
      if (!fn) throw new Error("dnd5e check roll is unavailable");
      return packageRoll(await awaitRoll(fn.call(actor, actor.rollAbilityCheck ? { ability, ...cfg } : ability, cfg)), {
        type: "check",
        ability,
      });
    }
    case "skill": {
      const skill = opts.skill ?? "";
      if (!actor.rollSkill) throw new Error("dnd5e skill roll is unavailable");
      return packageRoll(await awaitRoll(actor.rollSkill.call(actor, skill, cfg)), { type: "skill", skill });
    }
    default:
      throw new Error(`dnd5e roll type '${type}' is not supported`);
  }
}

/** A Knight aspect node: an aspect value plus its caracteristiques sub-scores (FR spelling). */
interface KnightAspect {
  value?: number;
  // The real Knight system stores the sub-scores under `caracteristiques` (verified against the
  // apps' own Knight mapper: aspects.{aspect}.caracteristiques.{characteristic}.value). We also
  // accept a singular `caracteristique` defensively in case a variant world uses it.
  caracteristiques?: Record<string, { value?: number } | undefined>;
  caracteristique?: Record<string, { value?: number } | undefined>;
}

/** Read a numeric characteristic value out of an aspect, tolerating both FR spellings. */
function knightCharacteristicValue(aspect: KnightAspect | undefined, characteristic: string): number | undefined {
  const bag = aspect?.caracteristiques ?? aspect?.caracteristique;
  const v = bag?.[characteristic]?.value;
  return typeof v === "number" ? v : undefined;
}

async function rollKnight(actor: ActorLike, type: string, opts: ActionOptions): Promise<Record<string, unknown>> {
  if (type !== "aspect") throw new Error(`knight roll type '${type}' is not supported`);
  const aspect = opts.aspect ?? "";
  const characteristic = opts.characteristic ?? "";
  if (!aspect) throw new Error("knight aspect roll requires 'aspect'");
  if (!characteristic) throw new Error("knight aspect roll requires 'characteristic'");
  const sys = actor.system ?? {};
  const aspects = sys.aspects as Record<string, KnightAspect | undefined> | undefined;
  const node = aspects?.[aspect];
  // The Knight roll is ASPECT + CARACTERISTIQUE: the d6 pool is the aspect score plus the chosen
  // characteristic's score. Both must be present and the total positive; otherwise we throw so the
  // app falls back to a local roll (standalone-first).
  const aspectValue = typeof node?.value === "number" ? node.value : 0;
  const characteristicValue = knightCharacteristicValue(node, characteristic);
  if (aspectValue <= 0) throw new Error(`knight aspect '${aspect}' has no value`);
  if (characteristicValue === undefined || characteristicValue <= 0) {
    throw new Error(`knight characteristic '${characteristic}' on aspect '${aspect}' has no value`);
  }
  const size = aspectValue + characteristicValue;
  if (size <= 0) throw new Error(`knight aspect+characteristic pool for '${aspect}'/'${characteristic}' is empty`);
  // We roll the d6 success pool here and let the app apply the success bands declared in the system
  // profile (threshold 4 / 6-doubles), keeping the agent/module agnostic about outcome bands.
  const RollCtor = (globalThis as unknown as { Roll: new (f: string) => RollLike }).Roll;
  const roll = await awaitRoll(new RollCtor(`${size}d6`).evaluate?.());
  return packageRoll(roll, { type: "aspect", aspect, characteristic, pool: size });
}

export const rollAction: Procedure = async (payload) => {
  const p = (payload ?? {}) as { actorId?: unknown; type?: unknown; options?: unknown };
  const actorId = String(p.actorId ?? "").trim();
  const type = String(p.type ?? "").trim();
  if (!actorId) throw new Error("roll.action requires 'actorId'");
  if (!type) throw new Error("roll.action requires 'type'");
  const opts = (p.options ?? {}) as ActionOptions;

  const actor = actors().get(actorId);
  if (!actor) throw new Error(`unknown actor ${actorId}`);
  // Rolling on behalf of the actor acts as its owner: require OWNER for the Companion user.
  assertCompanionPermission(actor, "OWNER", actorId);

  switch (systemId()) {
    case "pf2e":
      return rollPf2e(actor, type, opts);
    case "dnd5e":
      return rollDnd5e(actor, type, opts);
    case "knight":
      return rollKnight(actor, type, opts);
    default:
      throw new Error(`roll.action is not supported for system '${systemId()}'`);
  }
};
