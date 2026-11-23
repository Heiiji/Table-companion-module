import { MODULE_ID } from "../constants.js";
import {
  chatMessageImplementation,
  foundryGame,
  type Dict,
  type UserLike,
} from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import { isServiceUserId } from "../setup/identity.js";
import { contentsOf, type ActorLike } from "./upsertShared.js";

/**
 * What the lanes that post a system's own chat card on the app's behalf share:
 * the chat log, the module's stamp on a card, the card's author and its
 * visibility.
 */

/** A chat message, as the card lanes read and stamp it. */
export interface CardMessage {
  id?: string;
  flags?: Dict;
  rolls?: unknown[];
  content?: string;
  flavor?: string;
  speaker?: { actor?: string | null };
  getFlag?(namespace: string, key: string): unknown;
  setFlag?(namespace: string, key: string, value: unknown): Promise<unknown>;
  updateSource?(changes: Dict): unknown;
}

export interface TokenObj {
  id: string;
  document?: { actorId?: string | null };
}

export interface Player extends UserLike {
  character?: { id?: string } | string | null;
  targets?: Iterable<TokenObj>;
}

export type CardVisibility = "public" | "gm" | "blind" | "self";

export function messages(): CardMessage[] {
  return (foundryGame()?.messages?.contents ?? []) as CardMessage[];
}

export function laneFlags(message: CardMessage): Dict | undefined {
  const ns = message.flags?.[MODULE_ID];
  return typeof ns === "object" && ns !== null ? (ns as Dict) : undefined;
}

/** The card a lane stamped with `eventId`, if it is on the chat. */
export function stampedCard(
  eventId: string,
  lane: string,
): CardMessage | undefined {
  return messages().find((m) => {
    const ns = laneFlags(m);
    return ns?.eventId === eventId && ns.lane === lane;
  });
}

/** The people at the table: not a GM, not the app's service user. */
export function players(): Player[] {
  return (contentsOf(foundryGame()?.users) as Player[]).filter(
    (u) => !u.isGM && !isServiceUserId(u.id),
  );
}

export function characterOf(user: Player): string | undefined {
  const c = user.character;
  return typeof c === "string" ? c : (c?.id ?? undefined);
}

/** The PC's player (the user whose character it is), else an active owner. */
export function playerOf(actor: ActorLike): Player | undefined {
  const all = players();
  return (
    all.find((u) => characterOf(u) === actor.id) ??
    all.find((u) => u.active && actor.testUserPermission?.(u, "OWNER") === true)
  );
}

/**
 * The card's author: the PC's player, except on a GM-only card, which the
 * responder GM authors (no `author`: Foundry takes the current user), since
 * Foundry shows a whispered card's content to its author. A player's own GM
 * roll (`playerRoll`) keeps the player, as Foundry's private GM roll does.
 */
export function cardAuthor(
  actor: ActorLike,
  visibility: CardVisibility,
  playerRoll: boolean,
): Player | undefined {
  return visibility === "gm" && !playerRoll ? undefined : playerOf(actor);
}

/** The card's visibility, in place of the GM's own roll mode. */
export function visibilityOf(
  visibility: CardVisibility,
  authorId: string,
): { whisper: string[]; blind: boolean } {
  if (visibility === "public") return { whisper: [], blind: false };
  // Every whispered card also reaches the service user, so the backend, which
  // reads the world as that user, sees the card and its result even when the
  // reply was lost; a blind roll stays blind.
  const users = contentsOf(foundryGame()?.users);
  const service = users
    .filter((u) => u.id && isServiceUserId(u.id) && u.id !== authorId)
    .map((u) => u.id as string);
  if (visibility === "self")
    return { whisper: [authorId, ...service], blind: false };
  const readers = users
    .filter((u) => u.id && (u.isGM || isServiceUserId(u.id)))
    .map((u) => u.id as string);
  return { whisper: readers, blind: visibility === "blind" };
}

// ------------------------------------------------- cards built unposted

const ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh id in Foundry's randomID(16) shape, so a card's stamped result can
 * name the message before it exists. */
export function newDocumentId(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => ID_CHARS[b % ID_CHARS.length],
  ).join("");
}

/**
 * « Build unposted, then create »: the source of a card a system built
 * without posting it (`createMessage: false` / `create: false`), with
 * `changes` laid over it, created once under the id the changes give.
 * Assumed, not yet seen on a live world: Foundry 14 accepts that source
 * unchanged. Undefined when Foundry created nothing (a hook vetoed it).
 */
export async function postUnposted(
  source: Dict,
  changes: Dict & { _id: string },
): Promise<CardMessage | undefined> {
  const ChatMessage = chatMessageImplementation();
  if (!ChatMessage)
    throw new RpcError(
      "unsupported_runtime",
      "Foundry ChatMessage.implementation is unavailable",
    );
  const created = await ChatMessage.create(
    { ...source, ...changes },
    { keepId: true },
  );
  return (created ?? undefined) as CardMessage | undefined;
}

// ------------------------------------------------------------ idempotency

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run a card lane's call once per `eventId`: a card already stamped with it
 * answers its stored result through `again`, a call still running is joined
 * (also through `again`), and only otherwise does `run` roll or post.
 */
export function runOnce<T extends object>(
  lane: string,
  eventId: string,
  again: (result: T) => T,
  run: () => Promise<T>,
): Promise<T> {
  const card = stampedCard(eventId, lane);
  if (card) {
    const stored = laneFlags(card)?.result;
    if (typeof stored !== "object" || stored === null)
      return Promise.reject(
        new RpcError(
          "procedure_failed",
          `${lane}: the stamped card carries no result`,
        ),
      );
    return Promise.resolve(again(stored as T));
  }
  const key = `${lane}|${eventId}`;
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running.then(again);
  const started = run().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}
