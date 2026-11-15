import { MODULE_ID } from "../constants.js";
import { foundryGame, foundryHooks, type Dict } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { waitFor, within } from "../util/wait.js";
import {
  actorCollection,
  assertKnightUpsertAuthority,
  documentId,
  identifier,
  invalid,
  oneOf,
  record,
  uuid,
} from "./upsertShared.js";
import {
  laneFlags,
  messages,
  newDocumentId,
  runOnce,
  stampedCard,
  type CardMessage,
} from "./chatCards.js";
import {
  ATTACK_LANE,
  knightFlags,
  supportsKnightAttackV1Runtime,
} from "./knightAttack.js";
import { CHAT_HOOKS, KNIGHT_STAMP_MS, oneAtATime } from "./knightRollLane.js";

export const PROCEDURE = "knight.followup.v1";
export const FOLLOWUP_LANE = "knight.followup";
const KEYS = ["eventId", "origin", "actorId", "kind", "sourceEventId"] as const;
const KINDS = ["damage", "violence"] as const;
type Kind = (typeof KINDS)[number];

export interface KnightFollowupV1 {
  eventId: string;
  origin: "app" | "player";
  actorId: string;
  kind: Kind;
  sourceEventId: string;
}
export interface KnightFollowupResultV1 {
  messageId: string;
  alreadyRolled: boolean;
  formula: string;
  total: number;
  dice: { faces: number; results: number[] }[];
  kind: Kind;
}
interface Source extends CardMessage {
  _source?: { author?: string; whisper?: string[]; blind?: boolean };
  whisper?: string[];
  blind?: boolean;
}
interface DamageRoller {
  doRollDamage(data: Dict): Promise<unknown>;
  doRollViolence(data: Dict): Promise<unknown>;
}
type RollerClass = new (
  actor: unknown,
  data: Dict,
  isSuccess: boolean,
) => DamageRoller;
function rollerClass(): RollerClass | undefined {
  const roller = foundryGame()?.knight?.RollKnight as
    { prototype?: Partial<DamageRoller> } | undefined;
  return typeof roller?.prototype?.doRollDamage === "function" &&
    typeof roller.prototype.doRollViolence === "function"
    ? (roller as unknown as RollerClass)
    : undefined;
}
export function supportsKnightFollowupV1Runtime(): boolean {
  return supportsKnightAttackV1Runtime() && !!rollerClass();
}
export function validateKnightFollowupV1(payload: unknown): KnightFollowupV1 {
  const p = record(payload, "payload", KEYS);
  for (const key of KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  const req = {
    eventId: identifier(p.eventId, "eventId", uuid),
    origin: oneOf(p.origin, "origin", ["app", "player"] as const),
    actorId: identifier(p.actorId, "actorId", documentId),
    kind: oneOf(p.kind, "kind", KINDS),
    sourceEventId: identifier(p.sourceEventId, "sourceEventId", uuid),
  };
  if (req.eventId === req.sourceEventId)
    invalid("eventId must differ from sourceEventId");
  return req;
}
const unknownOutcome = () =>
  new RpcError(
    "followup_outcome_unknown",
    "Knight may have rolled; wait for its card",
  );
const refused = (message: string) => new RpcError("followup_refused", message);

/** Knight 3.58.38 keeps fixed bonuses and some effects in the displayed
 * total, outside Roll.total. Read that total, never recompute its rules. */
export function buildKnightFollowupResult(
  card: CardMessage,
  kind: Kind,
  messageId: string,
): KnightFollowupResultV1 {
  const raw = card.rolls?.[0];
  const roll = (typeof raw === "string" ? JSON.parse(raw) : raw) as
    | {
        dice?: {
          faces?: number;
          results?: {
            result?: number;
            active?: boolean;
            discarded?: boolean;
          }[];
        }[];
      }
    | undefined;
  const totalText =
    /class=["'][^"']*\bdice-total\b[^"']*["'][^>]*>\s*(-?\d+)\s*</.exec(
      card.content ?? "",
    )?.[1];
  const total = totalText === undefined ? NaN : Number(totalText);
  const dice = (roll?.dice ?? []).map((d) => ({
    faces: d.faces as number,
    results: (d.results ?? [])
      .filter((r) => r.active !== false && !r.discarded)
      .map((r) => r.result as number),
  }));
  const sum = dice.reduce(
    (n, d) => n + d.results.reduce((a, b) => a + b, 0),
    0,
  );
  const modifier = total - sum;
  const formula = dice.length
    ? dice.map((d) => `${d.results.length}d${d.faces}`).join("+") +
      (modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : "")
    : String(total);
  if (
    !roll ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > 100_000 ||
    dice.length > 50 ||
    dice.reduce((n, d) => n + d.results.length, 0) > 100 ||
    dice.some(
      (d) =>
        !Number.isInteger(d.faces) ||
        d.faces < 2 ||
        d.faces > 1000 ||
        d.results.some((r) => !Number.isInteger(r) || r < 1 || r > d.faces),
    ) ||
    formula.length > 200
  )
    throw unknownOutcome();
  return {
    messageId,
    alreadyRolled: false,
    formula: formula || String(total),
    total,
    dice,
    kind,
  };
}

async function followup(
  req: KnightFollowupV1,
): Promise<KnightFollowupResultV1> {
  const source = stampedCard(req.sourceEventId, ATTACK_LANE) as
    Source | undefined;
  if (!source || source.speaker?.actor !== req.actorId)
    throw new RpcError(
      "source_not_found",
      "No attack of that actor carries sourceEventId",
    );
  const previous = messages().find((m) => {
    const flags = laneFlags(m);
    const manual = flags?.followUp as
      { attackEventId?: string; kind?: string } | undefined;
    return (
      (flags?.lane === FOLLOWUP_LANE &&
        flags.followupOf === req.sourceEventId &&
        flags.kind === req.kind) ||
      (manual?.attackEventId === req.sourceEventId && manual.kind === req.kind)
    );
  });
  if (previous) {
    if (laneFlags(previous)?.followUp) {
      if (!previous.id) throw unknownOutcome();
      return {
        ...buildKnightFollowupResult(previous, req.kind, previous.id),
        alreadyRolled: true,
      };
    }
    const result = laneFlags(previous)?.result as
      KnightFollowupResultV1 | undefined;
    if (!result) throw unknownOutcome();
    return { ...result, alreadyRolled: true };
  }
  const actor = actorCollection().get(req.actorId);
  const Roller = rollerClass();
  if (!actor || !Roller)
    throw refused("The actor or Knight damage roller is unavailable");
  const flags = knightFlags(source);
  const content = flags?.content as
    { total?: number; targets?: Dict[] }[] | undefined;
  // Cadence has several sections: use the first hit, or the targetless one.
  const section = content?.find(
    (c) => !c.targets?.length || c.targets.some((t) => t.hit === true),
  );
  if (!flags?.weapon || !section || !Array.isArray(section.targets))
    throw refused("The attack has no successful damage section");
  const weapon = structuredClone(flags.weapon) as Dict;
  const raw = (weapon.effets as { raw?: string[] } | undefined)?.raw ?? [];
  weapon.rollType = req.kind;
  // Same input as Knight 3.58.38's rollDamage / rollViolence button helpers.
  const dataFlags: Dict = {
    ...structuredClone(flags),
    weapon,
    actor,
    attaque: source.rolls,
  };
  const targets = structuredClone(section.targets).map((target) => ({
    ...target,
    btn: (target.btn as { classes?: string[] }[] | undefined)?.filter(
      (b) =>
        !b.classes?.some(
          (c) =>
            c === "applyAttaqueEffects" ||
            (req.kind === "damage" && c === "autoStatus"),
        ),
    ),
  }));
  const data: Dict = {
    total: section.total,
    targets,
    attaque: source.rolls,
    flags: dataFlags,
  };
  if (req.kind === "damage" && raw.includes("tirenrafale"))
    data.content = { tirenrafale: true };
  const hooks = foundryHooks();
  if (!hooks) throw refused("Foundry Hooks are unavailable");
  let hookId: number | undefined;
  const disarm = () => {
    if (hookId !== undefined) hooks.off?.("preCreateChatMessage", hookId);
    hookId = undefined;
  };
  hookId = hooks.on(
    "preCreateChatMessage",
    (doc: CardMessage, _data: Dict, options: Dict) => {
      if (
        hookId === undefined ||
        doc.speaker?.actor !== req.actorId ||
        !doc.rolls?.length
      )
        return;
      disarm();
      const messageId = newDocumentId();
      options.keepId = true;
      let result: KnightFollowupResultV1 | undefined;
      try {
        result = buildKnightFollowupResult(doc, req.kind, messageId);
      } catch {
        /* A roll exists; keep its stamp. */
      }
      doc.updateSource?.({
        _id: messageId,
        ...(source._source?.author ? { author: source._source.author } : {}),
        whisper: [...(source._source?.whisper ?? source.whisper ?? [])],
        blind: source._source?.blind ?? source.blind ?? false,
        [`flags.${MODULE_ID}`]: {
          eventId: req.eventId,
          origin: req.origin,
          lane: FOLLOWUP_LANE,
          followupOf: req.sourceEventId,
          kind: req.kind,
          ...(result ? { result } : {}),
        },
      });
    },
  );
  const timer = setTimeout(disarm, KNIGHT_STAMP_MS);
  try {
    const roller = new Roller(
      actor,
      {
        name: flags.flavor ?? source.flavor ?? "",
        weapon,
        surprise: flags.surprise,
      },
      false,
    );
    try {
      if (req.kind === "damage") await roller.doRollDamage(data);
      else await roller.doRollViolence(data);
    } catch {
      /* An exception after invoking Knight may follow a real roll. */
    }
    const card = await waitFor(
      () => stampedCard(req.eventId, FOLLOWUP_LANE),
      CHAT_HOOKS,
      KNIGHT_STAMP_MS,
    );
    const result =
      card && (laneFlags(card)?.result as KnightFollowupResultV1 | undefined);
    if (!result) throw unknownOutcome();
    return result;
  } finally {
    clearTimeout(timer);
    disarm();
  }
}

export const knightFollowupV1: Procedure = async (payload) => {
  const req = validateKnightFollowupV1(payload);
  assertKnightUpsertAuthority(PROCEDURE);
  const pending = runOnce<KnightFollowupResultV1>(
    FOLLOWUP_LANE,
    req.eventId,
    (r) => ({ ...r, alreadyRolled: true }),
    () => oneAtATime(() => followup(req)),
  );
  const result = await within(pending, 8_000);
  if (!result) throw unknownOutcome();
  return result;
};
