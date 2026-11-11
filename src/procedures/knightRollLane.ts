import { MODULE_ID, REQUEST_TIMEOUT_MS } from "../constants.js";
import { foundryHooks, type Dict } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import { log } from "../util/log.js";
import { waitFor, within } from "../util/wait.js";
import { stampedCard, type CardMessage } from "./chatCards.js";
import { flagValue } from "./upsertShared.js";

/**
 * What the Knight lanes that run the system's own roller share: one roll at
 * a time, the hook that stamps the roller's card with the app's event id, the
 * replay of a card already stamped, the join of a call still rolling, and the
 * dice read from a card.
 */

/** How long a card is still watched for, after the roll, to stamp it. */
// ponytail: a card whose flags land after this is never stamped; widen it if
// a slower roller ever shows up.
export const KNIGHT_STAMP_MS = 60_000;
/** The chat events after which a card may have changed. */
export const CHAT_HOOKS = ["createChatMessage", "updateChatMessage"] as const;

export interface RollLike {
  formula?: string;
  total?: number;
  dice?: { results?: { result: number; active?: boolean }[] }[];
  terms?: { results?: { result: number; active?: boolean }[] }[];
}

export type RollState = "normal" | "exploit" | "epicFail";

// ------------------------------------------------------------------- dice

export function facesOf(roll: unknown): number[] {
  const r = (
    typeof roll === "string" ? (JSON.parse(roll) as unknown) : roll
  ) as RollLike | null;
  const terms = r?.dice?.length ? r.dice : (r?.terms ?? []);
  return terms.flatMap((t) =>
    (t.results ?? []).filter((x) => x.active !== false).map((x) => x.result),
  );
}

const evens = (faces: number[]) => faces.filter((f) => f % 2 === 0).length;

/** The dice of a Knight card: the first roll is the pool; no odd die means
 * the next one is its Exploit reroll; no even die is a critical failure. */
export function diceOf(message: CardMessage): {
  faces: number[];
  exploitFaces: number[] | null;
  successes: number;
  rollState: RollState;
} {
  const rolls = message.rolls ?? [];
  const faces = rolls.length ? facesOf(rolls[0]) : [];
  const exploit = faces.length > 0 && faces.every((f) => f % 2 === 0);
  const exploitFaces = exploit && rolls[1] ? facesOf(rolls[1]) : null;
  const successes = evens(faces) + evens(exploitFaces ?? []);
  return {
    faces,
    exploitFaces,
    successes,
    rollState: exploit
      ? "exploit"
      : faces.length > 0 && successes === 0
        ? "epicFail"
        : "normal",
  };
}

// ------------------------------------------------------------ the stamp

/** Whether `doc` is the card of a `dice`-die roll: the roller's first roll
 * is the pool itself (`${dice}D6`), so a roll of another size from the same
 * actor is not this call's card. */
// ponytail: a GM's own roll of the same actor with the same pool, made while an
// app roll that posted no card still waits, would match; the system gives the
// card no other mark before it exists.
function rollsPool(doc: CardMessage, dice: number): boolean {
  try {
    return !!doc.rolls?.length && facesOf(doc.rolls[0]).length === dice;
  } catch {
    return false;
  }
}

/** The unfired stamping hook of each actor's latest roll. */
const pending = new Map<
  string,
  { id: unknown; timer: ReturnType<typeof setTimeout> }
>();

export function dropHook(actorId: string): void {
  const hook = pending.get(actorId);
  if (!hook) return;
  pending.delete(actorId);
  clearTimeout(hook.timer);
  foundryHooks()?.off?.("preCreateChatMessage", hook.id);
}

/**
 * Lay `changes` over the next card the actor's `dice`-die roll creates. The
 * hook lives until it fires or the late-stamp window closes, so a card
 * created after the answer still carries its eventId. A new roll for the same
 * actor drops an older unfired hook first: that older card, if it ever comes,
 * imports as ordinary chat.
 */
export function armStamp(
  actorId: string,
  dice: number,
  changes: Dict,
): () => void {
  dropHook(actorId);
  const hookId = foundryHooks()?.on(
    "preCreateChatMessage",
    (doc: CardMessage) => {
      if (
        doc.speaker?.actor !== actorId ||
        pending.get(actorId)?.id !== hookId ||
        !rollsPool(doc, dice)
      )
        return;
      dropHook(actorId);
      doc.updateSource?.(changes);
    },
  );
  if (hookId !== undefined)
    pending.set(actorId, {
      id: hookId,
      timer: setTimeout(() => dropHook(actorId), KNIGHT_STAMP_MS),
    });
  // Drops this hook only: a later roll of the actor may have armed its own.
  return () => {
    if (hookId !== undefined && pending.get(actorId)?.id === hookId)
      dropHook(actorId);
  };
}

/** The module's flags on a card: the app's event, its origin and lane. */
export function stampFlags(
  eventId: string,
  origin: string,
  lane: string,
): Dict {
  return { [`flags.${MODULE_ID}`]: { eventId, origin, lane } };
}

/** Store `result` on the card under `flagKey`; a failed write is logged. */
export async function stampResult<T>(
  message: CardMessage,
  flagKey: string,
  result: T,
): Promise<T> {
  try {
    await message.setFlag?.(MODULE_ID, flagKey, result);
  } catch (error) {
    log.warn(`${flagKey}: could not stamp the result`, error);
  }
  return result;
}

// ------------------------------------------------------------ idempotency

function storedResult<T>(message: CardMessage, flagKey: string): T | null {
  const value = flagValue(message, flagKey);
  return typeof value === "object" && value !== null ? (value as T) : null;
}

/** A retry of a roll already on the chat: its stored result, else the one
 * `rebuild` reads once the card is `ready`; never a new roll. */
export async function replay<T extends object>(
  lane: string,
  eventId: string,
  flagKey: string,
  ready: (card: CardMessage) => boolean,
  rebuild: (card: CardMessage) => T,
  waitMs: number,
  timeout: () => RpcError,
): Promise<T> {
  const card = await waitFor(
    () => {
      const c = stampedCard(eventId, lane);
      return c && (storedResult(c, flagKey) || ready(c)) ? c : null;
    },
    CHAT_HOOKS,
    waitMs,
  );
  if (!card) throw timeout();
  const result =
    storedResult<T>(card, flagKey) ??
    (await stampResult(card, flagKey, rebuild(card)));
  return { ...result, alreadyRolled: true };
}

/** Rolls whose card may still land, by lane and eventId: settles with the
 * result once the card is stamped, or null when no card is coming. */
const rolling = new Map<string, Promise<object | null>>();

/** Record a roll in flight until `done` settles. */
export function track(
  lane: string,
  eventId: string,
  done: Promise<object | null>,
): void {
  const key = `${lane}|${eventId}`;
  rolling.set(key, done);
  void done.finally(() => {
    if (rolling.get(key) === done) rolling.delete(key);
  });
}

/** A retry while the same roll is still on its way: join it, never roll
 * again. Undefined when nothing of that eventId is in flight. */
export async function join<T extends object>(
  lane: string,
  eventId: string,
  waitMs: number,
  timeout: () => RpcError,
): Promise<T | undefined> {
  const inFlight = rolling.get(`${lane}|${eventId}`) as
    Promise<T | null> | undefined;
  if (!inFlight) return undefined;
  const result = await within(inFlight, waitMs);
  if (!result) throw timeout();
  return { ...result, alreadyRolled: true };
}

// ------------------------------------------------------------------ queue

let queue: Promise<unknown> = Promise.resolve();

/** One Knight roll at a time, across the lanes: the scoped stamp hook is per
 * actor. A roll that never settles holds the queue only as long as the
 * backend waits for an answer, so it cannot block every later roll. */
export function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const started = queue.then(run);
  queue = queue.then(() =>
    within(
      started.catch(() => null),
      REQUEST_TIMEOUT_MS,
    ),
  );
  return started;
}
