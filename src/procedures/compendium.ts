import {
  foundryGame,
  gamePacks,
  type CompendiumPackLike,
  type CompendiumPacksLike,
  type UserLike,
} from "../foundry/runtime.js";
import type { Procedure } from "../rpc/registry.js";
import { RpcError, assertPayloadWithinCap } from "../rpc/errors.js";
import { pairedAgentUser } from "../setup/identity.js";
import { log } from "../util/log.js";

/**
 * Live library passthrough: expose content that the paired service user is allowed to see as a
 * transient, local world section. Foundry access does not establish Table Companion
 * redistribution rights, content-pack admission, or permission to retain the data. The module does
 * not cache responses; callers must not persist them, use them to seed bundled/backend catalogs,
 * or include document content/selections in telemetry. Strictly additive: absent ⇒ no live world
 * section.
 *
 * `compendium.index({ system?, contentType?, query?, limit? })` → `{ entries: [summary] }`
 * `compendium.get({ id })` → `{ id, document }` (raw Foundry doc; the app maps it like an import)
 *
 * Entry ids are `"<packCollection>|<docId>"` ("|" separates because pack collections contain dots,
 * e.g. "pf2e.pathfinder-bestiary").
 */

const ID_SEPARATOR = "|";

const CONTENT_TYPE_TO_DOCUMENT: Record<string, string> = {
  creature: "Actor",
  npc: "Actor",
  spell: "Item",
  item: "Item",
  feat: "Item",
};

const MAX_INDEX_RESULTS = 500;

interface CompendiumSummary {
  id: string;
  name: string;
  img?: string;
  type?: string;
  pack: string;
  packLabel: string;
}

interface IndexPayload {
  system?: string;
  contentType?: string;
  query?: string;
  limit?: number;
  /**
   * Optional Item **subtype** filter (`entry.type`) — e.g. the Knight loadout subtypes
   * `module` | `arme` | `armure`. When set, only Items of that subtype are returned. Additive to
   * the envelope (a new optional request field), so no `ENVELOPE_VERSION` bump.
   */
  subtype?: string;
}

/** The document types this passthrough serves: the app reads creatures and items only. Journals,
 * scenes, roll tables, adventures and macros never leave the GM's session this way. */
const SERVED_DOCUMENT_TYPES = new Set(["Actor", "Item"]);

/**
 * Whether a pack may be read for the app. The procedure runs in the GM's browser with GM
 * authority, so Foundry's own visibility (`pack.visible`) would answer for the GM; the question
 * is whether the paired service user may observe it. Fails closed: no paired user, or a pack
 * without a permission API, is not readable.
 */
function readable(
  pack: CompendiumPackLike,
  agent: UserLike | undefined,
): boolean {
  if (!agent) return false;
  if (!SERVED_DOCUMENT_TYPES.has(pack.metadata?.type ?? "")) return false;
  if (typeof pack.testUserPermission !== "function") return false;
  return pack.testUserPermission(agent, "OBSERVER");
}

function packs(): CompendiumPacksLike {
  const p = gamePacks();
  if (!p) throw new Error("Foundry game.packs is unavailable");
  return p;
}

/** How long after `ready` a Gamemaster's browser starts warming the indexes: past the burst of
 * world loading, before a player is likely to search. */
const WARM_DELAY_MS = 15_000;

/**
 * Load the index of every pack the paired service user may read, one pack after another, so the
 * first `compendium.index` of a session finds Foundry's own index cache warm instead of loading
 * every pack against the request deadline. Sequential on purpose: it runs in the background and
 * must not compete with the table. Never throws; a pack that fails is left for the request to load.
 */
export async function warmCompendiumIndexes(): Promise<void> {
  const agent = pairedAgentUser();
  for (const pack of gamePacks() ?? []) {
    try {
      if (readable(pack, agent)) await pack.getIndex();
    } catch (err) {
      log.warn(`could not preload the index of ${pack.collection}`, err);
    }
  }
}

/** Start the warm-up WARM_DELAY_MS after `ready`, on a Gamemaster's browser only: only a GM ever
 * answers a request, and a player's browser has no reason to load the packs. */
export function scheduleCompendiumWarmup(): void {
  if (!foundryGame()?.user?.isGM) return;
  setTimeout(() => void warmCompendiumIndexes(), WARM_DELAY_MS);
}

export const compendiumIndex: Procedure = async (payload) => {
  const p = (payload ?? {}) as IndexPayload;
  const documentName =
    CONTENT_TYPE_TO_DOCUMENT[p.contentType ?? "creature"] ?? "Actor";
  const query = (p.query ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(p.limit ?? 100, 1), MAX_INDEX_RESULTS);

  // Collect all matches (bounded by a hard scan cap), THEN sort + page — so results are stable and
  // the app can render "showing N of M" instead of a silently capped bare list.
  const matched: CompendiumSummary[] = [];
  let scanCapped = false;
  const agent = pairedAgentUser();
  const readablePacks = [...packs()].filter(
    (pack) =>
      pack.metadata?.type === documentName &&
      readable(pack, agent) &&
      // Only filter by system when the pack declares one (world/module packs often don't).
      !(p.system && pack.metadata.system && pack.metadata.system !== p.system),
  );
  // A pack's first index is loaded from the server: read them all at once rather than one after
  // another against the request deadline.
  const indexes = await Promise.all(
    readablePacks.map((pack) => pack.getIndex()),
  );
  outer: for (const [i, pack] of readablePacks.entries()) {
    for (const entry of indexes[i]) {
      const name = String(entry.name ?? "");
      if (!name) continue;
      // Optional Item-subtype filter (Knight module/arme/armure); skip anything else.
      if (p.subtype && String(entry.type ?? "") !== p.subtype) continue;
      if (query && !name.toLowerCase().includes(query)) continue;
      matched.push({
        id: `${pack.collection}${ID_SEPARATOR}${String(entry._id ?? "")}`,
        name,
        img: typeof entry.img === "string" ? entry.img : undefined,
        type: typeof entry.type === "string" ? entry.type : undefined,
        pack: pack.collection,
        packLabel: pack.metadata.label ?? pack.collection,
      });
      if (matched.length >= MAX_INDEX_RESULTS) {
        scanCapped = true;
        break outer;
      }
    }
  }

  // Deterministic order: by name (code-unit), then id as a stable tie-break — locale-independent
  // so the same world yields the same paging on every client.
  matched.sort((a, b) =>
    a.name < b.name
      ? -1
      : a.name > b.name
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );

  const total = matched.length;
  const entries = matched.slice(0, limit);
  // truncated when we returned fewer than we found, or the scan itself hit the hard cap (more may exist).
  const truncated = total > entries.length || scanCapped;
  return { entries, total, truncated };
};

export const compendiumGet: Procedure = async (payload) => {
  const id = String((payload as { id?: unknown } | null)?.id ?? "").trim();
  const sep = id.indexOf(ID_SEPARATOR);
  if (sep <= 0) {
    throw new RpcError(
      "invalid_args",
      `compendium.get requires '<pack>${ID_SEPARATOR}<docId>'`,
    );
  }
  const packId = id.slice(0, sep);
  const docId = id.slice(sep + 1);
  const pack = packs().get(packId);
  // An unknown pack and one the service user may not see answer identically, so a request
  // cannot probe which hidden packs exist.
  if (!pack || !readable(pack, pairedAgentUser())) {
    throw new RpcError("not_found", "compendium entry not found");
  }
  const doc = await pack.getDocument(docId);
  if (!doc) throw new RpcError("not_found", "compendium entry not found");
  // Transient raw Foundry document for the requesting licensed/local session. It is normalized by
  // the app for this live view only; it is not admitted content and must not feed storage, catalogs,
  // or telemetry. The module stays system-agnostic and retains no copy.
  const response = { id, document: doc.toObject() };
  // A large compendium document (a bestiary NPC with dozens of items/effects) can exceed the
  // envelope cap; fail loudly with payload_too_large rather than have the peer silently drop it.
  assertPayloadWithinCap(response);
  return response;
};
