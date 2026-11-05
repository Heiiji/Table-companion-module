import { MODULE_ID } from "../constants.js";
import { paragraphsHtml } from "../util/html.js";
import {
  contentsOf,
  FLAG_KEYS,
  flagRecord,
  foundryId,
  docId,
  type ActorItemLike,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";

/**
 * Minor-motivation reconciliation. The request carries the authoritative list
 * (one to five entries); each entry is one `motivationMineure` Item stamped
 * with its index. Only Items carrying that stamp are updated or removed — a
 * motivation the GM authored by hand in Foundry is never touched. The Knight
 * sheet renders the description as raw HTML, so the app's plain text is
 * escaped into paragraphs.
 */

interface MinorMotivationFlagV1 {
  schemaVersion: 1;
  index: number;
}

function minorMotivationFlag(
  item: ActorItemLike,
): MinorMotivationFlagV1 | null {
  const p = flagRecord(item, FLAG_KEYS.minorMotivation, (p) =>
    Number.isSafeInteger(p.index),
  );
  return p ? { schemaVersion: 1, index: p.index as number } : null;
}

export async function applyMinorMotivations(
  actor: ActorLike,
  motivations: string[],
): Promise<string[]> {
  const warnings: string[] = [];
  const managed = contentsOf(actor.items).filter(
    (item) =>
      item.type === "motivationMineure" && minorMotivationFlag(item) !== null,
  );
  const retained = new Map<number, ActorItemLike>();
  const remove: ActorItemLike[] = [];
  for (const item of managed) {
    const index = minorMotivationFlag(item)!.index;
    if (index < 0 || index >= motivations.length) {
      remove.push(item);
      continue;
    }
    if (retained.has(index)) {
      warnings.push(`minor_motivation_collision:${index}`);
      remove.push(item);
      continue;
    }
    retained.set(index, item);
  }
  if (remove.length > 0) {
    const valid = remove.filter((item) => foundryId.test(docId(item)));
    for (const item of remove.filter(
      (candidate) => !foundryId.test(docId(candidate)),
    ))
      warnings.push(
        `minor_motivation_delete_unavailable:${minorMotivationFlag(item)!.index}`,
      );
    if (valid.length > 0) {
      if (typeof actor.deleteEmbeddedDocuments === "function")
        await actor.deleteEmbeddedDocuments("Item", valid.map(docId));
      else
        for (const item of valid)
          warnings.push(
            `minor_motivation_delete_unavailable:${minorMotivationFlag(item)!.index}`,
          );
    }
  }

  // One update and one create for the whole list; an unchanged one is skipped.
  const updates: Dict[] = [];
  const creates: Dict[] = [];
  for (const [index, motivation] of motivations.entries()) {
    const flag: MinorMotivationFlagV1 = { schemaVersion: 1, index };
    const name = `Motivation mineure ${index + 1}`;
    const description = paragraphsHtml(motivation);
    const existing = retained.get(index);
    if (!existing) {
      if (typeof actor.createEmbeddedDocuments !== "function")
        warnings.push(`minor_motivation_unavailable:${index}`);
      else
        creates.push({
          name,
          type: "motivationMineure",
          system: { description },
          flags: { [MODULE_ID]: { [FLAG_KEYS.minorMotivation]: flag } },
        });
      continue;
    }
    if (
      (existing as Dict).name === name &&
      (existing.system as Dict | undefined)?.description === description
    )
      continue;
    if (
      typeof actor.updateEmbeddedDocuments !== "function" ||
      !foundryId.test(docId(existing))
    ) {
      warnings.push(`minor_motivation_unavailable:${index}`);
      continue;
    }
    updates.push({
      _id: docId(existing),
      name,
      "system.description": description,
      [`flags.${MODULE_ID}.${FLAG_KEYS.minorMotivation}`]: flag,
    });
  }
  if (updates.length > 0) await actor.updateEmbeddedDocuments!("Item", updates);
  if (creates.length > 0) await actor.createEmbeddedDocuments!("Item", creates);
  return warnings;
}
