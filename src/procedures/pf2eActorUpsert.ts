import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import {
  gameItems,
  gamePacks,
  gameSettings,
  gameUsers,
} from "../foundry/runtime.js";
import type { Procedure } from "../rpc/registry.js";
import {
  actorCollection,
  alreadyApplied,
  assertGMResponder,
  bindingFor,
  bindingId,
  bindingOf,
  canonicalDigest,
  contentsOf,
  createActorDocument,
  docId,
  FLAG_KEYS,
  flagValue,
  foundryId,
  identifier,
  integer,
  invalid,
  normalizedOwnership,
  normalizedOwnershipUpdate,
  parseStoredResult,
  PF2E_REQUIREMENT,
  record,
  supportsPf2eActorUpsertV1Runtime,
  text,
  uniqueBoundActor,
  type ActorLike,
  type Dict,
  type Outcome,
} from "./upsertShared.js";
import type {
  ActorUpsertResultV1,
  EquipmentCompleteness,
} from "./actorUpsert.types.js";

/**
 * `pf2e.actor.upsert.v1`: a Pathfinder 2e character DRAFT made from the apps.
 *
 * Every pf2e path below is source-derived (pf2e 8.6.1) and was never confirmed
 * against a live world. The procedure creates (or adopts, or finds by its
 * binding) a `character` Actor carrying the name, the ownership and the level,
 * and — only when it creates the Actor — embeds the ancestry, heritage,
 * background and class Items the request names by slug, cloned from the
 * system's own compendium packs. The Foundry GM completes the build in
 * Foundry: no attribute, skill, feat or equipment path is ever written, and
 * `system.abilities` in particular never (it would switch the character to
 * manual mode).
 */

const PROCEDURE = "pf2e.actor.upsert.v1";
const ACTOR_TYPE = "character";
const MAX_REVISION = 2_147_483_647;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The ABC items, in the order pf2e expects them embedded, with the system
 * compendium pack each is looked up in (source-derived (pf2e 8.6.1):
 * `system.pf2e.json` packs). */
const ABC_KINDS = ["ancestry", "heritage", "background", "class"] as const;
type AbcKind = (typeof ABC_KINDS)[number];
const ABC_PACKS: Record<AbcKind, string> = {
  ancestry: "pf2e.ancestries",
  heritage: "pf2e.heritages",
  background: "pf2e.backgrounds",
  class: "pf2e.classes",
};

export interface Pf2eActorUpsertV1 {
  schemaVersion: 1;
  actorType: "character";
  state: "draft";
  worldId: string;
  tableId: string;
  characterId: string;
  approvedRevision: number;
  name: string;
  foundryUserId?: string;
  assignedActorId?: string;
  expectedActorId?: string;
  pf2e: { level: number } & Partial<Record<AbcKind, string>>;
}

function optionalFoundryId(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : identifier(value, path, foundryId);
}

function slug(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  const s = text(value, path, 64, true);
  if (!SLUG.test(s)) invalid(`${path} must be a lowercase hyphenated slug`);
  return s;
}

export function validatePf2eActorUpsertV1(payload: unknown): Pf2eActorUpsertV1 {
  const p = record(payload, "pf2eActorUpsert", [
    "schemaVersion",
    "actorType",
    "state",
    "worldId",
    "tableId",
    "characterId",
    "approvedRevision",
    "name",
    "foundryUserId",
    "assignedActorId",
    "expectedActorId",
    "pf2e",
  ]);
  if (p.schemaVersion !== 1) invalid("schemaVersion must be 1");
  if (p.actorType !== ACTOR_TYPE) invalid("actorType must be character");
  if (p.state !== "draft") invalid("state must be draft");
  const assignedActorId = optionalFoundryId(
    p.assignedActorId,
    "assignedActorId",
  );
  const expectedActorId = optionalFoundryId(
    p.expectedActorId,
    "expectedActorId",
  );
  const foundryUserId = optionalFoundryId(p.foundryUserId, "foundryUserId");
  if (foundryUserId === "default")
    invalid("foundryUserId cannot be the reserved ownership key default");
  if (assignedActorId && expectedActorId && assignedActorId !== expectedActorId)
    invalid("assignedActorId cannot replace a different expectedActorId");
  const b = record(p.pf2e, "pf2e", ["level", ...ABC_KINDS]);
  const pf2e: Pf2eActorUpsertV1["pf2e"] = {
    level: integer(b.level, "pf2e.level", 1, 20),
  };
  for (const kind of ABC_KINDS) {
    const value = slug(b[kind], `pf2e.${kind}`);
    if (value !== undefined) pf2e[kind] = value;
  }
  return {
    schemaVersion: 1,
    actorType: ACTOR_TYPE,
    state: "draft",
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    characterId: identifier(p.characterId, "characterId", bindingId),
    approvedRevision: integer(
      p.approvedRevision,
      "approvedRevision",
      1,
      MAX_REVISION,
    ),
    name: text(p.name, "name", 200, true),
    ...(foundryUserId === undefined ? {} : { foundryUserId }),
    ...(assignedActorId === undefined ? {} : { assignedActorId }),
    ...(expectedActorId === undefined ? {} : { expectedActorId }),
    pf2e,
  };
}

const COMPLETENESS: readonly string[] = [
  "not_requested",
  "complete",
  "partial",
];

function storedResult(actor: ActorLike): ActorUpsertResultV1 | null {
  const stored = parseStoredResult(actor, FLAG_KEYS.pf2eUpsert);
  if (
    !stored ||
    !COMPLETENESS.includes(String(stored.flag.equipmentCompleteness))
  )
    return null;
  return {
    ...stored.result,
    equipmentCompleteness: stored.flag
      .equipmentCompleteness as EquipmentCompleteness,
  };
}

/** The world's migration schema version, stamped on the created Actor:
 * source-derived (pf2e 8.6.1), an Actor created without
 * `system._migration.version` stays unstamped and a later world migration
 * replays every migration on it. A runtime without the setting is refused
 * before anything is created. */
function worldSchemaVersion(): number {
  const value = gameSettings()?.get("pf2e", "worldSchemaVersion");
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RpcError(
      "unsupported_runtime",
      "the pf2e world schema version is unavailable",
    );
  return value;
}

/** A compendium index entry's `system.slug`, whichever shape the index uses
 * (nested object, or the flat dotted key). */
function indexSlug(entry: Dict): unknown {
  const system = entry.system;
  if (typeof system === "object" && system !== null)
    return (system as Dict).slug;
  return entry["system.slug"];
}

/** True when an Item source carries a ChoiceSet rule with no stored
 * selection. Source-derived (pf2e 8.6.1): embedding such an Item opens a
 * blocking choice dialog in this GM's browser, which no one answers. */
export function hasUnresolvedChoice(source: Dict): boolean {
  const rules = (source.system as Dict | undefined)?.rules;
  return (
    Array.isArray(rules) &&
    rules.some(
      (rule) =>
        typeof rule === "object" &&
        rule !== null &&
        (rule as Dict).key === "ChoiceSet" &&
        (rule as Dict).selection == null,
    )
  );
}

/** Resolve each requested ABC slug to a compendium Item source. Returns the
 * kept sources (in ABC order) and one warning per slug not kept. A kind whose
 * Item is already embedded with that slug (a re-send after the embed went
 * through but the result flag did not) is not embedded again. */
async function abcSources(
  req: Pf2eActorUpsertV1,
  actor: ActorLike,
): Promise<{ sources: Dict[]; warnings: string[] }> {
  const sources: Dict[] = [];
  const warnings: string[] = [];
  const embedded = contentsOf(actor.items);
  const requested = ABC_KINDS.filter(
    (kind) =>
      req.pf2e[kind] !== undefined &&
      !embedded.some(
        (item) =>
          item.type === kind &&
          (item.system as Dict | undefined)?.slug === req.pf2e[kind],
      ),
  );
  if (requested.length === 0) return { sources, warnings };
  const items = gameItems();
  if (typeof items?.fromCompendium !== "function")
    throw new RpcError(
      "unsupported_runtime",
      "game.items.fromCompendium is unavailable",
    );
  for (const kind of requested) {
    const wanted = req.pf2e[kind]!;
    const pack = gamePacks()?.get(ABC_PACKS[kind]);
    if (!pack) {
      warnings.push(`abc_pack_missing:${kind}`);
      continue;
    }
    const index = [...(await pack.getIndex({ fields: ["system.slug"] }))];
    const entry = index.find((e) => indexSlug(e) === wanted);
    const doc = entry ? await pack.getDocument(String(entry._id)) : null;
    if (!doc) {
      warnings.push(`abc_item_not_found:${wanted}`);
      continue;
    }
    // fromCompendium stamps `_stats.compendiumSource` (the Item's identity);
    // a plain toObject() would not.
    const source = items.fromCompendium(doc);
    if (hasUnresolvedChoice(source)) {
      warnings.push(`abc_item_skipped:${wanted}`);
      continue;
    }
    sources.push(source);
  }
  return { sources, warnings };
}

/**
 * Resolution follows the Knight upsert: the binding first, then an explicit
 * unbound `assignedActorId`, else a new Actor. The binding flag rides the
 * create, and a creation marker with it, so a re-send after a failure part
 * way through finds the same Actor and finishes its creation (ABC items
 * included). The result flag is written LAST: until then the revision is
 * unrecorded and a re-send redoes the apply.
 */
export const pf2eActorUpsertV1: Procedure = async (payload) => {
  const req = validatePf2eActorUpsertV1(payload);
  assertGMResponder(PROCEDURE);
  if (!supportsPf2eActorUpsertV1Runtime())
    throw new RpcError(
      "unsupported_runtime",
      `${PROCEDURE} requires ${PF2E_REQUIREMENT}`,
    );
  if (req.foundryUserId && !gameUsers()?.get(req.foundryUserId))
    invalid("foundryUserId is not a User in this world");
  const digest = await canonicalDigest(req);
  const binding = bindingFor(req);
  const collection = actorCollection();
  let actor = uniqueBoundActor(collection, binding);
  let outcome: Outcome = "updated";
  if (req.expectedActorId) {
    if (!actor)
      throw new RpcError(
        "deleted_link",
        "the previously linked Actor no longer exists",
      );
    if (docId(actor) !== req.expectedActorId)
      throw new RpcError(
        "binding_conflict",
        "the binding points at a different Actor",
      );
  }
  if (actor && req.assignedActorId && docId(actor) !== req.assignedActorId)
    throw new RpcError(
      "binding_conflict",
      "assignedActorId differs from the bound Actor",
    );
  if (!actor && req.assignedActorId) {
    actor = collection.get(req.assignedActorId);
    if (!actor)
      throw new RpcError("actor_not_found", "assignedActorId does not exist");
    if (actor.type !== ACTOR_TYPE)
      invalid("assignedActorId must identify a character actor");
    if (bindingOf(actor))
      throw new RpcError(
        "binding_conflict",
        "assignedActorId is already bound to another character",
      );
    outcome = "adopted";
  } else if (!actor) {
    actor = await createActorDocument({
      name: req.name,
      type: ACTOR_TYPE,
      system: {
        details: { level: { value: req.pf2e.level } },
        _migration: { version: worldSchemaVersion() },
      },
      flags: {
        [MODULE_ID]: {
          [FLAG_KEYS.binding]: binding,
          [FLAG_KEYS.pf2eCreated]: true,
        },
      },
      ownership: normalizedOwnership(req.foundryUserId),
    });
    outcome = "created";
  }
  if (actor.type !== ACTOR_TYPE) invalid("bound Actor is not a character");
  const id = docId(actor);
  if (!foundryId.test(id))
    throw new Error("Foundry returned an invalid Actor id");

  const previous = storedResult(actor);
  if (
    previous &&
    alreadyApplied(previous, req.approvedRevision, digest, "draft")
  )
    return { ...previous, warnings: [...previous.warnings] };
  // A re-send after a failed first apply on an Actor this lane created.
  if (!previous && flagValue(actor, FLAG_KEYS.pf2eCreated) === true)
    outcome = "created";

  // pf2e raises a new character's default ownership to LIMITED on create
  // (source-derived (pf2e 8.6.1)); the replacement restores this lane's map.
  await actor.update({
    name: req.name,
    ownership: normalizedOwnershipUpdate(actor, req.foundryUserId),
    [`flags.${MODULE_ID}.${FLAG_KEYS.binding}`]: binding,
  });

  let equipmentCompleteness: EquipmentCompleteness = "not_requested";
  const warnings = req.foundryUserId ? [] : ["assign_foundry_user"];
  if (outcome === "created") {
    // ABC items only ever on the Actor this lane created: an adopted or bound
    // Actor keeps its build, and its level is never rewritten.
    const abc = await abcSources(req, actor);
    warnings.push(...abc.warnings);
    if (abc.sources.length > 0) {
      if (typeof actor.createEmbeddedDocuments !== "function")
        throw new RpcError(
          "unsupported_runtime",
          "Actor.createEmbeddedDocuments is unavailable",
        );
      // ONE call: pf2e expands the ABC grants and raises hit points only
      // through createEmbeddedDocuments, never through Actor.create's items.
      await actor.createEmbeddedDocuments("Item", abc.sources);
    }
    equipmentCompleteness = abc.warnings.length === 0 ? "complete" : "partial";
  }

  const result: ActorUpsertResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome,
    appliedRevision: req.approvedRevision,
    appliedDigest: digest,
    equipmentCompleteness,
    warnings,
  };
  await actor.update({
    [`flags.${MODULE_ID}.${FLAG_KEYS.pf2eUpsert}`]: { ...result },
  });
  return result;
};
