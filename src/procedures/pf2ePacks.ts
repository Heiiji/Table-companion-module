import {
  gameItems,
  gamePacks,
  type PackDocumentLike,
} from "../foundry/runtime.js";
import { packDocuments, type Dict } from "./upsertShared.js";

/** The pf2e compendium helpers the creation, completion and live lanes share. */

/** A compendium index entry's `system.slug`, whichever shape the index uses
 * (nested object, or the flat dotted key). */
export function indexSlug(entry: Dict): unknown {
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

/** Compendium sources by slug: one index read per pack, and the documents of
 * every slug `prefetch`ed together in one request rather than one each. */
export class PackLookup {
  #indexes = new Map<string, Map<string, string> | null>();
  /** Fetched documents by `pack/id`; null when the pack does not hold it. */
  #docs = new Map<string, PackDocumentLike | null>();

  async prefetch(packId: string, slugs: string[]): Promise<void> {
    if (!this.#indexes.has(packId)) {
      const pack = gamePacks()?.get(packId);
      const index = pack
        ? [...(await pack.getIndex({ fields: ["system.slug"] }))]
        : null;
      this.#indexes.set(
        packId,
        index &&
          new Map(index.map((e) => [String(indexSlug(e)), String(e._id)])),
      );
    }
    const index = this.#indexes.get(packId);
    const ids = slugs
      .map((s) => index?.get(s))
      .filter((id): id is string => !!id && !this.#docs.has(`${packId}/${id}`));
    if (ids.length === 0) return;
    const docs = await packDocuments(packId, ids);
    for (const id of ids)
      this.#docs.set(`${packId}/${id}`, docs.get(id) ?? null);
  }

  async source(packId: string, wanted: string): Promise<Dict | "missing"> {
    await this.prefetch(packId, [wanted]);
    const id = this.#indexes.get(packId)?.get(wanted);
    const doc = id ? this.#docs.get(`${packId}/${id}`) : null;
    if (!doc) return "missing";
    // fromCompendium stamps `_stats.compendiumSource` (the Item's identity).
    return gameItems()!.fromCompendium!(doc);
  }
}
