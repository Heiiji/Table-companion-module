import type { Procedure } from "../rpc/registry.js";
import { assertPayloadWithinCap } from "../rpc/errors.js";

/**
 * Phase 3 (augmented library): expose the GM's own Foundry compendium content over the RPC
 * channel so the app can merge it with the backend reference catalog into one library. The GM
 * already owns this content in their world — we surface it live, never redistribute or cache it
 * server-side. Strictly additive: absent ⇒ the app shows backend-only content.
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

// Minimal structural views of the Foundry globals we touch — kept local so this compiles against
// any foundry-vtt-types version without leaking `any` across the module.
interface PackLike {
  collection: string;
  metadata: { id?: string; label?: string; type?: string; system?: string };
  getIndex(): Promise<Iterable<Record<string, unknown>>>;
  getDocument(id: string): Promise<{ toObject(): unknown } | null | undefined>;
}
interface PacksLike {
  [Symbol.iterator](): Iterator<PackLike>;
  get(collection: string): PackLike | undefined;
}

function packs(): PacksLike {
  const g = globalThis as unknown as { game?: { packs?: PacksLike } };
  const p = g.game?.packs;
  if (!p) throw new Error("Foundry game.packs is unavailable");
  return p;
}

export const compendiumIndex: Procedure = async (payload) => {
  const p = (payload ?? {}) as IndexPayload;
  const documentName = CONTENT_TYPE_TO_DOCUMENT[p.contentType ?? "creature"] ?? "Actor";
  const query = (p.query ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(p.limit ?? 100, 1), MAX_INDEX_RESULTS);

  // Collect all matches (bounded by a hard scan cap), THEN sort + page — so results are stable and
  // the app can render "showing N of M" instead of a silently capped bare list.
  const matched: CompendiumSummary[] = [];
  let scanCapped = false;
  outer: for (const pack of packs()) {
    if (pack.metadata?.type !== documentName) continue;
    // Only filter by system when the pack declares one (world/module packs often don't).
    if (p.system && pack.metadata.system && pack.metadata.system !== p.system) continue;

    const index = await pack.getIndex();
    for (const entry of index) {
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
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
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
    throw new Error(`compendium.get requires '<pack>${ID_SEPARATOR}<docId>'`);
  }
  const packId = id.slice(0, sep);
  const docId = id.slice(sep + 1);
  const pack = packs().get(packId);
  if (!pack) throw new Error(`unknown compendium pack ${packId}`);
  const doc = await pack.getDocument(docId);
  if (!doc) throw new Error(`unknown document ${docId}`);
  // Raw Foundry document; the app normalizes it via its existing system mappers, so the module
  // stays system-agnostic (mirrors the agent's raw-document stance).
  const response = { id, document: doc.toObject() };
  // A large compendium document (a bestiary NPC with dozens of items/effects) can exceed the
  // envelope cap; fail loudly with payload_too_large rather than have the peer silently drop it.
  assertPayloadWithinCap(response);
  return response;
};
