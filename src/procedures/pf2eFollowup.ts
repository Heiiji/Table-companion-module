import { MODULE_ID, REQUEST_TIMEOUT_MS } from "../constants.js";
import { foundryGame, foundryHooks, type Dict } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  PF2E_RESOURCES_REQUIREMENT,
  assertLaneAuthority,
  documentId,
  identifier,
  invalid,
  oneOf,
  record,
  uuid,
} from "./upsertShared.js";
import {
  laneFlags,
  newDocumentId,
  postUnposted,
  runOnce,
  stampedCard,
  type CardMessage,
} from "./chatCards.js";
import { oneAtATime } from "./knightRollLane.js";
import {
  CHECK_LANE,
  skipDamageDialogEvent,
  supportsPf2eCheckV1Runtime,
  type Pf2eCheckResultV1,
} from "./pf2eCheck.js";
import {
  CARD_LANE,
  consumableEffect,
  type ConsumableEffect,
} from "./pf2eCard.js";
import { modeOf, type Message } from "./pf2eReroll.js";

/**
 * `pf2e.followup.v1`: what follows a card this module stamped earlier, rolled
 * by pf2e itself — a Strike's damage or critical damage and a spell attack's
 * damage (from a `pf2e.check` card), a spell's damage or a consumable's
 * effect (from a `pf2e.card` card). pf2e posts its own damage card; a
 * one-shot `preCreateChatMessage` hook stamps it at birth (lane
 * `pf2e.followup`, `followupOf` the source's eventId) and gives it the
 * source card's author, whisper and blind. A consumable's use card is built
 * here as pf2e builds it, without `ConsumablePF2e#consume`: nothing is spent,
 * no ammunition, slot or item — the app writes its counters itself.
 *
 * Seen on a live Foundry 14 world with pf2e 8.7.0: `message._strike.damage`
 * / `.critical({checkContext, event})` and `message.item.rollDamage(event)`
 * create the damage message themselves, its `flags.pf2e.context.type`
 * `"damage-roll"`; a consumable's use card carries a `DamageRoll` of its
 * `system.damage` and `flags.pf2e.origin` of type `"consumable"`.
 */

export const PROCEDURE = "pf2e.followup.v1";
export const FOLLOWUP_LANE = "pf2e.followup";

const PAYLOAD_KEYS = [
  "eventId",
  "origin",
  "actorId",
  "kind",
  "sourceEventId",
] as const;
const ORIGINS = ["app", "player"] as const;
const KINDS = ["damage", "critical"] as const;

export interface Pf2eFollowupV1 {
  eventId: string;
  origin: (typeof ORIGINS)[number];
  actorId: string;
  kind: (typeof KINDS)[number];
  sourceEventId: string;
}

export interface Pf2eFollowupResultV1 {
  messageId: string;
  alreadyRolled: boolean;
  /** pf2e's formula as its card shows it. */
  formula: string;
  total: number;
  /** Every die term in roll order, with its active results only. */
  dice: { faces: number; results: number[] }[];
  kind: "damage" | "healing";
  critical: boolean;
  messageMode: Pf2eCheckResultV1["messageMode"];
}

/** A `DamageRoll` as this lane reads it. */
interface DamageRollLike {
  formula?: unknown;
  total?: unknown;
  dice?: {
    faces?: unknown;
    results?: { result?: unknown; active?: boolean; discarded?: boolean }[];
  }[];
  kinds?: Iterable<unknown>;
  evaluate?(): Promise<unknown>;
}

type RollDamage = (params: unknown) => Promise<unknown>;

/** The source card, with pf2e's `ChatMessagePF2e` getters. */
interface SourceMessage extends Message {
  _strike?: { damage?: RollDamage; critical?: RollDamage } | null;
  item?: {
    type?: string;
    system?: { damage?: Dict | null };
    rollDamage?: RollDamage;
  } | null;
}

export function validatePf2eFollowupV1(payload: unknown): Pf2eFollowupV1 {
  const p = record(payload, "payload", PAYLOAD_KEYS);
  for (const key of PAYLOAD_KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  const req = {
    eventId: identifier(p.eventId, "eventId", uuid),
    origin: oneOf(p.origin, "origin", ORIGINS),
    actorId: identifier(p.actorId, "actorId", documentId),
    kind: oneOf(p.kind, "kind", KINDS),
    sourceEventId: identifier(p.sourceEventId, "sourceEventId", uuid),
  };
  if (req.eventId === req.sourceEventId)
    invalid("eventId must differ from sourceEventId");
  return req;
}

const dictAt = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? (v as Dict)[key] : undefined;

const contextOf = (m: CardMessage): Dict =>
  (dictAt(m.flags?.pf2e, "context") ?? {}) as Dict;

function refused(why: string): RpcError {
  return new RpcError("followup_refused", `${PROCEDURE}: ${why}`);
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

/** The reply, read from pf2e's roll: every field or none. */
export function followupResult(
  raw: unknown,
  messageId: string,
  critical: boolean,
  messageMode: Pf2eFollowupResultV1["messageMode"],
): Pf2eFollowupResultV1 {
  const roll = (raw ?? {}) as DamageRollLike;
  const { formula, total } = roll;
  if (typeof formula !== "string" || !formula.trim())
    throw refused("pf2e's roll has no formula");
  if (!isInt(total, 0, Number.MAX_SAFE_INTEGER))
    throw refused("pf2e's roll has no whole total");
  const dice = (roll.dice ?? []).map((d) => ({
    faces: d.faces as number,
    results: (d.results ?? [])
      .filter((r) => r.active !== false && !r.discarded)
      .map((r) => r.result as number),
  }));
  if (
    dice.length > 50 ||
    dice.reduce((n, d) => n + d.results.length, 0) > 100 ||
    dice.some(
      (d) =>
        !isInt(d.faces, 2, 100) || d.results.some((r) => !isInt(r, 1, d.faces)),
    )
  )
    throw refused("pf2e's dice are out of range");
  const kinds = [...(roll.kinds ?? [])];
  return {
    messageId,
    alreadyRolled: false,
    formula: formula.slice(0, 200),
    total,
    dice,
    kind:
      kinds.length > 0 && kinds.every((k) => k === "healing")
        ? "healing"
        : "damage",
    critical,
    messageMode,
  };
}

/** A consumable effect as stamped on its card, or undefined. */
function stampedEffect(v: unknown): ConsumableEffect | undefined {
  const e = v as ConsumableEffect | undefined;
  return typeof e?.formula === "string" &&
    e.formula.trim() &&
    typeof e.name === "string" &&
    typeof e.type === "string" &&
    typeof e.kind === "string"
    ? e
    : undefined;
}

/** What rolls the follow-up: a pf2e call that posts its own card, or a
 * consumable effect this lane posts. */
type Plan = (() => Promise<unknown>) | ConsumableEffect;

function spellDamage(item: SourceMessage["item"]): Plan {
  if (item?.type !== "spell" || typeof item.rollDamage !== "function")
    throw refused("the card's spell is not on the Actor");
  if (Object.keys(item.system?.damage ?? {}).length === 0)
    throw refused("the spell deals no damage");
  return () => item.rollDamage!(skipDamageDialogEvent());
}

/** The table of the contract: what a source card can follow up with. */
function planFor(req: Pf2eFollowupV1, source: SourceMessage): Plan {
  const critical = req.kind === "critical";
  if (laneFlags(source)?.lane === CHECK_LANE) {
    const strike = source._strike;
    if (strike) {
      const roll = critical ? strike.critical : strike.damage;
      if (typeof roll !== "function")
        throw refused("pf2e offers no such damage for the Strike");
      return () =>
        roll.call(strike, {
          checkContext: contextOf(source),
          event: skipDamageDialogEvent(),
        });
    }
    const origin = dictAt(source.flags?.pf2e, "origin");
    if (!critical && dictAt(origin, "type") === "spell")
      return spellDamage(source.item);
    throw refused(
      critical
        ? "only a Strike rolls critical damage"
        : "the check is neither a Strike nor a spell attack",
    );
  }
  if (critical) throw refused("only a Strike rolls critical damage");
  // The card's own stamp first: the app may have removed the item since.
  const effect =
    stampedEffect(laneFlags(source)?.effect) ?? consumableEffect(source.item);
  if (effect) return effect;
  if (source.item?.type === "spell") return spellDamage(source.item);
  throw refused("the card has no damage or effect to roll");
}

/** pf2e's formula of a consumable's effect, as its `consume` builds it. */
export function effectFormula(effect: ConsumableEffect): string {
  const tags = [effect.type, effect.kind === "healing" ? "healing" : ""]
    .filter(Boolean)
    .join(",");
  return `(${effect.formula})${tags ? `[${tags}]` : ""}`;
}

function damageRollClass():
  (new (formula: string) => DamageRollLike) | undefined {
  const rolls = (globalThis as { CONFIG?: { Dice?: { rolls?: unknown[] } } })
    .CONFIG?.Dice?.rolls;
  return (rolls ?? []).find(
    (r) => typeof r === "function" && r.name === "DamageRoll",
  ) as (new (formula: string) => DamageRollLike) | undefined;
}

async function followup(req: Pf2eFollowupV1): Promise<Pf2eFollowupResultV1> {
  const source = (stampedCard(req.sourceEventId, CHECK_LANE) ??
    stampedCard(req.sourceEventId, CARD_LANE)) as SourceMessage | undefined;
  if (!source || source.speaker?.actor !== req.actorId)
    throw new RpcError(
      "source_not_found",
      `${PROCEDURE}: no card of that actor carries sourceEventId`,
    );
  const plan = planFor(req, source);
  const critical = req.kind === "critical";
  const messageMode = modeOf(source);
  const author = source._source?.author;
  const whisper = [...(source._source?.whisper ?? source.whisper ?? [])];
  const blind = source._source?.blind ?? source.blind ?? false;
  const stamp = (result: Pf2eFollowupResultV1) => ({
    eventId: req.eventId,
    origin: req.origin,
    lane: FOLLOWUP_LANE,
    followupOf: req.sourceEventId,
    result,
  });

  if (typeof plan !== "function") {
    const DamageRoll = damageRollClass();
    if (!DamageRoll)
      throw new RpcError(
        "unsupported_runtime",
        `${PROCEDURE}: pf2e's DamageRoll is unavailable`,
      );
    const roll = new DamageRoll(effectFormula(plan));
    await roll.evaluate?.();
    const messageId = newDocumentId();
    const result = followupResult(roll, messageId, critical, messageMode);
    const i18n = foundryGame()?.i18n as
      { format?(key: string, data: Dict): string } | undefined;
    const posted = await postUnposted(
      {
        speaker: source.speaker,
        flavor:
          i18n?.format?.("PF2E.ConsumableMessage.UseSingle", {
            name: plan.name,
          }) ?? plan.name,
        rolls: [roll],
        flags: {
          pf2e: {
            origin: {
              sourceId: plan.sourceId,
              uuid: plan.uuid,
              type: "consumable",
            },
          },
          [MODULE_ID]: stamp(result),
        },
      },
      { _id: messageId, ...(author ? { author } : {}), whisper, blind },
    );
    if (!posted) throw refused("Foundry did not create the card");
    return result;
  }

  const hooks = foundryHooks();
  if (!hooks)
    throw new RpcError(
      "unsupported_runtime",
      `${PROCEDURE}: Foundry Hooks are unavailable`,
    );
  let result: Pf2eFollowupResultV1 | undefined;
  let hookId: number | undefined;
  const disarm = () => {
    if (hookId === undefined) return;
    hooks.off?.("preCreateChatMessage", hookId);
    hookId = undefined;
  };
  hookId = hooks.on(
    "preCreateChatMessage",
    (doc: CardMessage, _data: Dict, options: Dict) => {
      if (
        hookId === undefined ||
        contextOf(doc).type !== "damage-roll" ||
        doc.speaker?.actor !== req.actorId
      )
        return;
      disarm();
      try {
        const messageId = newDocumentId();
        result = followupResult(
          doc.rolls?.[0],
          messageId,
          critical,
          messageMode,
        );
        // The card keeps the id its stamped result names.
        options.keepId = true;
        doc.updateSource?.({
          _id: messageId,
          ...(author ? { author } : {}),
          whisper,
          blind,
          [`flags.${MODULE_ID}`]: stamp(result),
        });
      } catch {
        // Never a card the app cannot read back: the roll is refused.
        result = undefined;
        return false;
      }
    },
  );
  const timer = setTimeout(disarm, REQUEST_TIMEOUT_MS);
  try {
    await plan();
  } finally {
    clearTimeout(timer);
    disarm();
  }
  if (result && stampedCard(req.eventId, FOLLOWUP_LANE)) return result;
  throw refused("pf2e posted no damage card");
}

export const pf2eFollowupV1: Procedure = (payload) => {
  const req = validatePf2eFollowupV1(payload);
  assertLaneAuthority(
    PROCEDURE,
    supportsPf2eCheckV1Runtime,
    `${PF2E_RESOURCES_REQUIREMENT} with game.pf2e.Check`,
  );
  return runOnce<Pf2eFollowupResultV1>(
    FOLLOWUP_LANE,
    req.eventId,
    (r) => ({ ...r, alreadyRolled: true }),
    // One follow-up or reroll at a time: the hook knows pf2e's card by its
    // actor only.
    () => oneAtATime(() => followup(req)),
  );
};
