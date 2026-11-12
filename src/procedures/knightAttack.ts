import { canvasTokens, foundryGame, type Dict } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { log } from "../util/log.js";
import { waitFor, within } from "../util/wait.js";
import {
  FLAG_KEYS,
  actorCollection,
  assertKnightUpsertAuthority,
  contentsOf,
  documentId,
  flagValue,
  identifier,
  integer,
  invalid,
  list,
  oneOf,
  record,
  supportsKnightActorUpsertV1Runtime,
  text,
  uuid,
  type ActorLike,
} from "./upsertShared.js";
import {
  characterOf,
  playerOf,
  players,
  stampedCard,
  visibilityOf,
  type CardMessage,
  type Player,
  type TokenObj,
} from "./chatCards.js";
import {
  CHAT_HOOKS,
  KNIGHT_STAMP_MS,
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

export { laneFlags, messages, type CardMessage } from "./chatCards.js";
export { facesOf, type RollLike } from "./knightRollLane.js";

/**
 * `knight.attack.v1`: a weapon attack the app started, run by the Knight
 * system's own roller (`game.knight.RollKnight`) in the responder GM's browser,
 * so the native card appears with its targets, per-target verdict and effects
 * and the damage / violence buttons. The app composes the pool (dice, flat
 * successes, characteristics, style); the system supplies the weapon (the Item
 * bound by `entryId`), the targets' scores, the dice and the effects. No cost
 * is spent here: the app spends energy and hope itself.
 *
 * Idempotent by `eventId`: a card already stamped with it answers its stored
 * result with `alreadyRolled: true`, and the attack is never rolled twice.
 */

export const PROCEDURE = "knight.attack.v1";
export const ATTACK_LANE = "knight.attack";
/** How long the call waits for the card's Knight flags before answering. */
export const ATTACK_WAIT_MS = 8_000;
/** How long the card is still watched, after an unanswered call, to stamp its
 * result for a later import. */
export const ATTACK_STAMP_MS = KNIGHT_STAMP_MS;

const STYLE_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const PAYLOAD_KEYS = [
  "eventId",
  "origin",
  "actorId",
  "entryId",
  "label",
  "dice",
  "bonus",
  "carac",
  "style",
  "surprise",
  "targetActorIds",
  "visibility",
] as const;

const ORIGINS = ["app", "player"] as const;
const VISIBILITIES = ["public", "gm", "blind", "self"] as const;
/** Weapon effects whose roll reads the GM's own targets, not the injected ones. */
const READS_USER_TARGETS = ["cadence", "chromeligneslumineuses"];

export interface KnightAttackV1 {
  eventId: string;
  origin: (typeof ORIGINS)[number];
  actorId: string;
  entryId: string;
  label: string;
  dice: number;
  bonus: number[];
  carac: string[];
  style: string;
  surprise: boolean;
  targetActorIds: string[];
  visibility: (typeof VISIBILITIES)[number];
}

export type TargetSource = "player" | "app" | "gm" | "none";

export interface KnightAttackTargetV1 {
  tokenId: string;
  actorId: string | null;
  name: string;
  versus: "defense" | "reaction" | null;
  difficulty: number;
  hit: boolean;
  margin: number | null;
  weakPoint: boolean;
  effects: string[];
}

export interface KnightAttackResultV1 {
  messageId: string;
  alreadyRolled: boolean;
  faces: number[];
  exploitFaces: number[] | null;
  successes: number;
  bonus: number;
  total: number;
  rollState: RollState;
  targetSource: TargetSource;
  targets: KnightAttackTargetV1[];
}

// ------------------------------------------------------- structural views

interface TokenLayer {
  get(id: string): TokenObj | undefined;
  placeables?: TokenObj[];
  setTargets?(ids: string[], options?: { mode?: string }): void;
}

interface Weapon {
  options?: { value?: string; active?: boolean }[];
  effets?: { raw?: string[] };
  structurelles?: { raw?: string[] };
  ornementales?: { raw?: string[] };
  distance?: { raw?: string[] };
}

interface RollKnightInstance {
  prepareWpnContact(item: unknown, modules: unknown): Weapon;
  prepareWpnDistance(item: unknown, modules: unknown): Weapon;
  doRoll(updates: Dict): Promise<unknown>;
}

type RollKnightClass = new (actor: unknown, data: Dict) => RollKnightInstance;

interface KnightTarget {
  id?: string;
  name?: string;
  difficulty?: number;
  hit?: boolean;
  marge?: number;
  ptsFaible?: boolean;
  defense?: string;
  effets?: { label?: unknown; hit?: unknown }[];
}

// ------------------------------------------------------------- validation

/** The strict payload: every key required, unknown keys refused. */
export function validateKnightAttackV1(payload: unknown): KnightAttackV1 {
  const p = record(payload, "payload", PAYLOAD_KEYS);
  for (const key of PAYLOAD_KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  if (typeof p.surprise !== "boolean") invalid("surprise must be a boolean");
  return {
    eventId: identifier(p.eventId, "eventId", uuid),
    origin: oneOf(p.origin, "origin", ORIGINS),
    actorId: identifier(p.actorId, "actorId", documentId),
    entryId: identifier(p.entryId, "entryId", uuid),
    label: text(p.label, "label", 120, true),
    dice: integer(p.dice, "dice", 1, 60),
    bonus: list(p.bonus, "bonus", 10).map((b, i) =>
      integer(b, `bonus[${i}]`, 0, 30),
    ),
    carac: list(p.carac, "carac", 6).map((c, i) =>
      text(c, `carac[${i}]`, 40, true),
    ),
    style: identifier(p.style, "style", STYLE_KEY),
    surprise: p.surprise as boolean,
    targetActorIds: list(p.targetActorIds, "targetActorIds", 20).map((id, i) =>
      identifier(id, `targetActorIds[${i}]`, documentId),
    ),
    visibility: oneOf(p.visibility, "visibility", VISIBILITIES),
  };
}

// ---------------------------------------------------------------- runtime

/** The Knight roller, when it has every member this lane calls. */
export function rollKnightClass(): RollKnightClass | undefined {
  const RollKnight = foundryGame()?.knight?.RollKnight as
    { prototype?: Partial<RollKnightInstance> } | undefined;
  const proto = RollKnight?.prototype;
  return typeof proto?.prepareWpnContact === "function" &&
    typeof proto.prepareWpnDistance === "function" &&
    typeof proto.doRoll === "function"
    ? (RollKnight as unknown as RollKnightClass)
    : undefined;
}

/** Registration gate: the Knight lanes' runtime floor plus the roller. */
export function supportsKnightAttackV1Runtime(): boolean {
  return supportsKnightActorUpsertV1Runtime() && !!rollKnightClass();
}

function tokens(): TokenLayer | undefined {
  return canvasTokens() as TokenLayer | undefined;
}

function cardOf(eventId: string): CardMessage | undefined {
  return stampedCard(eventId, ATTACK_LANE);
}

export function knightFlags(message: CardMessage): Dict | undefined {
  const knight = message.flags?.knight;
  return typeof knight === "object" && knight !== null
    ? (knight as Dict)
    : undefined;
}

function onCanvas(ids: Iterable<string>): string[] {
  const layer = tokens();
  return [...new Set(ids)].filter((id) => !!layer?.get(id));
}

/** The first non-empty source wins: the PC's player, the app chip, the GM. */
function resolveTargets(
  actor: ActorLike,
  targetActorIds: string[],
): { ids: string[]; source: TargetSource } {
  const owner = players().find((u) => u.active && characterOf(u) === actor.id);
  const fromPlayer = onCanvas([...(owner?.targets ?? [])].map((t) => t.id));
  if (fromPlayer.length) return { ids: fromPlayer, source: "player" };
  const placeables = tokens()?.placeables ?? [];
  const fromApp = targetActorIds.flatMap((actorId) => {
    const token = placeables.find((t) => t.document?.actorId === actorId);
    return token ? [token.id] : [];
  });
  if (fromApp.length) return { ids: onCanvas(fromApp), source: "app" };
  const fromGm = onCanvas(
    [...((foundryGame()?.user as Player | undefined)?.targets ?? [])].map(
      (t) => t.id,
    ),
  );
  return fromGm.length
    ? { ids: fromGm, source: "gm" }
    : { ids: [], source: "none" };
}

function readsUserTargets(weapon: Weapon): boolean {
  const raw = [
    ...(weapon.effets?.raw ?? []),
    ...(weapon.structurelles?.raw ?? []),
    ...(weapon.ornementales?.raw ?? []),
    ...(weapon.distance?.raw ?? []),
  ];
  return raw.some((e) => READS_USER_TARGETS.includes(e.split(" ")[0] ?? ""));
}

/** Whether the system's `doRoll` treats `name` as active on this weapon: in
 * its effects (base, structural, ornamental), and on unless an option turns it off. */
function effectActive(weapon: Weapon, name: string): boolean {
  const raw = [
    ...(weapon.effets?.raw ?? []),
    ...(weapon.structurelles?.raw ?? []),
    ...(weapon.ornementales?.raw ?? []),
  ];
  if (!raw.some((e) => e.split(" ")[0] === name)) return false;
  const option = weapon.options?.find((o) => o.value === name);
  return !option || option.active === true;
}

function gmTargetIds(): string[] {
  return [...((foundryGame()?.user as Player | undefined)?.targets ?? [])].map(
    (t) => t.id,
  );
}

function cardTimeout(): RpcError {
  return new RpcError(
    "attack_card_timeout",
    `${PROCEDURE}: the Knight card did not complete within ${ATTACK_WAIT_MS} ms`,
  );
}

// ---------------------------------------------------------------- results

/** The result of an attack card whose Knight flags have landed. */
export function buildAttackResult(
  message: CardMessage,
  targetSource: TargetSource,
): KnightAttackResultV1 {
  const knight = knightFlags(message) ?? {};
  const content = (Array.isArray(knight.content) ? knight.content : []) as {
    total?: number;
    targets?: KnightTarget[];
  }[];
  const rollData = (knight.rollData ?? {}) as { bonus?: unknown };
  const bonus = (Array.isArray(rollData.bonus) ? rollData.bonus : [])
    .filter((b): b is number => typeof b === "number")
    .reduce((a, b) => a + b, 0);
  // A cadence card rolls once per target: the first is read.
  const { faces, exploitFaces, successes, rollState } = diceOf(message);
  const first = content[0];
  const total =
    typeof first?.total === "number" ? first.total : successes + bonus;
  const localize = (key: string) => foundryGame()?.i18n?.localize(key) ?? key;
  const vsDefense = localize("KNIGHT.JETS.RESULTATS.VsDefense");
  const vsReaction = localize("KNIGHT.JETS.RESULTATS.VsReaction");
  const surprise = knight.surprise === true;
  const layer = tokens();

  const targets = content
    .flatMap((c) => c.targets ?? [])
    .map((t) => {
      const tokenId = String(t.id ?? "");
      const defense = String(t.defense ?? "");
      const hit = t.hit === true;
      return {
        tokenId,
        actorId: layer?.get(tokenId)?.document?.actorId ?? null,
        name: String(t.name ?? ""),
        versus: surprise
          ? null
          : defense.startsWith(vsDefense)
            ? "defense"
            : defense.startsWith(vsReaction)
              ? "reaction"
              : null,
        difficulty: typeof t.difficulty === "number" ? t.difficulty : 0,
        hit,
        margin: hit && typeof t.marge === "number" ? t.marge : null,
        weakPoint: t.ptsFaible === true,
        // Only what landed: Foundry keeps a resisted effect on the line with `hit: false`.
        effects: (t.effets ?? [])
          .filter((e) => e.hit !== false)
          .map((e) => e.label)
          .filter((l): l is string => typeof l === "string"),
      } satisfies KnightAttackTargetV1;
    });

  return {
    messageId: message.id ?? "",
    alreadyRolled: false,
    faces,
    exploitFaces,
    successes,
    bonus,
    total,
    rollState,
    targetSource,
    targets,
  };
}

/** Build and stamp the result once the card's Knight flags are there. */
function stamp(
  message: CardMessage,
  targetSource: TargetSource,
): Promise<KnightAttackResultV1> {
  return stampResult(
    message,
    "attackResult",
    buildAttackResult(message, targetSource),
  );
}

const flagsLanded = (eventId: string) => {
  const card = cardOf(eventId);
  return card && Array.isArray(knightFlags(card)?.content) ? card : null;
};

async function attack(req: KnightAttackV1): Promise<KnightAttackResultV1> {
  assertKnightUpsertAuthority(PROCEDURE);
  const RollKnight = rollKnightClass();
  if (!RollKnight)
    throw new RpcError(
      "knight_api_missing",
      `${PROCEDURE}: game.knight.RollKnight is unavailable`,
    );
  if (cardOf(req.eventId))
    return replay(
      ATTACK_LANE,
      req.eventId,
      "attackResult",
      (card) => Array.isArray(knightFlags(card)?.content),
      // ponytail: a card left unstamped (the GM reloaded mid-attack) is rebuilt
      // without its target source; stamp it under the card's flags if it matters.
      (card) =>
        buildAttackResult(
          card,
          (knightFlags(card)?.content as { targets?: unknown[] }[])?.some(
            (c) => c.targets?.length,
          )
            ? "gm"
            : "none",
        ),
      ATTACK_WAIT_MS,
      cardTimeout,
    );
  // A retry while this attack's card is still on its way (the first call
  // timed out, its stamping hook still armed): join it, never roll again.
  const joined = await join<KnightAttackResultV1>(
    ATTACK_LANE,
    req.eventId,
    ATTACK_WAIT_MS,
    cardTimeout,
  );
  if (joined) return joined;

  const actor = actorCollection().get(req.actorId);
  if (!actor)
    throw new RpcError("actor_not_found", `${PROCEDURE}: no such Actor`);
  const item = contentsOf(actor.items).find(
    (i) => i.type === "arme" && flagValue(i, FLAG_KEYS.entryId) === req.entryId,
  );
  if (!item)
    throw new RpcError(
      "weapon_not_found",
      `${PROCEDURE}: no weapon bound to that entry`,
    );

  const builder = new RollKnight(actor, {});
  const isRanged =
    (item.system as { type?: unknown } | undefined)?.type === "distance";
  // ponytail: no module bonuses (`modules = {}`): the dialog's module damage
  // and violence bonuses are not applied; pass them here if the app sends them.
  const weapon = isRanged
    ? builder.prepareWpnDistance(item, {})
    : builder.prepareWpnContact(item, {});
  // The request is an attack, never a barrage: turn the option off, as the
  // sheet's roll dialog defaults it (ranged preparation defaults it on). A
  // barrage left active (no option to turn off) posts a card with no attack
  // roll: nothing for the app to resolve, so it stays on the app's engine.
  for (const option of weapon.options ?? [])
    if (option.value === "barrage") option.active = false;
  if (effectActive(weapon, "barrage"))
    throw new RpcError(
      "weapon_unsupported",
      `${PROCEDURE}: a barrage weapon has no attack roll`,
    );
  const { ids, source } = resolveTargets(actor, req.targetActorIds);
  const author = playerOf(actor);
  const authorId = author?.id ?? foundryGame()?.user?.id ?? "";
  const { whisper, blind } = visibilityOf(req.visibility, authorId);

  const disarm = armStamp(req.actorId, req.dice, {
    ...(author?.id ? { author: author.id } : {}),
    whisper,
    blind,
    ...stampFlags(req.eventId, req.origin, ATTACK_LANE),
  });

  // Cadence weapons read the GM's own targets: lend them for the roll.
  const layer = tokens();
  const previous = gmTargetIds();
  const lend =
    readsUserTargets(weapon) && source !== "gm" && !!layer?.setTargets;
  let settle!: (result: KnightAttackResultV1 | null) => void;
  const done = new Promise<KnightAttackResultV1 | null>((r) => (settle = r));
  track(ATTACK_LANE, req.eventId, done);
  try {
    if (lend) layer.setTargets!(ids, { mode: "replace" });
    await new RollKnight(actor, {
      name: req.label,
      dices: `${req.dice}D6`,
      carac: req.carac,
      bonus: req.bonus,
      weapon,
      style: req.style,
      surprise: req.surprise,
      targets: ids.map((id) => ({ id })),
      dataStyle: {},
      dataMod: {
        degats: { dice: 0, fixe: 0 },
        violence: { dice: 0, fixe: 0 },
      },
      maximize: { degats: false, violence: false },
    }).doRoll({});
  } catch (error) {
    disarm(); // the roller failed: no card is coming
    settle(null);
    throw error;
  } finally {
    if (lend) layer.setTargets!(previous, { mode: "replace" });
  }
  // doRoll does not await the card; it is created, then its Knight flags
  // written. Keep watching past the answer so a late card is still stamped.
  void waitFor(() => flagsLanded(req.eventId), CHAT_HOOKS, ATTACK_STAMP_MS)
    .then((card) => (card ? stamp(card, source) : null))
    .catch((error: unknown) => {
      log.warn(`${PROCEDURE}: stamping failed`, error);
      return null;
    })
    .then(settle);
  const result = await within(done, ATTACK_WAIT_MS);
  if (!result) throw cardTimeout();
  return result;
}

/** One Knight roll at a time (attacks and tests share the stamp hook). */
export const knightAttackV1: Procedure = (payload) => {
  const req = validateKnightAttackV1(payload);
  return oneAtATime(() => attack(req));
};
