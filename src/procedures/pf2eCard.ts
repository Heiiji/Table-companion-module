import { MODULE_ID } from "../constants.js";
import { foundryGame, type Dict } from "../foundry/runtime.js";
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
  oneOf,
  record,
  supportsPf2eResourcesV1Runtime,
  uuid,
} from "./upsertShared.js";
import {
  cardAuthor,
  newDocumentId,
  postUnposted,
  runOnce,
  visibilityOf,
} from "./chatCards.js";

/**
 * `pf2e.card.v1`: the chat card of a spell cast or an item used in the app,
 * built by pf2e itself (`toMessage(..., { create: false })`) so Foundry shows
 * the same card as from the sheet — a spell's full card heightened to its
 * cast rank, with its inline buttons and save DC context, or an item's card.
 * The card is stamped with the request's `eventId` and created once; a retry
 * answers `alreadyPosted: true`. Nothing is ever spent here: never
 * `SpellcastingEntryPF2e#cast` (it expends the slot or focus point) nor
 * `ConsumablePF2e#consume` (it decrements the quantity) — the app writes its
 * counters itself, once.
 *
 * Source-derived (pf2e 8.6.1, identical in 8.5.1), never confirmed against a
 * live world: `SpellPF2e#toMessage(event, { actualCast, create, data:
 * { castRank }, mode })` (`item/spell/document.ts`) and
 * `ItemPF2e#toMessage(event, { create, mode })` (`item/base/document.ts`),
 * which with `create: false` return the unsaved message.
 */

export const PROCEDURE = "pf2e.card.v1";
export const CARD_LANE = "pf2e.card";

const PAYLOAD_KEYS = [
  "eventId",
  "origin",
  "actorId",
  "kind",
  "itemId",
  "castRank",
  "visibility",
] as const;

const ORIGINS = ["app", "player"] as const;
const KINDS = ["spell", "item"] as const;
const VISIBILITIES = ["public", "gm"] as const;
/** The Item types whose card the app can ask for (pf2e's sheet posts each). */
const ITEM_TYPES = [
  "action",
  "feat",
  "weapon",
  "armor",
  "shield",
  "equipment",
  "consumable",
  "treasure",
  "backpack",
  "ammo",
] as const;

export interface Pf2eCardV1 {
  eventId: string;
  origin: (typeof ORIGINS)[number];
  actorId: string;
  kind: (typeof KINDS)[number];
  itemId: string;
  castRank: number | null;
  visibility: (typeof VISIBILITIES)[number];
}

export interface Pf2eCardResultV1 {
  messageId: string;
  alreadyPosted: boolean;
}

interface CardItem {
  type?: string;
  /** A spell's rank as pf2e prepares it (a focus spell or a cantrip is
   * heightened by itself). */
  rank?: number;
  toMessage?(
    event: null,
    options: Dict,
  ): Promise<{ toObject?(): Dict } | undefined>;
}

/** The strict payload: every key required, unknown keys refused; only a
 * spell carries a cast rank. */
export function validatePf2eCardV1(payload: unknown): Pf2eCardV1 {
  const p = record(payload, "payload", PAYLOAD_KEYS);
  for (const key of PAYLOAD_KEYS)
    if (!(key in p)) invalid(`payload.${key} is required`);
  const kind = oneOf(p.kind, "kind", KINDS);
  if (kind === "item" && p.castRank !== null)
    invalid("castRank must be null for an item");
  return {
    eventId: identifier(p.eventId, "eventId", uuid),
    origin: oneOf(p.origin, "origin", ORIGINS),
    actorId: identifier(p.actorId, "actorId", documentId),
    kind,
    itemId: identifier(p.itemId, "itemId", documentId),
    castRank:
      p.castRank === null ? null : integer(p.castRank, "castRank", 1, 10),
    visibility: oneOf(p.visibility, "visibility", VISIBILITIES),
  };
}

/** Registration gate: the pf2e live-counters floor. */
export function supportsPf2eCardV1Runtime(): boolean {
  return supportsPf2eResourcesV1Runtime();
}

async function post(req: Pf2eCardV1): Promise<Pf2eCardResultV1> {
  const actor = actorCollection().get(req.actorId);
  if (!actor)
    throw new RpcError("actor_not_found", `${PROCEDURE}: no such Actor`);
  const item = contentsOf(actor.items).find((i) => docId(i) === req.itemId) as
    CardItem | undefined;
  const isSpell = item?.type === "spell";
  const fits =
    req.kind === "spell"
      ? isSpell
      : (ITEM_TYPES as readonly unknown[]).includes(item?.type);
  const missing = () =>
    new RpcError(
      req.kind === "spell" ? "spell_not_found" : "item_not_found",
      `${PROCEDURE}: the Actor has no such ${req.kind}`,
    );
  if (!item || !fits || typeof item.toMessage !== "function") throw missing();

  // A rank under the spell's own is no cast pf2e knows: its toMessage then
  // recurses without end. The spell's own rank stands.
  const heightened =
    req.castRank !== null && req.castRank > (item.rank ?? 0)
      ? { castRank: req.castRank }
      : {};
  const message = await item.toMessage(null, {
    create: false,
    mode: req.visibility,
    ...(isSpell ? { actualCast: true, data: heightened } : {}),
  });
  const source = message?.toObject?.();
  if (!source) throw missing();

  const messageId = newDocumentId();
  const result: Pf2eCardResultV1 = { messageId, alreadyPosted: false };
  const author = cardAuthor(actor, req.visibility, false);
  const authorId = author?.id ?? foundryGame()?.user?.id ?? "";
  const { whisper, blind } = visibilityOf(req.visibility, authorId);
  const posted = await postUnposted(source, {
    _id: messageId,
    ...(author?.id ? { author: author.id } : {}),
    whisper,
    blind,
    flags: {
      ...((source.flags ?? {}) as Dict),
      [MODULE_ID]: {
        eventId: req.eventId,
        origin: req.origin,
        lane: CARD_LANE,
        result,
      },
    },
  });
  if (!posted)
    throw new RpcError(
      missing().code,
      `${PROCEDURE}: Foundry did not create the card`,
    );
  return result;
}

export const pf2eCardV1: Procedure = (payload) => {
  const req = validatePf2eCardV1(payload);
  assertLaneAuthority(
    PROCEDURE,
    supportsPf2eCardV1Runtime,
    PF2E_RESOURCES_REQUIREMENT,
  );
  return runOnce<Pf2eCardResultV1>(
    CARD_LANE,
    req.eventId,
    (r) => ({ ...r, alreadyPosted: true }),
    () => post(req),
  );
};
