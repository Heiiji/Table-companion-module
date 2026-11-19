import { MODULE_ID } from "../constants.js";
import {
  combatImplementation,
  foundryGeneration,
  gameActors,
  gameCombats,
  systemId,
  viewedScene,
  type CombatLike,
  type CombatantLike,
  type SceneLike,
  type TokenLike,
} from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  agentGatesByTable,
  SCHEMA_VERSION,
  alreadyApplied,
  assertGMResponder,
  bindingId,
  canonicalDigest,
  FLAG_KEYS,
  contentsOf,
  docId,
  flagRecord,
  flagValue,
  storedResultShape,
  identifier,
  integer,
  invalid,
  documentId,
  record,
  text,
  type Dict,
} from "./upsertShared.js";

/**
 * Mirror of the app's combat into a Foundry Combat (`combat.sync.v1`). The
 * app's GM-authoritative combat is the source of truth for what it sends; the
 * way back (Foundry → app) is the `combat.state.v1` snapshot
 * (combatSyncState.ts), and a combat the app adopted from Foundry comes back
 * here with `foundryCombatId` / `foundryCombatantId` so that the existing
 * Combat and its combatants are taken over instead of created twice.
 * Combat and Combatant are core Foundry documents, so this runs on every game
 * system. The Combat is found by `flags["table-companion"].combatSync.combatId`
 * (never by name); combatants by `flags["table-companion"].key`, and combatants
 * without that flag (added by the GM in Foundry) are never touched. The turn is
 * set directly, never through `nextTurn()`, so no system turn hook runs twice.
 * Re-sends converge by sequence/digest stored on the Combat's flag.
 */

/** Oldest Foundry generation the Combat/Combatant mapping runs on. */
export const MINIMUM_COMBAT_SYNC_FOUNDRY_GENERATION = 13;

const MAX_COMBATANTS = 64;
const MAX_NAME = 120;
const MAX_ROUND = 9999;
const MAX_INITIATIVE = 1_000_000;

interface CombatantSyncV1 {
  key: string;
  actorId: string | null;
  name: string;
  initiative: number | null;
  hidden: boolean;
  /** Adopt this existing, not yet keyed Combatant for the entry. */
  foundryCombatantId?: string;
}

export interface CombatSyncV1 {
  schemaVersion: 1;
  worldId: string;
  tableId: string;
  combatId: string;
  sequence: number;
  state: "active" | "ended";
  round: number;
  activeKey: string | null;
  combatants: CombatantSyncV1[];
  /** Adopt this existing Foundry Combat instead of creating one. */
  foundryCombatId?: string;
}

export interface CombatSyncResultV1 {
  schemaVersion: 1;
  /** The Combat id; "" when an `ended` request found no mirrored Combat. */
  resultDocId: string;
  outcome: "created" | "updated" | "deleted";
  appliedRevision: number;
  appliedDigest: string;
  warnings: string[];
}

/** Systems whose worlds the backend never writes to: advertising the mirror
 * there would promise something every request is refused for. */
const COMBAT_SYNC_REFUSED_SYSTEMS: ReadonlySet<string> = new Set([
  "pf2e",
  "cyberpunk-red-core",
  "cpred",
]);

export function combatSyncRefusedSystem(): boolean {
  return COMBAT_SYNC_REFUSED_SYSTEMS.has(systemId());
}

export function supportsCombatSyncV1Runtime(): boolean {
  return (
    foundryGeneration() >= MINIMUM_COMBAT_SYNC_FOUNDRY_GENERATION &&
    !combatSyncRefusedSystem()
  );
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null || value === undefined ? null : parse(value);
}

function combatant(value: unknown, index: number): CombatantSyncV1 {
  const path = `combatants[${index}]`;
  const p = record(value, path, [
    "key",
    "actorId",
    "name",
    "initiative",
    "hidden",
    "foundryCombatantId",
  ]);
  if (typeof p.hidden !== "boolean")
    invalid(`${path}.hidden must be a boolean`);
  const entry: CombatantSyncV1 = {
    key: identifier(p.key, `${path}.key`, bindingId),
    actorId: nullable(p.actorId, (v) =>
      identifier(v, `${path}.actorId`, documentId),
    ),
    name: text(p.name ?? "", `${path}.name`, MAX_NAME),
    initiative: nullable(p.initiative, (v) => {
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        Math.abs(v) > MAX_INITIATIVE
      )
        invalid(`${path}.initiative must be null or a number within ±1000000`);
      return v;
    }),
    hidden: p.hidden,
  };
  // Present only when sent: an absent key keeps the request's digest as it was.
  if (p.foundryCombatantId !== undefined)
    entry.foundryCombatantId = identifier(
      p.foundryCombatantId,
      `${path}.foundryCombatantId`,
      documentId,
    );
  return entry;
}

export function validateCombatSyncV1(payload: unknown): CombatSyncV1 {
  const p = record(payload, "combatSync", [
    "schemaVersion",
    "worldId",
    "tableId",
    "combatId",
    "sequence",
    "state",
    "round",
    "activeKey",
    "combatants",
    "foundryCombatId",
  ]);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.state !== "active" && p.state !== "ended")
    invalid("state must be active or ended");
  if (!Array.isArray(p.combatants) || p.combatants.length > MAX_COMBATANTS)
    invalid(`combatants must be an array with at most ${MAX_COMBATANTS}`);
  const combatants = p.combatants.map(combatant);
  if (new Set(combatants.map((c) => c.key)).size !== combatants.length)
    invalid("combatants contains a duplicate key");
  const req: CombatSyncV1 = {
    schemaVersion: 1,
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    combatId: identifier(p.combatId, "combatId", bindingId),
    sequence: integer(p.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
    state: p.state,
    round: integer(p.round, "round", 0, MAX_ROUND),
    activeKey: nullable(p.activeKey, (v) =>
      identifier(v, "activeKey", bindingId),
    ),
    combatants,
  };
  if (p.foundryCombatId !== undefined)
    req.foundryCombatId = identifier(
      p.foundryCombatId,
      "foundryCombatId",
      documentId,
    );
  return req;
}

function mirroredCombat(combatId: string): CombatLike | undefined {
  const combats = gameCombats();
  if (!combats)
    throw new RpcError(
      "unsupported_runtime",
      "Foundry game.combats is unavailable",
    );
  const matches = contentsOf(combats).filter((combat) => {
    const flag = flagValue(combat, FLAG_KEYS.combatSync);
    return (
      typeof flag === "object" &&
      flag !== null &&
      (flag as Dict).combatId === combatId
    );
  });
  if (matches.length > 1)
    throw new RpcError(
      "binding_collision",
      "multiple Combats carry this Table Companion combat id",
    );
  return matches[0];
}

/** The Combat id flagged on `combat`, or undefined when it carries none. */
function flaggedCombatId(combat: CombatLike): unknown {
  const flag = flagValue(combat, FLAG_KEYS.combatSync);
  return typeof flag === "object" && flag !== null
    ? (flag as Dict).combatId
    : undefined;
}

/** The existing Foundry Combat an adopting request names, or undefined when
 * it is gone. A Combat already mirroring another app combat is never taken —
 * unless the backend gates writes by table: only the table the world follows
 * reaches this lane then, so Foundry's running Combat is re-flagged to it. */
function adoptedCombat(req: CombatSyncV1): CombatLike | undefined {
  if (!req.foundryCombatId) return undefined;
  const combat = contentsOf(gameCombats()).find(
    (c) => docId(c) === req.foundryCombatId,
  );
  if (!combat) return undefined;
  const owner = flaggedCombatId(combat);
  if (owner !== undefined && owner !== req.combatId && !agentGatesByTable())
    throw new RpcError(
      "binding_conflict",
      "the Foundry Combat already mirrors another Table Companion combat",
    );
  return combat;
}

/** The result a previous apply stored on the Combat, or null. */
function storedResult(combat: CombatLike): CombatSyncResultV1 | null {
  const p = flagRecord(combat, FLAG_KEYS.combatSync, (p) =>
    storedResultShape(p, ["created", "updated"]),
  );
  if (!p) return null;
  return {
    schemaVersion: 1,
    resultDocId: docId(combat),
    outcome: p.outcome as "created" | "updated",
    appliedRevision: p.appliedRevision as number,
    appliedDigest: p.appliedDigest as string,
    warnings: [...(p.warnings as string[])],
  };
}

async function createCombat(combatId: string): Promise<CombatLike> {
  const factory = combatImplementation();
  if (!factory?.create)
    throw new RpcError(
      "unsupported_runtime",
      "Combat.implementation.create is unavailable",
    );
  const sceneId = docId(viewedScene());
  const created = await factory.create(
    {
      scene: sceneId || null,
      active: true,
      flags: {
        [MODULE_ID]: { [FLAG_KEYS.combatSync]: { schemaVersion: 1, combatId } },
      },
    },
    { renderSheet: false },
  );
  const combat = Array.isArray(created) ? created[0] : created;
  if (
    typeof combat !== "object" ||
    combat === null ||
    typeof (combat as CombatLike).update !== "function"
  )
    throw new Error("Foundry did not return the created Combat");
  return combat as CombatLike;
}

/** Combatant fields for one requested entry, plus its warning if any. */
function combatantData(
  entry: CombatantSyncV1,
  scene: SceneLike | null,
  warnings: string[],
): Dict {
  const data: Dict = {
    name: entry.name,
    initiative: entry.initiative,
    hidden: entry.hidden,
    actorId: null,
    tokenId: null,
  };
  if (entry.actorId === null) return data;
  if (!gameActors()?.get(entry.actorId)) {
    warnings.push(`combatant_actor_missing:${entry.key}`);
    return data;
  }
  data.actorId = entry.actorId;
  const token = contentsOf<TokenLike>(scene?.tokens).find(
    (t) => t.actorId === entry.actorId,
  );
  if (token && scene) {
    data.tokenId = docId(token);
    data.sceneId = docId(scene);
  } else {
    warnings.push(`combatant_without_token:${entry.key}`);
  }
  return data;
}

/** Foundry's initiative as the app's integer: rounded half away from zero. */
export function appInitiative(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** The update of a combatant that already exists in Foundry. What Foundry
 * holds and the app cannot improve on is left alone: an entry without an
 * Actor (a plain app entry of a Foundry NPC) keeps the combatant's Actor and
 * token, the same Actor keeps its token link, an initiative the app has not
 * set or only rounded keeps Foundry's (a roll, its decimals). */
function existingCombatantData(
  entry: CombatantSyncV1,
  current: CombatantLike,
  scene: SceneLike | null,
  warnings: string[],
): Dict {
  const keepsLink =
    entry.actorId === null ||
    (entry.actorId === current.actorId && !!current.tokenId);
  const data: Dict = keepsLink
    ? { name: entry.name, hidden: entry.hidden }
    : combatantData(entry, scene, warnings);
  const held = current.initiative;
  if (
    entry.initiative !== null &&
    !(typeof held === "number" && appInitiative(held) === entry.initiative)
  )
    data.initiative = entry.initiative;
  else delete data.initiative;
  return data;
}

export const combatSyncV1: Procedure = async (payload) => {
  const req = validateCombatSyncV1(payload);
  assertGMResponder("combat.sync.v1");
  if (!supportsCombatSyncV1Runtime())
    throw new RpcError(
      "unsupported_runtime",
      combatSyncRefusedSystem()
        ? `combat.sync.v1 is not available on ${systemId()}`
        : `combat.sync.v1 requires Foundry ${MINIMUM_COMBAT_SYNC_FOUNDRY_GENERATION} or later`,
    );
  const digest = await canonicalDigest(req);
  let combat = mirroredCombat(req.combatId);

  if (req.state === "ended") {
    combat ??= adoptedCombat(req);
    if (combat) {
      alreadyApplied(storedResult(combat), req.sequence, digest, "sequence");
      await combat.delete();
    }
    return {
      schemaVersion: 1,
      resultDocId: docId(combat),
      outcome: "deleted",
      appliedRevision: req.sequence,
      appliedDigest: digest,
      warnings: [],
    } satisfies CombatSyncResultV1;
  }

  let outcome: CombatSyncResultV1["outcome"] = "updated";
  // A Combat re-flagged from another table's combat (table gate): that
  // table's combatant keys mean nothing here, so its combatants are matched
  // by Foundry id like unkeyed ones, and none is removed for its key.
  let reflagged = false;
  if (combat) {
    const previous = storedResult(combat);
    if (alreadyApplied(previous, req.sequence, digest, "sequence"))
      return previous;
  } else if (req.foundryCombatId) {
    // An adopted Combat is never re-created: if Foundry deleted it first, the
    // app learns it from the next snapshot and ends its combat.
    combat = adoptedCombat(req);
    if (!combat)
      throw new RpcError(
        "not_found",
        "the Foundry Combat to adopt no longer exists",
      );
    const owner = flaggedCombatId(combat);
    reflagged = owner !== undefined && owner !== req.combatId;
  } else {
    combat = await createCombat(req.combatId);
    outcome = "created";
  }

  const scene = combat.scene ?? null;
  const warnings: string[] = [];
  const existing = new Map<string, CombatantLike>();
  const unkeyed = new Map<string, CombatantLike>();
  for (const c of contentsOf(combat.combatants)) {
    const key = flagValue(c, FLAG_KEYS.combatantKey);
    if (typeof key === "string" && !reflagged) existing.set(key, c);
    else unkeyed.set(docId(c), c);
  }
  const creates: Dict[] = [];
  const updates: Dict[] = [];
  for (const entry of req.combatants) {
    let current = existing.get(entry.key);
    let adopt = false;
    if (!current && entry.foundryCombatantId) {
      current = unkeyed.get(entry.foundryCombatantId);
      adopt = current !== undefined;
    }
    if (current) {
      const data = existingCombatantData(entry, current, scene, warnings);
      // An adopted combatant is keyed in place: never a second combatant.
      if (adopt)
        data.flags = { [MODULE_ID]: { [FLAG_KEYS.combatantKey]: entry.key } };
      updates.push({ _id: docId(current), ...data });
    } else {
      const data = combatantData(entry, scene, warnings);
      creates.push({
        ...data,
        flags: { [MODULE_ID]: { [FLAG_KEYS.combatantKey]: entry.key } },
      });
    }
  }
  const wanted = new Set(req.combatants.map((c) => c.key));
  const removals = [...existing]
    .filter(([key]) => !wanted.has(key))
    .map(([, c]) => docId(c));
  // Foundry keeps the current combatant across a create or delete by emitting
  // its own `update({turn})`, with turn events on. Clearing the turn first
  // leaves it nothing to shift; the final update below sets it quietly.
  if ((removals.length || creates.length) && combat.turn != null)
    await combat.update({ turn: null }, { turnEvents: false });
  if (removals.length)
    await combat.deleteEmbeddedDocuments("Combatant", removals);
  if (updates.length)
    await combat.updateEmbeddedDocuments("Combatant", updates);
  if (creates.length)
    await combat.createEmbeddedDocuments("Combatant", creates);

  // Foundry orders turns itself (initiative, then name, then id): the active
  // index is read from its order after the initiatives landed.
  const turns = combat.setupTurns?.() ?? combat.turns ?? [];
  let turn: number | null = turns.length ? 0 : null;
  if (req.activeKey !== null) {
    const index = turns.findIndex(
      (c) => flagValue(c, FLAG_KEYS.combatantKey) === req.activeKey,
    );
    if (index >= 0) turn = index;
    else warnings.push("active_combatant_missing");
  }

  const result: CombatSyncResultV1 = {
    schemaVersion: 1,
    resultDocId: docId(combat),
    outcome,
    appliedRevision: req.sequence,
    appliedDigest: digest,
    warnings,
  };
  // `turnEvents: false`: the app already ran its own turn effects.
  await combat.update(
    {
      round: req.round,
      turn,
      [`flags.${MODULE_ID}.${FLAG_KEYS.combatSync}`]: {
        ...result,
        combatId: req.combatId,
      },
    },
    { turnEvents: false },
  );
  return result;
};
