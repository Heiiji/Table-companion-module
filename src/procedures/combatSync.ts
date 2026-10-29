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
  SCHEMA_VERSION,
  alreadyApplied,
  assertGMResponder,
  bindingId,
  canonicalDigest,
  flagValue,
  identifier,
  integer,
  invalid,
  record,
  text,
  type Dict,
} from "./upsertShared.js";

/**
 * Mirror of the app's combat into a Foundry Combat (`combat.sync.v1`), app →
 * Foundry only: the app's GM-authoritative combat is the source of truth.
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
const COMBAT_FLAG = "combatSync";
const COMBATANT_FLAG = "key";

/** A Foundry document id (randomID(16)). */
const documentId = /^[A-Za-z0-9]{16}$/;

export interface CombatantSyncV1 {
  key: string;
  actorId: string | null;
  name: string;
  initiative: number | null;
  hidden: boolean;
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
export const COMBAT_SYNC_REFUSED_SYSTEMS: ReadonlySet<string> = new Set([
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
  ]);
  if (typeof p.hidden !== "boolean")
    invalid(`${path}.hidden must be a boolean`);
  return {
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
  ]);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.state !== "active" && p.state !== "ended")
    invalid("state must be active or ended");
  if (!Array.isArray(p.combatants) || p.combatants.length > MAX_COMBATANTS)
    invalid(`combatants must be an array with at most ${MAX_COMBATANTS}`);
  const combatants = p.combatants.map(combatant);
  if (new Set(combatants.map((c) => c.key)).size !== combatants.length)
    invalid("combatants contains a duplicate key");
  return {
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
}

function listOf<T>(
  collection: { contents?: T[] } | Iterable<T> | null | undefined,
): T[] {
  if (!collection) return [];
  if ("contents" in collection && Array.isArray(collection.contents))
    return collection.contents;
  if (Symbol.iterator in collection) return [...(collection as Iterable<T>)];
  return [];
}

function docId(doc: { id?: string; _id?: string } | null | undefined): string {
  return doc?.id ?? doc?._id ?? "";
}

function mirroredCombat(combatId: string): CombatLike | undefined {
  const combats = gameCombats();
  if (!combats)
    throw new RpcError(
      "unsupported_runtime",
      "Foundry game.combats is unavailable",
    );
  const matches = listOf(combats).filter((combat) => {
    const flag = flagValue(combat, COMBAT_FLAG);
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

/** The result a previous apply stored on the Combat, or null. */
function storedResult(combat: CombatLike): CombatSyncResultV1 | null {
  const flag = flagValue(combat, COMBAT_FLAG);
  if (typeof flag !== "object" || flag === null) return null;
  const p = flag as Dict;
  if (
    p.schemaVersion !== 1 ||
    !Number.isSafeInteger(p.appliedRevision) ||
    typeof p.appliedDigest !== "string" ||
    (p.outcome !== "created" && p.outcome !== "updated") ||
    !Array.isArray(p.warnings) ||
    !p.warnings.every((w) => typeof w === "string")
  )
    return null;
  return {
    schemaVersion: 1,
    resultDocId: docId(combat),
    outcome: p.outcome,
    appliedRevision: p.appliedRevision as number,
    appliedDigest: p.appliedDigest,
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
        [MODULE_ID]: { [COMBAT_FLAG]: { schemaVersion: 1, combatId } },
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
  const token = listOf<TokenLike>(scene?.tokens).find(
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
  if (combat) {
    const previous = storedResult(combat);
    if (alreadyApplied(previous, req.sequence, digest, "sequence"))
      return previous;
  } else {
    combat = await createCombat(req.combatId);
    outcome = "created";
  }

  const scene = combat.scene ?? null;
  const warnings: string[] = [];
  const existing = new Map<string, CombatantLike>();
  for (const c of listOf(combat.combatants)) {
    const key = flagValue(c, COMBATANT_FLAG);
    if (typeof key === "string") existing.set(key, c);
  }
  const creates: Dict[] = [];
  const updates: Dict[] = [];
  for (const entry of req.combatants) {
    const data = combatantData(entry, scene, warnings);
    const current = existing.get(entry.key);
    if (current) updates.push({ _id: docId(current), ...data });
    else
      creates.push({
        ...data,
        flags: { [MODULE_ID]: { [COMBATANT_FLAG]: entry.key } },
      });
  }
  const wanted = new Set(req.combatants.map((c) => c.key));
  const removals = [...existing]
    .filter(([key]) => !wanted.has(key))
    .map(([, c]) => docId(c));
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
      (c) => flagValue(c, COMBATANT_FLAG) === req.activeKey,
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
      [`flags.${MODULE_ID}.${COMBAT_FLAG}`]: {
        ...result,
        combatId: req.combatId,
      },
    },
    { turnEvents: false },
  );
  return result;
};
