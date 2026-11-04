import { MODULE_ID } from "../constants.js";
import {
  canvasTokens,
  foundryGame,
  foundryHooks,
  type Dict,
  type UserLike,
} from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { COMPANION_USER_NAME } from "../setup/companion-user.js";
import { isResponder } from "../setup/election.js";
import { companionAnchorId, pairedAgentUserId } from "../setup/identity.js";
import { log } from "../util/log.js";
import {
  FLAG_KEYS,
  actorCollection,
  assertKnightUpsertAuthority,
  contentsOf,
  flagValue,
  identifier,
  integer,
  invalid,
  record,
  supportsKnightActorUpsertV1Runtime,
  text,
  type ActorLike,
} from "./upsertShared.js";

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

const PROCEDURE = "knight.attack.v1";
export const ATTACK_LANE = "knight.attack";
/** How long the call waits for the card's Knight flags before answering. */
export const ATTACK_WAIT_MS = 8_000;
/** How long the card is still watched, after an unanswered call, to stamp its
 * result for a later import. */
// ponytail: a card whose flags land after this is never stamped; a hook on
// updateChatMessage would cover any delay if that ever shows up.
export const ATTACK_STAMP_MS = 60_000;
const POLL_MS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FOUNDRY_ID = /^[A-Za-z0-9]{16}$/;
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
const READS_USER_TARGETS = ["cadence", "chromeligneslumineuses", "barrage"];

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
  rollState: "normal" | "exploit" | "epicFail";
  targetSource: TargetSource;
  targets: KnightAttackTargetV1[];
}

// ------------------------------------------------------- structural views

interface TokenObj {
  id: string;
  document?: { actorId?: string | null };
}

interface TokenLayer {
  get(id: string): TokenObj | undefined;
  placeables?: TokenObj[];
  setTargets?(ids: string[], options?: { mode?: string }): void;
}

interface Player extends UserLike {
  character?: { id?: string } | string | null;
  targets?: Iterable<TokenObj>;
}

interface RollLike {
  formula?: string;
  total?: number;
  dice?: { results?: { result: number; active?: boolean }[] }[];
  terms?: { results?: { result: number; active?: boolean }[] }[];
}

/** A chat message, as the attack lane reads and stamps it. */
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

interface Weapon {
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
  effets?: { label?: unknown }[];
}

// ------------------------------------------------------------- validation

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T))
    invalid(`${path} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    invalid(`${path} must be an array of at most ${max}`);
  return value as unknown[];
}

/** The strict payload: every key required, unknown keys refused. */
export function validateKnightAttackV1(payload: unknown): KnightAttackV1 {
  const p = record(payload, "payload", PAYLOAD_KEYS);
  for (const key of PAYLOAD_KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  if (typeof p.surprise !== "boolean") invalid("surprise must be a boolean");
  return {
    eventId: identifier(p.eventId, "eventId", UUID),
    origin: oneOf(p.origin, "origin", ORIGINS),
    actorId: identifier(p.actorId, "actorId", FOUNDRY_ID),
    entryId: identifier(p.entryId, "entryId", UUID),
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
      identifier(id, `targetActorIds[${i}]`, FOUNDRY_ID),
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

function messages(): CardMessage[] {
  return (foundryGame()?.messages?.contents ?? []) as CardMessage[];
}

function laneFlags(message: CardMessage): Dict | undefined {
  const ns = message.flags?.[MODULE_ID];
  return typeof ns === "object" && ns !== null ? (ns as Dict) : undefined;
}

function cardOf(eventId: string): CardMessage | undefined {
  return messages().find((m) => {
    const ns = laneFlags(m);
    return ns?.eventId === eventId && ns.lane === ATTACK_LANE;
  });
}

function knightFlags(message: CardMessage): Dict | undefined {
  const knight = message.flags?.knight;
  return typeof knight === "object" && knight !== null
    ? (knight as Dict)
    : undefined;
}

/** A user who is a person at the table: not a GM, not the app's service user. */
function players(): Player[] {
  const service = new Set([pairedAgentUserId(), companionAnchorId()]);
  return (contentsOf(foundryGame()?.users) as Player[]).filter(
    (u) =>
      !u.isGM && !service.has(u.id ?? "") && u.name !== COMPANION_USER_NAME,
  );
}

function characterOf(user: Player): string | undefined {
  const c = user.character;
  return typeof c === "string" ? c : (c?.id ?? undefined);
}

/** The PC's player (the user whose character it is), else an active owner. */
function playerOf(actor: ActorLike): Player | undefined {
  const all = players();
  return (
    all.find((u) => characterOf(u) === actor.id) ??
    all.find((u) => u.active && actor.testUserPermission?.(u, "OWNER") === true)
  );
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

function gmTargetIds(): string[] {
  return [...((foundryGame()?.user as Player | undefined)?.targets ?? [])].map(
    (t) => t.id,
  );
}

/** The card's visibility, in place of the GM's own roll mode. */
function visibilityOf(
  visibility: KnightAttackV1["visibility"],
  authorId: string,
): { whisper: string[]; blind: boolean } {
  if (visibility === "public") return { whisper: [], blind: false };
  if (visibility === "self") return { whisper: [authorId], blind: false };
  const gms = contentsOf(foundryGame()?.users)
    .filter((u) => u.isGM && u.id)
    .map((u) => u.id as string);
  return { whisper: gms, blind: visibility === "blind" };
}

async function poll<T>(
  read: () => T | null | undefined,
  ms: number,
): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= end) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function cardTimeout(): RpcError {
  return new RpcError(
    "attack_card_timeout",
    `${PROCEDURE}: the Knight card did not complete within ${ATTACK_WAIT_MS} ms`,
  );
}

// ---------------------------------------------------------------- results

function facesOf(roll: unknown): number[] {
  const r = (
    typeof roll === "string" ? (JSON.parse(roll) as unknown) : roll
  ) as RollLike | null;
  const terms = r?.dice?.length ? r.dice : (r?.terms ?? []);
  return terms.flatMap((t) =>
    (t.results ?? []).filter((x) => x.active !== false).map((x) => x.result),
  );
}

const evens = (faces: number[]) => faces.filter((f) => f % 2 === 0).length;

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
  // The first roll is the attack; no odd die means the next one is its
  // Exploit reroll (a cadence card rolls once per target: the first is read).
  const rolls = message.rolls ?? [];
  const faces = rolls.length ? facesOf(rolls[0]) : [];
  const exploit = faces.length > 0 && faces.every((f) => f % 2 === 0);
  const exploitFaces = exploit && rolls[1] ? facesOf(rolls[1]) : null;
  const successes = evens(faces) + evens(exploitFaces ?? []);
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
        effects: (t.effets ?? [])
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
    rollState: exploit
      ? "exploit"
      : faces.length > 0 && successes === 0
        ? "epicFail"
        : "normal",
    targetSource,
    targets,
  };
}

function storedResult(message: CardMessage): KnightAttackResultV1 | null {
  const value = flagValue(message, "attackResult");
  return typeof value === "object" && value !== null
    ? (value as KnightAttackResultV1)
    : null;
}

/** Build and stamp the result once the card's Knight flags are there. */
async function stamp(
  message: CardMessage,
  targetSource: TargetSource,
): Promise<KnightAttackResultV1> {
  const result = buildAttackResult(message, targetSource);
  try {
    await message.setFlag?.(MODULE_ID, "attackResult", result);
  } catch (error) {
    log.warn(`${PROCEDURE}: could not stamp the result`, error);
  }
  return result;
}

const flagsLanded = (eventId: string) => {
  const card = cardOf(eventId);
  return card && Array.isArray(knightFlags(card)?.content) ? card : null;
};

/** A retry of an attack already on the chat: its stored result, never a new roll. */
async function replay(eventId: string): Promise<KnightAttackResultV1> {
  const card = await poll(() => {
    const c = cardOf(eventId);
    return c && (storedResult(c) || Array.isArray(knightFlags(c)?.content))
      ? c
      : null;
  }, ATTACK_WAIT_MS);
  if (!card) throw cardTimeout();
  // ponytail: a card left unstamped (the GM reloaded mid-attack) is rebuilt
  // without its target source; stamp it under the card's flags if it matters.
  const result =
    storedResult(card) ??
    (await stamp(
      card,
      (knightFlags(card)?.content as { targets?: unknown[] }[])?.some(
        (c) => c.targets?.length,
      )
        ? "gm"
        : "none",
    ));
  return { ...result, alreadyRolled: true };
}

async function attack(req: KnightAttackV1): Promise<KnightAttackResultV1> {
  assertKnightUpsertAuthority(PROCEDURE);
  const RollKnight = rollKnightClass();
  if (!RollKnight)
    throw new RpcError(
      "knight_api_missing",
      `${PROCEDURE}: game.knight.RollKnight is unavailable`,
    );
  if (cardOf(req.eventId)) return replay(req.eventId);

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
  const { ids, source } = resolveTargets(actor, req.targetActorIds);
  const author = playerOf(actor);
  const authorId = author?.id ?? foundryGame()?.user?.id ?? "";
  const { whisper, blind } = visibilityOf(req.visibility, authorId);

  const hooks = foundryHooks();
  let fired = false;
  const hookId = hooks?.on("preCreateChatMessage", (doc: CardMessage) => {
    if (fired || doc.speaker?.actor !== actor.id) return;
    fired = true;
    doc.updateSource?.({
      ...(author?.id ? { author: author.id } : {}),
      whisper,
      blind,
      [`flags.${MODULE_ID}`]: {
        eventId: req.eventId,
        origin: req.origin,
        lane: ATTACK_LANE,
      },
    });
  });

  // Cadence and barrage weapons read the GM's own targets: lend them for the roll.
  const layer = tokens();
  const previous = gmTargetIds();
  const lend =
    readsUserTargets(weapon) && source !== "gm" && !!layer?.setTargets;
  try {
    if (lend) layer.setTargets!(ids, { mode: "replace" });
    try {
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
    } finally {
      if (lend) layer.setTargets!(previous, { mode: "replace" });
    }
    // doRoll does not await the card; it is created, then its Knight flags
    // written. Keep watching past the answer so a late card is still stamped.
    let answer: KnightAttackResultV1 | null = null;
    void poll(() => flagsLanded(req.eventId), ATTACK_STAMP_MS)
      .then((card) => (card ? stamp(card, source) : null))
      .then((r) => (answer = r))
      .catch((error: unknown) =>
        log.warn(`${PROCEDURE}: stamping failed`, error),
      );
    const result = await poll(() => answer, ATTACK_WAIT_MS);
    if (!result) throw cardTimeout();
    return result;
  } finally {
    if (hookId !== undefined) hooks?.off?.("preCreateChatMessage", hookId);
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** One attack at a time: the scoped hook and the lent targets are per call. */
export const knightAttackV1: Procedure = (payload) => {
  const req = validateKnightAttackV1(payload);
  const run = queue.then(() => attack(req));
  queue = run.catch(() => undefined);
  return run;
};

// ------------------------------------------------------------ follow-ups

function rollKey(rolls: unknown[]): string {
  return rolls
    .map((roll) => {
      const r = (
        typeof roll === "string" ? (JSON.parse(roll) as unknown) : roll
      ) as RollLike | null;
      return `${r?.formula ?? ""}:${r?.total ?? ""}:${facesOf(r).join(",")}`;
    })
    .join("|");
}

const DICE_TOTAL = /class="[^"]*\bdice-total\b[^"]*"[^>]*>\s*(-?\d+(?:\.\d+)?)/;

/** Stamp a damage / violence card rolled from a lane attack card with that
 * attack's `eventId`; true when it did. Responder GM only. */
export async function stampFollowUp(message: CardMessage): Promise<boolean> {
  if (!isResponder()) return false;
  const knight = knightFlags(message);
  const attaque = knight?.attaque;
  if (!Array.isArray(attaque) || attaque.length === 0) return false;
  const own = laneFlags(message);
  if (own?.followUp || own?.eventId) return false;
  const key = rollKey(attaque);
  const card = [...messages()]
    .reverse()
    .find(
      (m) =>
        laneFlags(m)?.lane === ATTACK_LANE &&
        (m.rolls?.length ?? 0) > 0 &&
        rollKey(m.rolls!) === key,
    );
  const attackEventId = card ? laneFlags(card)?.eventId : undefined;
  if (typeof attackEventId !== "string") return false;
  const rollType = (knight?.weapon as { rollType?: unknown } | undefined)
    ?.rollType;
  const kind =
    rollType === "damage" || rollType === "violence"
      ? rollType
      : /violence/i.test(message.flavor ?? "")
        ? "violence"
        : "damage";
  const match = DICE_TOTAL.exec(message.content ?? "");
  await message.setFlag?.(MODULE_ID, "followUp", {
    attackEventId,
    kind,
    total: match ? Number(match[1]) : null,
  });
  return true;
}

/** Watch the chat for follow-ups on a Knight world the lane runs on. */
export function startKnightAttackFollowUps(): void {
  if (!supportsKnightAttackV1Runtime()) return;
  const onMessage = (message: CardMessage) => {
    void stampFollowUp(message).catch((error: unknown) =>
      log.warn(`${PROCEDURE}: follow-up stamp failed`, error),
    );
  };
  foundryHooks()?.on("createChatMessage", onMessage);
  foundryHooks()?.on("updateChatMessage", onMessage);
}
