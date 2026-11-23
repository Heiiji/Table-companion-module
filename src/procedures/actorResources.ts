import { MODULE_ID } from "../constants.js";
import { deletionEntry, forcedReplacement } from "../foundry/runtime.js";
import { canonicalize } from "../util/canonicalJson.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  clampToPrepared,
  resourcePaths,
  wornGear,
} from "./actorUpsert.patch.js";
import {
  MAX_RESOURCE_VALUE,
  RESOURCE_KEYS,
  type ResourceKey,
} from "./actorUpsert.types.js";
import {
  currentSheetValue,
  parseKnightSheet,
  planKnightSheet,
  type KnightSheetV1,
} from "./knightSheet.js";
import {
  LIVE_HEADER_KEYS,
  docId,
  alreadyApplied,
  replayDigests,
  assertKnightUpsertAuthority,
  assertBase,
  canonicalDigest,
  fieldsOf,
  hasPath,
  linkedActor,
  takeoverPatch,
  liveHeader,
  liveSequence,
  valueAt,
  writtenFields,
  integer,
  invalid,
  parseStoredResult,
  record,
  text,
  type LiveHeaderV1,
  contentsOf,
  type ActorLike,
  type Dict,
  type StoredResultV1,
  FLAG_KEYS,
} from "./upsertShared.js";

/**
 * Live current resources of a Knight player character (`actor.resources.v1`),
 * and of the non-player types in `NPC_POOLS` (health, armour, energy only).
 * Provisioning (`actor.upsert.v1`) writes current values once per approved
 * revision; this lane re-pushes them on every edit made in the app. It touches
 * ONLY the Actor bound to the character (which must be the one the app expects)
 * or, for a character imported from Foundry, the unbound Actor the app names by
 * id: it never creates, binds, or matches by name. Values land on the
 * stored current fields (never a maximum), clamped to the prepared maximum
 * when the Actor exposes one. Re-sends converge by sequence/digest like the
 * provisioning lanes.
 *
 * The request may also carry the character's `name` (with or without values).
 * With `previousName` it is a compare-and-set: an Actor renamed in Foundry
 * since the app last saw it refuses the request with `name_conflict` and
 * writes nothing, so Foundry's rename is the one the app adopts next. An
 * optional `base.resources` (the values the app last saw) guards the values
 * the same way: one moved in Foundry first refuses the whole request with
 * `base_conflict`.
 *
 * A PC request may instead carry `wear` (deploy or fold the armour) with
 * `previousWear`, the effective wear the app last saw: a compare-and-set that
 * refuses with `wear_conflict` when Foundry moved it first, while a capacity
 * holds the ascension, or when deploying with no armour. A generation 4 armour
 * is worn whatever `wear` stores: nothing is written (`wear_forced`). A wear
 * request carries no values, since a current is clamped to the maximum of the
 * gear worn before the switch.
 *
 * A PC request may also carry `sheet` (aspects, characteristics, unspent
 * experience, Glory total, age, nickname, major motivation; see
 * `knightSheet.ts`), always with `base.sheet` naming exactly its fields. A
 * stat or experience write that does not produce its target in Foundry (a cap,
 * the aspect maximum, a floor) is undone in a follow-up update and reported
 * `stat_clamped:<field>`: a write never leaves a stored base Foundry does not
 * show.
 *
 * Foundry drops a refused update whole and resolves without throwing, so every
 * update is read back: the result flag it carried not in place answers
 * `procedure_failed`, and nothing is recorded.
 */

/**
 * The non-player Knight types the lane also writes, with the resources each
 * carries and the `system` pool holding them. Their current is the top-level
 * `<pool>.value` (never the PC's worn gear), clamped to the prepared
 * `<pool>.max`; a pool the Actor's `options` switch off is not written.
 * Resilience and the derived pools (force field, shield) stay Foundry's.
 */
const NPC_POOLS = {
  pnj: { health: "sante", armour: "armure", energy: "energie" },
  creature: { health: "sante", armour: "armure", energy: "energie" },
  bande: { health: "sante" },
  vehicule: { armour: "armure", energy: "energie" },
} as const satisfies Record<string, Partial<Record<ResourceKey, string>>>;

const ACTOR_TYPES = ["knight", ...Object.keys(NPC_POOLS)] as ActorType[];
type ActorType = "knight" | keyof typeof NPC_POOLS;

export interface KnightActorResourcesV1 extends LiveHeaderV1<ActorType> {
  sequence: number;
  resources: Partial<Record<ResourceKey, number>>;
  name?: string;
  previousName?: string;
  sheet?: KnightSheetV1;
  base?: {
    resources?: Partial<Record<ResourceKey, number>>;
    sheet?: KnightSheetV1;
  };
  wear?: Wear;
  previousWear?: Wear | "ascension";
  /** A table that lost the Actor to another takes it back: the binding only,
   * never a value (any sent by an older app is ignored). */
  reclaim?: true;
}

/** The wears the app may set; `ascension` is a capacity's, never written. */
const WEARS = ["armure", "guardian", "tenueCivile"] as const;
type Wear = (typeof WEARS)[number];

/** The longest Actor name accepted, as `actor.upsert.v1`. */
const MAX_NAME = 200;

export type ActorResourcesResultV1 = StoredResultV1;

function resourceValues(
  value: unknown,
  path: string,
  actorType: ActorType,
): Partial<Record<ResourceKey, number>> {
  const r = value === undefined ? {} : record(value, path, RESOURCE_KEYS);
  const resources: Partial<Record<ResourceKey, number>> = {};
  for (const key of RESOURCE_KEYS) {
    if (r[key] === undefined) continue;
    if (actorType !== "knight" && !(key in NPC_POOLS[actorType]))
      invalid(`${path}.${key} is not written on a ${actorType}`);
    resources[key] = integer(r[key], `${path}.${key}`, 0, MAX_RESOURCE_VALUE);
  }
  return resources;
}

export function validateKnightActorResourcesV1(
  payload: unknown,
): KnightActorResourcesV1 {
  const p = record(payload, "actorResources", [
    ...LIVE_HEADER_KEYS,
    "sequence",
    "resources",
    "name",
    "previousName",
    "sheet",
    "base",
    "wear",
    "previousWear",
    "reclaim",
  ]);
  if (!ACTOR_TYPES.includes(p.actorType as ActorType))
    invalid("actorType must be knight, pnj, creature, bande or vehicule");
  const header = liveHeader(p, p.actorType as ActorType);
  const type = header.actorType;
  if (p.reclaim !== undefined && p.reclaim !== true)
    invalid("reclaim must be true when present");
  if (p.reclaim && (p.sheet !== undefined || p.wear !== undefined))
    invalid("reclaim never rides with sheet or wear");
  if (p.sheet !== undefined && type !== "knight")
    invalid(`sheet is not written on a ${type}`);
  if (p.sheet !== undefined && p.wear !== undefined)
    invalid("sheet never rides with wear");
  const resources = resourceValues(p.resources, "resources", type);
  const sheet =
    p.sheet === undefined ? undefined : parseKnightSheet(p.sheet, "sheet");
  const b =
    p.base === undefined
      ? undefined
      : record(p.base, "base", ["resources", "sheet"]);
  const base =
    b === undefined
      ? undefined
      : {
          ...(b.resources === undefined && b.sheet !== undefined
            ? {}
            : {
                resources: resourceValues(b.resources, "base.resources", type),
              }),
          ...(b.sheet === undefined
            ? {}
            : { sheet: parseKnightSheet(b.sheet, "base.sheet") }),
        };
  const sheetFields = (s: KnightSheetV1 | undefined) =>
    Object.keys(s === undefined ? {} : fieldsOf(s))
      .sort()
      .join();
  if (
    (sheet !== undefined || base?.sheet !== undefined) &&
    sheetFields(sheet) !== sheetFields(base?.sheet)
  )
    invalid("base.sheet must name every field of sheet");
  // A non-player Actor keeps Foundry's name: an app NPC's rides npc.upsert.
  if (type !== "knight" && p.name !== undefined)
    invalid(`name is not written on a ${type}`);
  const name =
    p.name === undefined ? undefined : text(p.name, "name", MAX_NAME, true);
  if (p.previousName !== undefined && name === undefined)
    invalid("previousName needs a name");
  const previousName =
    p.previousName === undefined
      ? undefined
      : text(p.previousName, "previousName", MAX_NAME, true);
  if ((p.wear === undefined) !== (p.previousWear === undefined))
    invalid("wear and previousWear go together");
  if (p.wear !== undefined) {
    if (type !== "knight") invalid(`wear is not written on a ${type}`);
    if (!WEARS.includes(p.wear as Wear))
      invalid("wear must be armure, guardian or tenueCivile");
    if (![...WEARS, "ascension"].includes(p.previousWear as string))
      invalid(
        "previousWear must be armure, ascension, guardian or tenueCivile",
      );
    // The meters wait for the wear to land: Foundry's maxima follow the gear.
    if (Object.keys(resources).length > 0 || base !== undefined)
      invalid("wear carries no resources nor base");
  }
  if (
    !p.reclaim &&
    Object.keys(resources).length === 0 &&
    name === undefined &&
    p.wear === undefined &&
    sheet === undefined
  )
    invalid(
      "resources needs at least one value, a name, a wear or a sheet field",
    );
  return {
    ...header,
    sequence: liveSequence(p),
    resources,
    ...(name === undefined ? {} : { name }),
    ...(previousName === undefined ? {} : { previousName }),
    ...(sheet === undefined ? {} : { sheet }),
    ...(base === undefined ? {} : { base }),
    ...(p.wear === undefined
      ? {}
      : {
          wear: p.wear as Wear,
          previousWear: p.previousWear as Wear | "ascension",
        }),
    ...(p.reclaim ? { reclaim: true as const } : {}),
  };
}

/** Stored current and prepared-maximum paths of each resource the Actor
 * carries: the PC's wear-aware ones, else the type's top-level pools that its
 * `options` leave on. */
function resourcePathsOf(
  actor: ActorLike,
  actorType: ActorType,
): Partial<Record<ResourceKey, [string, string?]>> {
  if (actorType === "knight") return resourcePaths(actor);
  const options = valueAt(actor.system, "options") as Dict | undefined;
  return Object.fromEntries(
    Object.entries(NPC_POOLS[actorType])
      .filter(([, pool]) => options?.[pool] !== false)
      .map(([key, pool]) => [key, [`${pool}.value`, `${pool}.max`]]),
  );
}

/** A reclaim takes the binding back and writes nothing else: the reclaiming
 * table then reads Foundry's current values. The values and name an older app
 * still sends with it are dropped here (before the digest, so a re-send with
 * or without them replays), and the second item says whether any was. */
function reclaimOnly(
  req: KnightActorResourcesV1,
): [KnightActorResourcesV1, boolean] {
  if (!req.reclaim) return [req, false];
  const { resources, name, previousName, base, ...identity } = req;
  return [
    { ...identity, resources: {} },
    Object.keys(resources).length > 0 ||
      name !== undefined ||
      previousName !== undefined ||
      base !== undefined,
  ];
}

export const actorResourcesV1: Procedure = async (payload) => {
  const [req, valuesIgnored] = reclaimOnly(
    validateKnightActorResourcesV1(payload),
  );
  assertKnightUpsertAuthority("actor.resources.v1");
  const digest = await canonicalDigest(req);
  const actor = await linkedActor(req, req.actorType, {
    takeover: true,
    reclaim: req.reclaim,
  });
  // Another table's Actor taken over: its lane records are that table's
  // (sequences, digests, written values), so none is read here.
  const takeover = takeoverPatch(actor, req);
  const id = docId(actor);

  const stored = takeover
    ? null
    : parseStoredResult(actor, FLAG_KEYS.actorResources);
  const previous = stored?.result ?? null;
  if (
    previous &&
    alreadyApplied(
      previous,
      req.sequence,
      await replayDigests(req, actor, digest),
      "sequence",
    )
  ) {
    return { ...previous, warnings: [...previous.warnings] };
  }
  // Compare-and-set on the name, after the replay above (an applied rename
  // re-sent under its own sequence replays). An Actor already carrying the
  // requested name has nothing to compare: the rename is in place.
  if (
    req.name !== undefined &&
    req.previousName !== undefined &&
    actor.name !== req.previousName &&
    actor.name !== req.name
  )
    throw new RpcError(
      "name_conflict",
      "the Actor was renamed in Foundry first",
    );

  const patch: Dict = {};
  const warnings: string[] = takeover ? ["binding_taken_over"] : [];
  if (valuesIgnored) warnings.push("reclaim_values_ignored");
  if (req.wear !== undefined) {
    const current = wornGear(actor);
    if (current === "ascension")
      throw new RpcError("wear_conflict", "a capacity holds the ascension");
    if (current !== req.previousWear && current !== req.wear)
      throw new RpcError("wear_conflict", "the wear moved in Foundry first");
    const armour = contentsOf(actor.items).find(
      (item) => item.type === "armure",
    );
    if (req.wear === "armure" && !armour)
      throw new RpcError("wear_conflict", "the Actor has no armour to deploy");
    if (Number((armour?.system as Dict | undefined)?.generation) >= 4)
      warnings.push("wear_forced");
    else if ((actor.system as Dict | undefined)?.wear !== req.wear)
      patch["system.wear"] = req.wear;
  }

  const paths = resourcePathsOf(actor, req.actorType);
  const pathOf = (field: string): string | undefined => {
    if (!field.startsWith("resources.")) return undefined;
    const path = paths[field.slice("resources.".length) as ResourceKey]?.[0];
    return path && hasPath(actor.system, path) ? path : undefined;
  };
  assertBase(
    req,
    req.base,
    (field) => {
      if (field.startsWith("sheet."))
        return currentSheetValue(actor.system, field);
      const path = pathOf(field);
      return path === undefined ? undefined : valueAt(actor.system, path);
    },
    stored?.flag.written,
  );
  for (const key of RESOURCE_KEYS) {
    let value = req.resources[key];
    if (value === undefined) continue;
    const [path, maxPath] = paths[key] ?? [""];
    if (!path || !hasPath(actor.system, path)) {
      warnings.push(`resource_unavailable:${key}`);
      continue;
    }
    value = clampToPrepared(actor, key, value, maxPath, warnings);
    // A value Foundry already holds is not re-written: a capped re-send
    // changes nothing on the Actor but the result flag below.
    if (valueAt(actor.system, path) !== value) patch[`system.${path}`] = value;
  }
  if (req.name !== undefined && actor.name !== req.name) patch.name = req.name;
  const sheet = req.sheet
    ? planKnightSheet(
        actor.system,
        req.sheet,
        patch,
        warnings,
        typeof stored?.flag.gloryLineId === "string"
          ? stored.flag.gloryLineId
          : undefined,
      )
    : { checks: [], written: {}, gloryLineId: undefined };
  const result: ActorResourcesResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome: "updated",
    appliedRevision: req.sequence,
    appliedDigest: digest,
    warnings,
  };
  // A re-send of the values the flag already records, under a new sequence,
  // changes nothing: skip the write, or the flag update itself comes back from
  // the backend as an Actor change, the app re-sends, and the loop never ends.
  // Any other request writes the flag even with an empty patch: its
  // appliedRevision is what refuses an older sequence arriving later
  // (stale_revision). `contentDigest` lives in the flag only; the returned
  // result keeps the shape the backend decodes strictly.
  // Without a name, a wear or a sheet the digest stays the one older flags
  // recorded.
  const contentDigest = await canonicalDigest(
    req.name === undefined && req.wear === undefined && req.sheet === undefined
      ? req.resources
      : {
          resources: req.resources,
          ...(req.name === undefined ? {} : { name: req.name }),
          ...(req.wear === undefined ? {} : { wear: req.wear }),
          ...(req.sheet === undefined ? {} : { sheet: req.sheet }),
        },
  );
  if (
    Object.keys(patch).length === 0 &&
    stored?.flag.contentDigest === contentDigest
  )
    return result;
  const flagKey = `flags.${MODULE_ID}.${FLAG_KEYS.actorResources}`;
  const record = {
    ...result,
    warnings: [...warnings],
    contentDigest,
    ...(sheet.gloryLineId === undefined
      ? {}
      : { gloryLineId: sheet.gloryLineId }),
    // What Foundry holds once this update lands, for the next base compare.
    written: writtenFields(req, (field) => {
      if (field.startsWith("sheet.")) return sheet.written[field];
      const path = pathOf(field);
      if (path === undefined) return undefined;
      return `system.${path}` in patch
        ? patch[`system.${path}`]
        : valueAt(actor.system, path);
    }),
  };
  await actor.update({
    ...patch,
    ...takeover,
    // On a take-over the record replaces the other table's (Foundry 14);
    // before 14 the deletion entry in `takeover` precedes it.
    [flagKey]: takeover ? (forcedReplacement(record) ?? record) : record,
  });
  assertLanded(actor, req.sequence, warnings);

  // A stat or experience write Foundry does not prepare at its target is
  // undone: never a stored base the sheet does not show. Undoing an aspect can
  // cap a characteristic written beside it again, hence a second pass.
  let kept = sheet.checks;
  for (let pass = 0; pass < 2; pass++) {
    const off = kept.filter(
      (w) => valueAt(actor.system, w.prepared) !== w.target,
    );
    if (off.length === 0) break;
    kept = kept.filter((w) => !off.includes(w));
    const undo: Dict = {};
    const forget: Dict = {};
    let flagBack: Dict = {};
    for (const w of off) {
      Object.assign(undo, w.undo);
      flagBack = { ...flagBack, ...w.flag };
      warnings.push(`stat_clamped:${w.field}`);
      // Foundry merges the stored flag: the field must be deleted from it.
      const at = `sheet.${w.field}`;
      const [key, value] = deletionEntry(at.slice(at.lastIndexOf(".") + 1));
      forget[`${at.slice(0, at.lastIndexOf("."))}.${key}`] = value;
    }
    await actor.update({
      ...undo,
      [flagKey]: { ...flagBack, warnings: [...warnings], written: forget },
    });
    assertLanded(actor, req.sequence, warnings);
  }
  return result;
};

/** Foundry drops a refused update whole and resolves without throwing (as it
 * does when nothing differs), so the return value proves nothing. The result
 * flag rides every update of this lane: its sequence and warnings in place
 * prove the update landed. The values themselves are not compared — Foundry
 * prepares some of them (a pool clamped to its maximum, a worn armour's
 * points), and a prepared value that differs is not a dropped update. */
function assertLanded(
  actor: ActorLike,
  sequence: number,
  warnings: string[],
): void {
  const flag = valueAt(
    actor.flags,
    `${MODULE_ID}.${FLAG_KEYS.actorResources}`,
  ) as Dict | undefined;
  if (
    flag?.appliedRevision !== sequence ||
    canonicalize(flag.warnings) !== canonicalize(warnings)
  )
    throw new RpcError(
      "procedure_failed",
      "actor.resources.v1: Foundry did not apply the update",
    );
}
