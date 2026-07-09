import type { Procedure } from "../rpc/registry.js";
import { actors, assertCompanionPermission, PermissionActorLike, systemId } from "./foundry.js";

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
interface ActionOptions {
  statistic?: string;
  ability?: string;
  skill?: string;
  aspect?: string;
  characteristic?: string;
  advantage?: boolean;
  disadvantage?: boolean;
  dc?: number;
  /** Knight: extra dice from talents/effects, added on top of the capped pool. */
  bonus?: number;
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

// App-initiated pf2e rolls must never open the GM's roll dialog nor post to table chat.
// Verified against pf2e's StatisticRollParameters: `skipDialog` skips the modifiers dialog,
// `createMessage:false` suppresses the chat card (github.com/foundryvtt/pf2e statistic.ts).
const PF2E_ROLL_OPTS = { skipDialog: true, createMessage: false } as const;

async function rollPf2e(actor: ActorLike, type: string, opts: ActionOptions): Promise<Record<string, unknown>> {
  switch (type) {
    case "save": {
      const stat = actor.saves?.[opts.statistic ?? ""];
      if (!stat?.roll) throw new Error(`pf2e save '${opts.statistic}' is unavailable`);
      return packageRoll(await awaitRoll(stat.roll({ dc: opts.dc, ...PF2E_ROLL_OPTS })), {
        type: "save",
        statistic: opts.statistic,
      });
    }
    case "check":
    case "skill": {
      const slug = opts.skill ?? opts.statistic ?? "";
      const stat = slug === "perception" ? actor.perception : actor.skills?.[slug];
      if (!stat?.roll) throw new Error(`pf2e check '${slug}' is unavailable`);
      return packageRoll(await awaitRoll(stat.roll({ dc: opts.dc, ...PF2E_ROLL_OPTS })), { type, statistic: slug });
    }
    default:
      throw new Error(`pf2e roll type '${type}' is not supported`);
  }
}

// App-initiated dnd5e rolls must never open the GM's roll-configuration dialog nor post to
// table chat. The modern Actor5e roll methods (Foundry 13-14 / dnd5e 4.x+) take
// (config, dialog, message): `dialog.configure:false` skips the dialog and `message.create:false`
// suppresses the chat card (github.com/foundryvtt/dnd5e actor.mjs). The pre-4.x positional
// methods (rollAbilitySave / rollAbilityTest) instead take (id, { fastForward, chatMessage }).
const DND5E_DIALOG = { configure: false } as const;
const DND5E_MESSAGE = { create: false } as const;

async function rollDnd5e(actor: ActorLike, type: string, opts: ActionOptions): Promise<Record<string, unknown>> {
  const cfg = { advantage: opts.advantage, disadvantage: opts.disadvantage };
  const legacyOpts = { ...cfg, fastForward: true, chatMessage: false };
  switch (type) {
    case "save": {
      const ability = opts.ability ?? opts.statistic ?? "";
      const modern = actor.rollSavingThrow;
      const fn = modern ?? actor.rollAbilitySave;
      if (!fn) throw new Error("dnd5e save roll is unavailable");
      const roll = modern
        ? fn.call(actor, { ability, ...cfg }, DND5E_DIALOG, DND5E_MESSAGE)
        : fn.call(actor, ability, legacyOpts);
      return packageRoll(await awaitRoll(roll), { type: "save", ability });
    }
    case "check": {
      const ability = opts.ability ?? opts.statistic ?? "";
      const modern = actor.rollAbilityCheck;
      const fn = modern ?? actor.rollAbilityTest;
      if (!fn) throw new Error("dnd5e check roll is unavailable");
      const roll = modern
        ? fn.call(actor, { ability, ...cfg }, DND5E_DIALOG, DND5E_MESSAGE)
        : fn.call(actor, ability, legacyOpts);
      return packageRoll(await awaitRoll(roll), { type: "check", ability });
    }
    case "skill": {
      const skill = opts.skill ?? "";
      if (!actor.rollSkill) throw new Error("dnd5e skill roll is unavailable");
      // rollSkill was never renamed across the 3.x→4.x change; the module floor is Foundry 13
      // (dnd5e 4.x+), so use the modern object-config shape.
      return packageRoll(
        await awaitRoll(actor.rollSkill.call(actor, { skill, ...cfg }, DND5E_DIALOG, DND5E_MESSAGE)),
        { type: "skill", skill },
      );
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

/** Normalize one evaluated system Roll's dice into our wire shape (faces + flat results). */
function wireDice(roll: RollLike): Array<{ faces: number; results: number[] }> {
  return (roll.dice ?? []).map((term) => ({
    faces: Number(term.faces ?? 0),
    results: (term.results ?? []).map((r) => r.result),
  }));
}

/** Knight success count: a d6 succeeds iff EVEN (2/4/6). No 4+ threshold, no 6-doubles. */
function countKnightSuccesses(dice: Array<{ faces: number; results: number[] }>): number {
  let n = 0;
  for (const term of dice) {
    if (term.faces !== 6) continue;
    for (const r of term.results) if (r % 2 === 0) n += 1;
  }
  return n;
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
  const aspectValue = typeof node?.value === "number" ? node.value : 0;
  const characteristicValue = knightCharacteristicValue(node, characteristic);
  if (aspectValue <= 0) throw new Error(`knight aspect '${aspect}' has no value`);
  if (characteristicValue === undefined || characteristicValue <= 0) {
    throw new Error(`knight characteristic '${characteristic}' on aspect '${aspect}' has no value`);
  }
  // Real Knight (github.com/Zakarik/foundry-knight roll.mjs): the ASPECT is a CAP on the
  // caractéristique, never an addend — the effective pool is min(aspect, carac). Bonus dice from
  // talents/effects add on top of the capped pool.
  const bonus = typeof opts.bonus === "number" && opts.bonus > 0 ? Math.floor(opts.bonus) : 0;
  const pool = Math.min(aspectValue, characteristicValue) + bonus;
  if (pool <= 0) throw new Error(`knight aspect pool for '${aspect}'/'${characteristic}' is empty`);

  // No clean standalone Knight roll API exists (the system builds its pool inside its sheet/dialog),
  // so we roll the pool ourselves and count successes module-side with the real even-parity rule and
  // the exploit reroll, returning `successes` so the app renders ground truth without re-banding.
  const RollCtor = (globalThis as unknown as { Roll: new (f: string) => RollLike }).Roll;
  const first = await awaitRoll(new RollCtor(`${pool}d6`).evaluate?.());
  const dice = wireDice(first);
  let successes = countKnightSuccesses(dice);
  let total = first.total ?? 0;
  let exploited = false;

  // Exploit: if every die in the pool succeeds, the whole pool is rerolled ONCE and its successes
  // are added (a single reroll, not a loop — mirrors the system's rEpicSuccess branch).
  if (pool > 0 && successes === pool) {
    const second = await awaitRoll(new RollCtor(`${pool}d6`).evaluate?.());
    const dice2 = wireDice(second);
    dice.push(...dice2);
    successes += countKnightSuccesses(dice2);
    total += second.total ?? 0;
    exploited = true;
  }

  return {
    formula: `${pool}d6`,
    total,
    dice,
    successes,
    system: { type: "aspect", aspect, characteristic, pool, successes, exploited },
  };
}

export const rollAction: Procedure = async (payload) => {
  const p = (payload ?? {}) as { actorId?: unknown; type?: unknown; options?: unknown };
  const actorId = String(p.actorId ?? "").trim();
  const type = String(p.type ?? "").trim();
  if (!actorId) throw new Error("roll.action requires 'actorId'");
  if (!type) throw new Error("roll.action requires 'type'");
  const opts = (p.options ?? {}) as ActionOptions;

  const actor = actors<ActorLike>().get(actorId);
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
