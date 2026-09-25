import { MODULE_ID } from "../constants.js";
import {
  actorItems,
  flagValue,
  foundryId,
  itemID,
  type ActorItemLike,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";

/**
 * Minor-motivation reconciliation. The request carries the authoritative list
 * (one to five entries); each entry is one `motivationMineure` Item stamped
 * with its index. Only Items carrying that stamp are updated or removed — a
 * motivation the GM authored by hand in Foundry is never touched.
 */

interface MinorMotivationFlagV1 {
  schemaVersion: 1;
  index: number;
}

function minorMotivationFlag(
  item: ActorItemLike,
): MinorMotivationFlagV1 | null {
  const value = flagValue(item, "actorUpsertMinorMotivationV1");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (p.schemaVersion !== 1 || !Number.isSafeInteger(p.index)) return null;
  return { schemaVersion: 1, index: p.index as number };
}

export async function applyMinorMotivations(
  actor: ActorLike,
  motivations: string[],
): Promise<string[]> {
  const warnings: string[] = [];
  const managed = actorItems(actor).filter(
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
    const valid = remove.filter((item) => foundryId.test(itemID(item)));
    for (const item of remove.filter(
      (candidate) => !foundryId.test(itemID(candidate)),
    ))
      warnings.push(
        `minor_motivation_delete_unavailable:${minorMotivationFlag(item)!.index}`,
      );
    if (valid.length > 0) {
      if (typeof actor.deleteEmbeddedDocuments === "function")
        await actor.deleteEmbeddedDocuments("Item", valid.map(itemID));
      else
        for (const item of valid)
          warnings.push(
            `minor_motivation_delete_unavailable:${minorMotivationFlag(item)!.index}`,
          );
    }
  }

  for (const [index, motivation] of motivations.entries()) {
    const flag: MinorMotivationFlagV1 = { schemaVersion: 1, index };
    const existing = retained.get(index);
    if (existing?.update) {
      await existing.update({
        name: `Motivation mineure ${index + 1}`,
        "system.description": motivation,
        [`flags.${MODULE_ID}.actorUpsertMinorMotivationV1`]: flag,
      });
      continue;
    }
    if (existing) {
      warnings.push(`minor_motivation_unavailable:${index}`);
      continue;
    }
    if (typeof actor.createEmbeddedDocuments !== "function") {
      warnings.push(`minor_motivation_unavailable:${index}`);
      continue;
    }
    await actor.createEmbeddedDocuments("Item", [
      {
        name: `Motivation mineure ${index + 1}`,
        type: "motivationMineure",
        system: { description: motivation },
        flags: {
          [MODULE_ID]: { actorUpsertMinorMotivationV1: flag },
        },
      },
    ]);
  }
  return warnings;
}
