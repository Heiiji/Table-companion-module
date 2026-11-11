import { foundryGame } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { waitFor } from "../util/wait.js";
import {
  actorCollection,
  assertKnightUpsertAuthority,
  documentId,
  identifier,
  integer,
  invalid,
  list,
  oneOf,
  record,
  supportsKnightActorUpsertV1Runtime,
  text,
  uuid,
} from "./upsertShared.js";
import {
  playerOf,
  stampedCard,
  visibilityOf,
  type CardMessage,
} from "./chatCards.js";
import {
  CHAT_HOOKS,
  armStamp,
  diceOf,
  join,
  oneAtATime,
  replay,
  stampFlags,
  stampResult,
  track,
  type RollState,
} from "./knightRollLane.js";

/**
 * `knight.test.v1`: a Knight test the app started (no weapon), run by the
 * Knight system's own roller (`game.knight.RollKnight`) in the responder GM's
 * browser, so the native card appears with its successes, Exploit or
 * critical failure and, with a difficulty, its verdict. The app composes the
 * pool (dice, flat successes, characteristics, difficulty); the system
 * supplies the dice. No cost is spent here: the roller gets no updates.
 *
 * Idempotent by `eventId`: a card already stamped with it answers its stored
 * result with `alreadyRolled: true`, and the test is never rolled twice.
 */

export const PROCEDURE = "knight.test.v1";
export const TEST_LANE = "knight.test";
/** How long the call waits for the stamped card once the roller returned. */
export const TEST_WAIT_MS = 8_000;

const PAYLOAD_KEYS = [
  "eventId",
  "origin",
  "actorId",
  "label",
  "dice",
  "bonus",
  "carac",
  "difficulty",
  "visibility",
] as const;

const ORIGINS = ["app", "player"] as const;
const VISIBILITIES = ["public", "gm", "blind", "self"] as const;

export interface KnightTestV1 {
  eventId: string;
  origin: (typeof ORIGINS)[number];
  actorId: string;
  label: string;
  dice: number;
  bonus: number[];
  carac: string[];
  difficulty: number;
  visibility: (typeof VISIBILITIES)[number];
}

export interface KnightTestResultV1 {
  messageId: string;
  alreadyRolled: boolean;
  faces: number[];
  exploitFaces: number[] | null;
  successes: number;
  bonus: number;
  total: number;
  rollState: RollState;
}

type RollKnightClass = new (
  actor: unknown,
  data: Record<string, unknown>,
) => { doRoll(updates: Record<string, unknown>): Promise<unknown> };

/** The strict payload: every key required, unknown keys refused. */
export function validateKnightTestV1(payload: unknown): KnightTestV1 {
  const p = record(payload, "payload", PAYLOAD_KEYS);
  for (const key of PAYLOAD_KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  const carac = list(p.carac, "carac", 6).map((c, i) =>
    text(c, `carac[${i}]`, 40, true),
  );
  if (!carac.length) invalid("carac needs at least one characteristic");
  return {
    eventId: identifier(p.eventId, "eventId", uuid),
    origin: oneOf(p.origin, "origin", ORIGINS),
    actorId: identifier(p.actorId, "actorId", documentId),
    label: text(p.label, "label", 120, true),
    dice: integer(p.dice, "dice", 1, 60),
    bonus: list(p.bonus, "bonus", 10).map((b, i) =>
      integer(b, `bonus[${i}]`, 0, 30),
    ),
    carac,
    difficulty: integer(p.difficulty, "difficulty", 0, 99),
    visibility: oneOf(p.visibility, "visibility", VISIBILITIES),
  };
}

/** The Knight roller, when it has the one member this lane calls. */
export function rollKnightTestClass(): RollKnightClass | undefined {
  const RollKnight = foundryGame()?.knight?.RollKnight as
    { prototype?: { doRoll?: unknown } } | undefined;
  return typeof RollKnight?.prototype?.doRoll === "function"
    ? (RollKnight as unknown as RollKnightClass)
    : undefined;
}

/** Registration gate: the Knight lanes' runtime floor plus the roller. */
export function supportsKnightTestV1Runtime(): boolean {
  return supportsKnightActorUpsertV1Runtime() && !!rollKnightTestClass();
}

function cardTimeout(): RpcError {
  return new RpcError(
    "test_card_timeout",
    `${PROCEDURE}: the Knight card did not appear within ${TEST_WAIT_MS} ms`,
  );
}

/** The result of a test card: its dice and the request's flat successes. */
export function buildTestResult(
  message: CardMessage,
  bonus: number[],
): KnightTestResultV1 {
  const dice = diceOf(message);
  const flat = bonus.reduce((a, b) => a + b, 0);
  return {
    messageId: message.id ?? "",
    alreadyRolled: false,
    faces: dice.faces,
    exploitFaces: dice.exploitFaces,
    successes: dice.successes,
    bonus: flat,
    total: dice.successes + flat,
    rollState: dice.rollState,
  };
}

async function test(req: KnightTestV1): Promise<KnightTestResultV1> {
  assertKnightUpsertAuthority(PROCEDURE);
  const RollKnight = rollKnightTestClass();
  if (!RollKnight)
    throw new RpcError(
      "knight_api_missing",
      `${PROCEDURE}: game.knight.RollKnight is unavailable`,
    );
  if (stampedCard(req.eventId, TEST_LANE))
    return replay(
      TEST_LANE,
      req.eventId,
      "testResult",
      (card) => !!card.rolls?.length,
      (card) => buildTestResult(card, req.bonus),
      TEST_WAIT_MS,
      cardTimeout,
    );
  const joined = await join<KnightTestResultV1>(
    TEST_LANE,
    req.eventId,
    TEST_WAIT_MS,
    cardTimeout,
  );
  if (joined) return joined;

  const actor = actorCollection().get(req.actorId);
  if (!actor)
    throw new RpcError("actor_not_found", `${PROCEDURE}: no such Actor`);
  // The roller rolls a vehicle's pilot, not the vehicle.
  if (actor.type === "vehicule")
    throw new RpcError(
      "actor_unsupported",
      `${PROCEDURE}: a vehicle's tests are its pilot's`,
    );
  const author = playerOf(actor);
  const authorId = author?.id ?? foundryGame()?.user?.id ?? "";
  const { whisper, blind } = visibilityOf(req.visibility, authorId);
  const disarm = armStamp(req.actorId, req.dice, {
    ...(author?.id ? { author: author.id } : {}),
    whisper,
    blind,
    ...stampFlags(req.eventId, req.origin, TEST_LANE),
  });

  let settle!: (result: KnightTestResultV1 | null) => void;
  const done = new Promise<KnightTestResultV1 | null>((r) => (settle = r));
  track(TEST_LANE, req.eventId, done);
  try {
    const localize = (key: string) => foundryGame()?.i18n?.localize(key) ?? key;
    await new RollKnight(actor, {
      name: req.label,
      dices: `${req.dice}D6`,
      carac: req.carac,
      bonus: req.bonus,
      difficulte: req.difficulty || undefined,
      tags: req.difficulty
        ? [
            {
              key: "difficulte",
              label: `${localize("KNIGHT.AUTRE.Difficulte")} : ${req.difficulty}`,
            },
          ]
        : [],
    }).doRoll({});
  } catch (error) {
    settle(null);
    throw error;
  } finally {
    // A plain test's card is created before doRoll returns: a hook still
    // armed now could only stamp some other roll.
    disarm();
  }
  const card = await waitFor(
    () => stampedCard(req.eventId, TEST_LANE),
    CHAT_HOOKS,
    TEST_WAIT_MS,
  );
  if (!card) {
    settle(null);
    throw cardTimeout();
  }
  const result = await stampResult(
    card,
    "testResult",
    buildTestResult(card, req.bonus),
  );
  settle(result);
  return result;
}

/** One Knight roll at a time (attacks and tests share the stamp hook). */
export const knightTestV1: Procedure = (payload) => {
  const req = validateKnightTestV1(payload);
  return oneAtATime(() => test(req));
};
