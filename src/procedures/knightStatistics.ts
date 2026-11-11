import type { Procedure } from "../rpc/registry.js";
import { CHARACTERISTIC_KEYS } from "./actorUpsert.types.js";
import {
  ASPECT_KEYS,
  actorCollection,
  assertKnightUpsertAuthority,
  bindingId,
  documentId,
  identifier,
  invalid,
  list,
  record,
  valueAt,
  type ActorLike,
} from "./upsertShared.js";

/**
 * Foundry's prepared numbers for up to 32 Knight Actors
 * (`knight.statistics.v1`): aspects, characteristics with their overdrives,
 * the pools (max and current), force field, defense, reaction and initiative,
 * as the Knight system prepared them. A read: it never writes, rolls, posts to
 * chat or opens a sheet.
 *
 * Knight sets its prepared values with `Object.defineProperty`: they are
 * non-enumerable instance properties, absent from `_source` and `toObject()`.
 * Each is therefore read by its explicit path on the prepared `actor.system`,
 * never by serializing or iterating it. A member Foundry has no number for, or
 * one that is not a safe integer within ±9999, answers `null`.
 */

const PROCEDURE = "knight.statistics.v1";
const MAX_IDS = 32;
const MAX_INT = 9999;

/** Which members each type carries (the rest answer `null`). `ia` and any
 * other type have no statistics. */
const MEMBERS = {
  knight: [
    "aspects",
    "characteristics",
    "health",
    "hope",
    "armour",
    "energy",
    "contact",
    "scores",
  ],
  pnj: ["aspects", "health", "armour", "energy", "scores"],
  creature: ["aspects", "health", "armour", "energy", "scores"],
  bande: ["aspects", "health", "scores"],
  vehicule: ["armour", "energy", "scores"],
  mechaarmure: [],
} as const satisfies Record<string, readonly string[]>;
type StatisticsType = keyof typeof MEMBERS;
type Member = (typeof MEMBERS)[StatisticsType][number];

type Int = number | null;
interface PoolV1 {
  max: Int;
  value: Int;
}

export interface KnightStatisticsActorV1 {
  actorId: string;
  actorType: StatisticsType;
  aspects: Record<(typeof ASPECT_KEYS)[number], Int> | null;
  characteristics: Record<string, { value: Int; overdrive: Int }> | null;
  health: PoolV1 | null;
  hope: PoolV1 | null;
  armour: PoolV1 | null;
  energy: PoolV1 | null;
  contact: PoolV1 | null;
  forceField: Int;
  defense: Int;
  reaction: Int;
  initiative: { value: Int; dice: Int } | null;
}

export interface KnightStatisticsV1 {
  schemaVersion: 1;
  actors: KnightStatisticsActorV1[];
  skipped: { actorId: string; reason: "not_found" | "no_statistics" }[];
}

function parseIds(value: unknown): string[] {
  const ids = list(value, "actorIds", MAX_IDS).map((id, i) =>
    identifier(id, `actorIds[${i}]`, documentId),
  );
  if (ids.length === 0) invalid("actorIds needs at least one id");
  if (new Set(ids).size !== ids.length) invalid("actorIds repeats an id");
  return ids;
}

function statistics(
  actor: ActorLike,
  actorId: string,
  actorType: StatisticsType,
): KnightStatisticsActorV1 {
  const has = (m: Member) =>
    (MEMBERS[actorType] as readonly string[]).includes(m);
  const int = (path: string): Int => {
    let v: unknown;
    try {
      v = valueAt(actor.system, path);
    } catch {
      return null;
    }
    return Number.isSafeInteger(v) && Math.abs(v as number) <= MAX_INT
      ? (v as number)
      : null;
  };
  const pool = (m: Member, maxPath: string, valuePath: string) =>
    has(m) ? { max: int(maxPath), value: int(valuePath) } : null;
  const scores = has("scores");
  return {
    actorId,
    actorType,
    aspects: has("aspects")
      ? (Object.fromEntries(
          ASPECT_KEYS.map((a) => [a, int(`aspects.${a}.value`)]),
        ) as KnightStatisticsActorV1["aspects"])
      : null,
    characteristics: has("characteristics")
      ? Object.fromEntries(
          ASPECT_KEYS.flatMap((a) =>
            CHARACTERISTIC_KEYS[a].map((c) => {
              const at = `aspects.${a}.caracteristiques.${c}`;
              return [
                c,
                {
                  value: int(`${at}.value`),
                  overdrive: int(`${at}.overdrive.value`),
                },
              ];
            }),
          ),
        )
      : null,
    health: pool("health", "sante.max", "sante.value"),
    hope: pool("hope", "espoir.max", "espoir.value"),
    armour: pool("armour", "armure.max", "armure.value"),
    energy: pool("energy", "energie.max", "energie.value"),
    contact: pool("contact", "contacts.value", "contacts.actuel"),
    forceField: int("champDeForce.value"),
    defense: scores ? int("defense.value") : null,
    reaction: scores ? int("reaction.value") : null,
    initiative: scores
      ? { value: int("initiative.value"), dice: int("initiative.dice") }
      : null,
  };
}

export const knightStatisticsV1: Procedure = async (payload) => {
  const p = record(payload, "payload", [
    "schemaVersion",
    "worldId",
    "actorIds",
  ]);
  if (p.schemaVersion !== 1) invalid("schemaVersion must be 1");
  identifier(p.worldId, "worldId", bindingId);
  const ids = parseIds(p.actorIds);
  assertKnightUpsertAuthority(PROCEDURE);
  const collection = actorCollection();
  const reply: KnightStatisticsV1 = {
    schemaVersion: 1,
    actors: [],
    skipped: [],
  };
  for (const actorId of ids) {
    const actor = collection.get(actorId);
    if (!actor) reply.skipped.push({ actorId, reason: "not_found" });
    else if (!Object.hasOwn(MEMBERS, String(actor.type)))
      reply.skipped.push({ actorId, reason: "no_statistics" });
    else
      reply.actors.push(
        statistics(actor, actorId, actor.type as StatisticsType),
      );
  }
  return reply;
};
