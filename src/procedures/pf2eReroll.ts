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
  messages,
  newDocumentId,
  runOnce,
  stampedCard,
  type CardMessage,
} from "./chatCards.js";
import { oneAtATime } from "./knightRollLane.js";
import {
  CHECK_LANE,
  dcValueOf,
  replayed,
  rollResult,
  secretMode,
  supportsPf2eCheckV1Runtime,
  type CheckRoll,
  type Pf2eCheckResultV1,
  type Pf2eCheckStampV1,
} from "./pf2eCheck.js";

/**
 * `pf2e.reroll.v1`: a Hero Point reroll of a check Foundry rolled for the app
 * (`pf2e.check.v1`), rerolled by pf2e itself (`Check.rerollFromMessage`, which
 * deletes the source card and posts its own reroll card). The app spends the
 * Hero Point; this lane never passes pf2e a resource, so Foundry spends
 * nothing. A one-shot `preCreateChatMessage` hook stamps pf2e's replacement at
 * birth with the reroll's eventId and result (lane `pf2e.check`, `rerollOf`
 * the source's eventId) and gives it the source's author, whisper and blind.
 *
 * Source-derived (pf2e 8.7.0, the same in 8.5.1 / 8.6.1), seen on a live
 * Foundry 14 world: the replacement's `flags.pf2e.context.isReroll` is true,
 * its `outcome` is recomputed against the source's DC, but its
 * `unadjustedOutcome` is the source roll's, so this lane recomputes it.
 */

export const PROCEDURE = "pf2e.reroll.v1";

const PAYLOAD_KEYS = ["eventId", "origin", "actorId", "sourceEventId"] as const;
const ORIGINS = ["app", "player"] as const;
const DEGREES = [
  "criticalFailure",
  "failure",
  "success",
  "criticalSuccess",
] as const;
type Degree = (typeof DEGREES)[number];

export interface Pf2eRerollV1 {
  eventId: string;
  origin: (typeof ORIGINS)[number];
  actorId: string;
  sourceEventId: string;
}

/** A chat message as this lane reads it: Foundry keeps the author's id, the
 * whisper and blind in the source. */
export interface Message extends CardMessage {
  _source?: { author?: string; whisper?: string[]; blind?: boolean };
  whisper?: string[];
  blind?: boolean;
}

/** pf2e's `Check`, with the one member this lane calls. */
interface Pf2eCheck {
  rerollFromMessage?(message: unknown, options: Dict): Promise<void>;
}

export function validatePf2eRerollV1(payload: unknown): Pf2eRerollV1 {
  const p = record(payload, "payload", PAYLOAD_KEYS);
  for (const key of PAYLOAD_KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  const req = {
    eventId: identifier(p.eventId, "eventId", uuid),
    origin: oneOf(p.origin, "origin", ORIGINS),
    actorId: identifier(p.actorId, "actorId", documentId),
    sourceEventId: identifier(p.sourceEventId, "sourceEventId", uuid),
  };
  if (req.eventId === req.sourceEventId)
    invalid("eventId must differ from sourceEventId");
  return req;
}

function checkApi(): Pf2eCheck | undefined {
  return foundryGame()?.pf2e?.Check as Pf2eCheck | undefined;
}

/** Registration gate: the check lane's, with pf2e's reroll. */
export function supportsPf2eRerollV1Runtime(): boolean {
  return (
    supportsPf2eCheckV1Runtime() &&
    typeof checkApi()?.rerollFromMessage === "function"
  );
}

const dictAt = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null ? (v as Dict)[key] : undefined;

const contextOf = (m: CardMessage): Dict =>
  (dictAt(m.flags?.pf2e, "context") ?? {}) as Dict;

function refused(why: string): RpcError {
  return new RpcError("reroll_refused", `${PROCEDURE}: ${why}`);
}

/** pf2e's degree of success of `total` against `dc`, before any adjustment:
 * ±10 for a critical, then a natural 20 / 1 one step up / down. */
export function unadjustedDegree(
  total: number,
  kept: number,
  dc: number,
): Degree {
  let step = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
  if (kept === 20) step = Math.min(3, step + 1);
  if (kept === 1) step = Math.max(0, step - 1);
  return DEGREES[step];
}

/** A roll as Foundry keeps it on a card: a Roll, or its serialized data. */
function rollOf(raw: unknown): CheckRoll {
  const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as
    (CheckRoll & { terms?: unknown[] }) | null;
  if (!r) return {};
  if (r.dice) return r;
  return {
    total: r.total,
    dice: (r.terms ?? []).filter(
      (t) => typeof dictAt(t, "faces") === "number",
    ) as CheckRoll["dice"],
  };
}

/** The reply, read from pf2e's replacement card at its birth. */
function rerollResult(
  doc: CardMessage,
  messageId: string,
  degreeSource: "dc" | "target" | null,
  messageMode: Pf2eCheckResultV1["messageMode"],
): Pf2eCheckStampV1 {
  const context = contextOf(doc);
  const result = rollResult(
    rollOf(doc.rolls?.[0]),
    context,
    messageId,
    degreeSource,
    secretMode(context) ?? messageMode,
  );
  if (result.degree === null) return result;
  // pf2e leaves the source roll's `unadjustedOutcome` on its reroll card.
  const dc = dictAt(context.dc, "value");
  return {
    ...result,
    unadjustedDegree:
      typeof dc === "number"
        ? unadjustedDegree(result.total, result.kept, dc)
        : result.degree,
  };
}

/** The visibility a card was posted with, as the check reply names it. */
export function modeOf(m: Message): Pf2eCheckResultV1["messageMode"] {
  const whisper = m._source?.whisper ?? m.whisper ?? [];
  return (m._source?.blind ?? m.blind)
    ? "blind"
    : whisper.length
      ? "gm"
      : "public";
}

async function reroll(req: Pf2eRerollV1): Promise<Pf2eCheckResultV1> {
  const source = stampedCard(req.sourceEventId, CHECK_LANE) as
    Message | undefined;
  if (!source || source.speaker?.actor !== req.actorId)
    throw new RpcError(
      "source_not_found",
      `${PROCEDURE}: no check card of that actor carries sourceEventId`,
    );
  if (contextOf(source).isReroll === true)
    throw refused("a reroll is not rerolled");

  const stored = dictAt(laneFlags(source), "result");
  const ds = dictAt(stored, "degreeSource");
  const degreeSource = ds === "dc" || ds === "target" ? ds : null;
  const mode = dictAt(stored, "messageMode");
  const messageMode =
    mode === "public" || mode === "gm" || mode === "blind"
      ? mode
      : modeOf(source);
  // Read now: pf2e deletes the source before it posts the replacement.
  const author = source._source?.author;
  const whisper = [...(source._source?.whisper ?? source.whisper ?? [])];
  const blind = source._source?.blind ?? source.blind ?? false;

  const hooks = foundryHooks();
  if (!hooks)
    throw new RpcError(
      "unsupported_runtime",
      `${PROCEDURE}: Foundry Hooks are unavailable`,
    );
  let result: Pf2eCheckStampV1 | undefined;
  let dcValue: number | null = null;
  let failure: unknown;
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
        contextOf(doc).isReroll !== true ||
        doc.speaker?.actor !== req.actorId
      )
        return;
      disarm();
      try {
        const messageId = newDocumentId();
        result = rerollResult(doc, messageId, degreeSource, messageMode);
        dcValue = dcValueOf(contextOf(doc));
        // The card keeps the id its stamped result names.
        options.keepId = true;
        doc.updateSource?.({
          _id: messageId,
          ...(author ? { author } : {}),
          whisper,
          blind,
          [`flags.${MODULE_ID}`]: {
            eventId: req.eventId,
            origin: req.origin,
            lane: CHECK_LANE,
            rerollOf: req.sourceEventId,
            result,
          },
        });
      } catch (error) {
        result = undefined;
        failure = error;
      }
    },
  );
  const timer = setTimeout(disarm, REQUEST_TIMEOUT_MS);
  try {
    await checkApi()!.rerollFromMessage!(source, { keep: "new" });
  } finally {
    clearTimeout(timer);
    disarm();
  }
  const card = stampedCard(req.eventId, CHECK_LANE);
  if (result && card) return { ...result, dcValue };
  if (!failure && messages().includes(source))
    throw refused("pf2e did not reroll the card");
  throw new RpcError(
    "procedure_failed",
    `${PROCEDURE}: the source card changed but no stamped reroll card appeared`,
  );
}

export const pf2eRerollV1: Procedure = (payload) => {
  const req = validatePf2eRerollV1(payload);
  assertLaneAuthority(
    PROCEDURE,
    supportsPf2eRerollV1Runtime,
    `${PF2E_RESOURCES_REQUIREMENT} with game.pf2e.Check.rerollFromMessage`,
  );
  return runOnce<Pf2eCheckResultV1>(
    CHECK_LANE,
    req.eventId,
    replayed(CHECK_LANE, req.eventId),
    // One reroll at a time: the hook knows pf2e's card by its actor only.
    () => oneAtATime(() => reroll(req)),
  );
};
