import { MODULE_ID } from "../constants.js";
import {
  canvasTokens,
  foundryGame,
  gameSettings,
  type Dict,
} from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  PF2E_RESOURCES_REQUIREMENT,
  actorCollection,
  assertLaneAuthority,
  contentsOf,
  docId,
  documentId,
  identifier,
  integer,
  invalid,
  list,
  oneOf,
  record,
  supportsPf2eResourcesV1Runtime,
  uuid,
  type ActorLike,
} from "./upsertShared.js";
import {
  cardAuthor,
  newDocumentId,
  playerOf,
  postUnposted,
  runOnce,
  visibilityOf,
  type TokenObj,
} from "./chatCards.js";

/**
 * `pf2e.check.v1`: a check the app started — a statistic check (Perception,
 * a save, a skill or a lore), a Strike at a multiple-attack-penalty step, or a
 * spell attack — rolled by pf2e itself in the responder GM's browser, so
 * Foundry's own card appears with its modifier breakdown, roll options, rule
 * elements and degree of success. The roll is built unposted
 * (`createMessage: false`), stamped with the request's `eventId` and its
 * result, then created once: a retry answers the stamped result with
 * `alreadyRolled: true` and never rolls again. Dialogs never open; no
 * ammunition is spent.
 *
 * Source-derived (pf2e 8.6.1, members identical in 8.5.1), never confirmed
 * against a live world: `actor.getStatistic` (`actor/base.ts`),
 * `Statistic#roll` → `StatisticCheck#roll` (`system/statistic/statistic.ts`,
 * `createMessage`, `skipDialog`, `messageMode`, `rollTwice`, `callback`),
 * a character strike's `variants[n].roll` (`actor/character/document.ts`,
 * `consumeAmmo`, `target`, `event`, `callback`), `Check.roll`
 * (`system/check/check.ts`: with `createMessage: false` the callback receives
 * the unposted message; `flags.pf2e.context` carries `outcome`,
 * `unadjustedOutcome`, `messageMode`, `options`, `target`, `dc`), and the spell attack
 * `SpellPF2e#rollAttack` builds (`item/spell/document.ts`).
 */

export const PROCEDURE = "pf2e.check.v1";
export const CHECK_LANE = "pf2e.check";

const PAYLOAD_KEYS = [
  "eventId",
  "origin",
  "actorId",
  "kind",
  "statistic",
  "strike",
  "spell",
  "mapIncreases",
  "dc",
  "rollTwice",
  "targetActorIds",
  "visibility",
] as const;

const ORIGINS = ["app", "player"] as const;
const KINDS = ["statistic", "strike", "spellAttack"] as const;
const ROLL_TWICE = ["keep-higher", "keep-lower"] as const;
const VISIBILITIES = ["public", "gm"] as const;
const DEGREES = [
  "criticalSuccess",
  "success",
  "failure",
  "criticalFailure",
] as const;
/** A pf2e slug: letters, digits and hyphens (a lore's slug may be accented). */
const SLUG = /^[\p{L}\p{N}-]{1,64}$/u;
/** A strike's slug, as the statistics read answers it: no space or control
 * character, at most 120 characters. */
const STRIKE_SLUG = /^[^\s\u0000-\u001f\u007f-\u009f]{1,120}$/u;

type Degree = (typeof DEGREES)[number];

export interface Pf2eCheckV1 {
  eventId: string;
  origin: (typeof ORIGINS)[number];
  actorId: string;
  kind: (typeof KINDS)[number];
  statistic: string | null;
  strike: { itemId: string; slug: string } | null;
  spell: { entryId: string; spellId: string } | null;
  mapIncreases: 0 | 1 | 2;
  dc: number | null;
  rollTwice: (typeof ROLL_TWICE)[number] | null;
  targetActorIds: string[];
  visibility: (typeof VISIBILITIES)[number];
}

export interface Pf2eCheckResultV1 {
  messageId: string;
  alreadyRolled: boolean;
  faces: number[];
  kept: number;
  modifier: number;
  total: number;
  degree: Degree | null;
  unadjustedDegree: Degree | null;
  /** Where pf2e took the DC of `degree` from: the request's `dc`, or the
   * target (its AC for an attack) when the request sent none. Null exactly
   * when `degree` is. The DC or AC value itself never leaves Foundry. */
  degreeSource: "dc" | "target" | null;
  /** pf2e's world setting `metagame_showResults` (« Show Check Outcomes »):
   * whether pf2e shows players this card's degree of success. */
  resultsShown: boolean;
  messageMode: "public" | "gm" | "blind";
}

// ------------------------------------------------------- structural views

/** `Check.roll`'s callback: the roll, its outcome, the (unposted) message. */
type CheckCallback = (
  roll: unknown,
  outcome: unknown,
  message: { toObject?(): Dict } | undefined,
) => void;

type RollFn = (params: Dict) => Promise<unknown>;

interface Pf2eActor extends ActorLike {
  getStatistic?(slug: string): { roll?: RollFn } | null;
}

interface CheckRoll {
  total?: number;
  dice?: {
    faces?: number;
    results?: { result: number; active?: boolean; discarded?: boolean }[];
  }[];
}

interface Token extends TokenObj {
  actor?: unknown;
}

// ------------------------------------------------------------- validation

/** The strict payload: every key required, unknown keys refused, and the
 * one identity block its `kind` names (the other two null). */
export function validatePf2eCheckV1(payload: unknown): Pf2eCheckV1 {
  const p = record(payload, "payload", PAYLOAD_KEYS);
  for (const key of PAYLOAD_KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  const kind = oneOf(p.kind, "kind", KINDS);
  const want = (key: "statistic" | "strike" | "spell", wanted: boolean) => {
    if (wanted ? p[key] === null : p[key] !== null)
      invalid(`${key} must be ${wanted ? "set" : "null"} for kind ${kind}`);
  };
  want("statistic", kind === "statistic");
  want("strike", kind === "strike");
  want("spell", kind === "spellAttack");
  const strike =
    p.strike === null ? null : record(p.strike, "strike", ["itemId", "slug"]);
  const spell =
    p.spell === null ? null : record(p.spell, "spell", ["entryId", "spellId"]);
  return {
    eventId: identifier(p.eventId, "eventId", uuid),
    origin: oneOf(p.origin, "origin", ORIGINS),
    actorId: identifier(p.actorId, "actorId", documentId),
    kind,
    statistic:
      p.statistic === null ? null : identifier(p.statistic, "statistic", SLUG),
    strike: strike && {
      itemId: identifier(strike.itemId, "strike.itemId", documentId),
      slug: identifier(strike.slug, "strike.slug", STRIKE_SLUG),
    },
    spell: spell && {
      entryId: identifier(spell.entryId, "spell.entryId", documentId),
      spellId: identifier(spell.spellId, "spell.spellId", documentId),
    },
    mapIncreases: integer(p.mapIncreases, "mapIncreases", 0, 2) as 0 | 1 | 2,
    dc: p.dc === null ? null : integer(p.dc, "dc", 1, 99),
    rollTwice:
      p.rollTwice === null ? null : oneOf(p.rollTwice, "rollTwice", ROLL_TWICE),
    targetActorIds: list(p.targetActorIds, "targetActorIds", 20).map((id, i) =>
      identifier(id, `targetActorIds[${i}]`, documentId),
    ),
    visibility: oneOf(p.visibility, "visibility", VISIBILITIES),
  };
}

// ---------------------------------------------------------------- runtime

/** Registration gate: the pf2e live-counters floor, with pf2e's `Check`. */
export function supportsPf2eCheckV1Runtime(): boolean {
  return supportsPf2eResourcesV1Runtime() && !!foundryGame()?.pf2e?.Check;
}

/**
 * The click a strike reads its dialog choice from: pf2e has no `skipDialog`
 * for a strike, only `eventToRollParams(event)` (`sheet/helpers.ts`), which
 * skips the dialog when `shiftKey` equals the user's `showCheckDialogs`.
 * Never ctrl / meta (they force a GM roll). Assumed, not yet seen on a live
 * world: a synthetic event passes pf2e's `isRelevantEvent`.
 */
export function skipDialogEvent(): unknown {
  const settings = (foundryGame()?.user as { settings?: Dict } | undefined)
    ?.settings;
  return new PointerEvent("click", {
    shiftKey: settings?.showCheckDialogs === true,
  });
}

function dictAt(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null ? (v as Dict)[key] : undefined;
}

function itemOf(actor: ActorLike, id: string, type: string): Dict | undefined {
  return contentsOf(actor.items).find(
    (i) => i.type === type && docId(i) === id,
  ) as Dict | undefined;
}

/**
 * The roll's target: the ROLLER's, never someone else's.
 * - The first of the app's targets with a token on the GM's canvas.
 * - Otherwise, a Gamemaster's own roll (`origin: "app"`) leaves pf2e to read
 *   the responder Gamemaster's current targets, as from the sheet.
 * - Otherwise (a player's roll), the first token that player targets
 *   (`User#targets`, which Foundry keeps for every user), or none at all.
 *
 * `none` asks the caller to hide the Gamemaster's targets for the roll:
 * source-derived (pf2e 8.6.1 `actor/character/document.ts` strike
 * `params.target ?? game.user.targets.first()`, `system/statistic/statistic.ts`
 * `args.target … ?? game.user.targets.find(…)`), so neither an absent nor an
 * explicit `null` target stops pf2e from taking the Gamemaster's.
 */
function rollTarget(
  req: Pf2eCheckV1,
  actor: ActorLike,
): { token?: Token; none: boolean } {
  const placeables =
    (canvasTokens() as { placeables?: Token[] } | undefined)?.placeables ?? [];
  for (const actorId of req.targetActorIds) {
    const token = placeables.find((t) => t.document?.actorId === actorId);
    if (token) return { token, none: false };
  }
  if (req.origin === "app") return { none: false };
  const targets = (playerOf(actor) as { targets?: Iterable<Token> } | undefined)
    ?.targets;
  const token = targets ? [...targets][0] : undefined;
  return token ? { token, none: false } : { none: true };
}

/** Rolls currently hiding the Gamemaster's targets, and the set they hid. */
let hidden: { targets: unknown; rolls: number } | null = null;

/**
 * Runs `roll` with the responder Gamemaster's targets swapped for an empty set,
 * then puts the very same set back: nothing is untargeted, no hook fires, and
 * the Gamemaster's selection is unchanged after the call. Overlapping rolls
 * share one swap.
 */
async function withoutGmTargets<T>(roll: () => Promise<T>): Promise<T> {
  const user = foundryGame()?.user as { targets?: unknown } | undefined;
  if (!user) return roll();
  if (!hidden) {
    hidden = { targets: user.targets, rolls: 0 };
    user.targets = new Set();
  }
  hidden.rolls++;
  try {
    return await roll();
  } finally {
    if (--hidden.rolls === 0) {
      user.targets = hidden.targets;
      hidden = null;
    }
  }
}

const dcOf = (dc: number | null) => (dc === null ? null : { value: dc });

/** The pf2e call this request names, ready to roll with a callback. */
function rollerFor(
  actor: Pf2eActor,
  req: Pf2eCheckV1,
): (callback: CheckCallback) => Promise<unknown> {
  const common = {
    createMessage: false,
    rollTwice: req.rollTwice ?? false,
  };
  const { token: target, none } = rollTarget(req, actor);
  const run =
    (roll: (callback: CheckCallback) => Promise<unknown>) =>
    (callback: CheckCallback) =>
      none ? withoutGmTargets(() => roll(callback)) : roll(callback);

  if (req.kind === "statistic") {
    const statistic = actor.getStatistic?.(req.statistic!);
    if (typeof statistic?.roll !== "function")
      throw new RpcError(
        "statistic_not_found",
        `${PROCEDURE}: the Actor has no such statistic`,
      );
    // No target: a save treats a given target as the opposer, not itself.
    return (callback) =>
      statistic.roll!({
        ...common,
        dc: dcOf(req.dc),
        messageMode: req.visibility,
        skipDialog: true,
        callback,
      });
  }

  if (req.kind === "strike") {
    const { itemId, slug } = req.strike!;
    const actions = dictAt(actor.system, "actions");
    const strike = (Array.isArray(actions) ? actions : []).find(
      (s) =>
        dictAt(s, "type") === "strike" &&
        dictAt(s, "visible") !== false &&
        docId(dictAt(s, "item") as { id?: string }) === itemId &&
        dictAt(s, "slug") === slug,
    );
    const variant = (dictAt(strike, "variants") as unknown[] | undefined)?.[
      req.mapIncreases
    ];
    const roll = dictAt(variant, "roll");
    if (typeof roll !== "function")
      throw new RpcError(
        "strike_not_found",
        `${PROCEDURE}: the Actor has no such strike`,
      );
    // pf2e's NPC strike (`actor/helpers.ts`) does not hand its callback to
    // `Check.roll`, so its unposted card never reaches this lane.
    if (actor.type !== "character")
      throw new RpcError(
        "unsupported_runtime",
        `${PROCEDURE}: pf2e does not return the unposted card of a ${actor.type ?? "non-character"} strike`,
      );
    return run((callback) =>
      (roll as RollFn)({
        ...common,
        dc: dcOf(req.dc),
        consumeAmmo: false,
        event: skipDialogEvent(),
        ...(target ? { target } : {}),
        callback,
      }),
    );
  }

  const { entryId, spellId } = req.spell!;
  const entry = itemOf(actor, entryId, "spellcastingEntry");
  const spell = itemOf(actor, spellId, "spell");
  const check = dictAt(dictAt(entry, "statistic"), "check");
  const roll = dictAt(check, "roll");
  if (
    !spell ||
    dictAt(dictAt(spell.system, "location"), "value") !== entryId ||
    typeof roll !== "function"
  )
    throw new RpcError(
      "spell_not_found",
      `${PROCEDURE}: the Actor has no such spell in that spellcasting entry`,
    );
  const system = spell.system;
  const ownTraits = dictAt(dictAt(system, "traits"), "value");
  const tradition = dictAt(entry, "tradition");
  // What `SpellPF2e#rollAttack` passes, with the app's DC in place of the
  // defense slug when it sent one.
  return run((callback) =>
    (roll as RollFn).call(check, {
      ...common,
      item: spell,
      attackNumber: req.mapIncreases + 1,
      action: "cast-a-spell",
      extraRollOptions: ["action:cast-a-spell"],
      traits: [
        ...new Set([...(Array.isArray(ownTraits) ? ownTraits : []), tradition]),
      ].filter((t) => typeof t === "string"),
      dc: dcOf(req.dc) ?? {
        slug:
          dictAt(dictAt(dictAt(system, "defense"), "passive"), "statistic") ??
          "ac",
      },
      messageMode: req.visibility,
      skipDialog: true,
      ...(target?.actor ? { target: target.actor } : {}),
      callback,
    }),
  );
}

// ---------------------------------------------------------------- results

function degreeOf(v: unknown): Degree | null {
  return (DEGREES as readonly unknown[]).includes(v) ? (v as Degree) : null;
}

/** pf2e made the check secret itself (a `secret` roll option): its GM / blind
 * mode then wins over the request's visibility. */
function secretMode(context: Dict): "gm" | "blind" | null {
  const options = context.options;
  const mode = context.messageMode;
  return Array.isArray(options) &&
    options.includes("secret") &&
    (mode === "gm" || mode === "blind")
    ? mode
    : null;
}

/** source-derived (pf2e 8.6.1 `system/check/check.ts` #createResultFlavor,
 * the same in the 8.7.0 bundle): the degree nodes of a card are visible to
 * players exactly when the world setting `pf2e.metagame_showResults` is true
 * (default true). Unreadable counts as hidden. */
function resultsShown(): boolean {
  try {
    return gameSettings()?.get("pf2e", "metagame_showResults") === true;
  } catch {
    return false; // Foundry throws on an unregistered setting
  }
}

function refused(why: string): RpcError {
  return new RpcError("roll_refused", `${PROCEDURE}: ${why}`);
}

/** The reply, read from pf2e's roll and the unposted card's context. */
export function checkResult(
  req: Pf2eCheckV1,
  roll: CheckRoll,
  context: Dict,
  messageId: string,
): Pf2eCheckResultV1 {
  const d20 = roll.dice?.find((d) => d.faces === 20);
  const results = d20?.results ?? [];
  const kept = results.find((r) => r.active !== false && !r.discarded)?.result;
  if (
    results.length < 1 ||
    results.length > 2 ||
    typeof kept !== "number" ||
    !Number.isSafeInteger(roll.total)
  )
    throw refused("the roll has no single kept d20");
  const total = roll.total!;
  // Both degrees or neither: against the app's own DC, or, when it sent
  // none, against the target pf2e resolved (`context.target`, whose DC pf2e
  // read itself). Never against a DC of unknown origin.
  const target = typeof context.target === "object" && context.target !== null;
  const degree = req.dc !== null || target ? degreeOf(context.outcome) : null;
  return {
    messageId,
    alreadyRolled: false,
    faces: results.map((r) => r.result),
    kept,
    modifier: total - kept,
    total,
    degree,
    unadjustedDegree:
      degree === null ? null : (degreeOf(context.unadjustedOutcome) ?? degree),
    degreeSource: degree === null ? null : req.dc !== null ? "dc" : "target",
    resultsShown: resultsShown(),
    messageMode: secretMode(context) ?? req.visibility,
  };
}

async function check(req: Pf2eCheckV1): Promise<Pf2eCheckResultV1> {
  const actor = actorCollection().get(req.actorId) as Pf2eActor | undefined;
  if (!actor)
    throw new RpcError("actor_not_found", `${PROCEDURE}: no such Actor`);
  const roller = rollerFor(actor, req);

  let source: Dict | undefined;
  const roll = (await roller((_roll, _outcome, message) => {
    source = message?.toObject?.();
  })) as CheckRoll | null;
  if (!roll || !source) throw refused("pf2e did not roll");

  const flags = (source.flags ?? {}) as Dict;
  const context = (dictAt(flags.pf2e, "context") ?? {}) as Dict;
  const messageId = newDocumentId();
  const result = checkResult(req, roll, context, messageId);
  const visibility = secretMode(context) ?? req.visibility;
  // A pf2e GM roll is a secret from the player, whoever asked for it.
  const author = cardAuthor(actor, visibility, false);
  const authorId = author?.id ?? foundryGame()?.user?.id ?? "";
  const { whisper, blind } = visibilityOf(visibility, authorId);
  const posted = await postUnposted(source, {
    _id: messageId,
    ...(author?.id ? { author: author.id } : {}),
    whisper,
    blind,
    flags: {
      ...flags,
      [MODULE_ID]: {
        eventId: req.eventId,
        origin: req.origin,
        lane: CHECK_LANE,
        result,
      },
    },
  });
  if (!posted) throw refused("Foundry did not create the card");
  return result;
}

export const pf2eCheckV1: Procedure = (payload) => {
  const req = validatePf2eCheckV1(payload);
  assertLaneAuthority(
    PROCEDURE,
    supportsPf2eCheckV1Runtime,
    `${PF2E_RESOURCES_REQUIREMENT} with game.pf2e.Check`,
  );
  return runOnce<Pf2eCheckResultV1>(
    CHECK_LANE,
    req.eventId,
    (r) => ({ ...r, alreadyRolled: true }),
    () => check(req),
  );
};
