import { MODULE_ID } from "../constants.js";
import {
  KNIGHT_COMPENDIUM_MODULE_ID,
  KNIGHT_COMPENDIUM_VERSION,
  KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1,
  type KnightEquipmentCrosswalkDocumentV1,
} from "../refdata/knightCompendiumCrosswalkV14_0_1.js";
import {
  actorItems,
  currentGame,
  flagValue,
  foundryId,
  invalid,
  itemID,
  type ActorItemLike,
  type ActorLike,
  type Dict,
} from "./upsertShared.js";
import {
  catalogId,
  type EquipmentCatalogSourceV1,
  type EquipmentCatalogVariantV1,
  type EquipmentCompleteness,
  type EquipmentSelectionV1,
} from "./actorUpsert.types.js";
import { canonicalSlotAlternative } from "./actorUpsert.validate.js";

/**
 * Equipment import for `actor.upsert.v1`, deliberately fail-closed. A catalog
 * selection maps through the pinned Knight Compendium 14.0.1 crosswalk to
 * compendium documents; each imported Item is stamped with the catalog identity
 * and variant it came from. Only Items carrying that stamp are ever replaced or
 * deleted; unmapped identities, a missing or different compendium, and data
 * that does not match the fixture all report `partial` rather than guess.
 */

function itemCatalogVariant(
  item: ActorItemLike,
): EquipmentCatalogVariantV1 | null {
  const value = flagValue(item, "equipmentCatalogVariantV1");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    !Array.isArray(p.catalogIds) ||
    p.catalogIds.length === 0 ||
    !p.catalogIds.every((id) => typeof id === "string" && catalogId.test(id)) ||
    new Set(p.catalogIds).size !== p.catalogIds.length ||
    !Number.isSafeInteger(p.quantity) ||
    (p.quantity as number) < 1 ||
    (p.quantity as number) > 10 ||
    !Number.isSafeInteger(p.instanceIndex) ||
    (p.instanceIndex as number) < 0 ||
    (p.instanceIndex as number) >= (p.quantity as number) ||
    (p.slotAlternativeId !== undefined &&
      typeof p.slotAlternativeId !== "string") ||
    (p.parentCatalogId !== undefined &&
      (typeof p.parentCatalogId !== "string" ||
        !catalogId.test(p.parentCatalogId))) ||
    (p.moduleLevel !== undefined && ![1, 2, 3].includes(Number(p.moduleLevel)))
  )
    return null;
  if (p.slotAlternativeId !== undefined) {
    try {
      canonicalSlotAlternative(
        p.slotAlternativeId,
        "equipmentCatalogVariantV1.slotAlternativeId",
      );
    } catch {
      return null;
    }
  }
  return {
    schemaVersion: 1,
    catalogIds: [...p.catalogIds].sort(),
    quantity: p.quantity as number,
    instanceIndex: p.instanceIndex as number,
    slotAlternativeId: p.slotAlternativeId as string | undefined,
    parentCatalogId: p.parentCatalogId as string | undefined,
    moduleLevel: p.moduleLevel as 1 | 2 | 3 | undefined,
  };
}

function itemCatalogIDs(item: ActorItemLike): string[] {
  const variant = itemCatalogVariant(item);
  if (variant) return variant.catalogIds;
  const value = flagValue(item, "equipmentCatalogId");
  return typeof value === "string" && catalogId.test(value) ? [value] : [];
}

function itemCatalogID(item: ActorItemLike): string {
  return itemCatalogIDs(item).at(-1) ?? "";
}

function itemCatalogSource(
  item: ActorItemLike,
): EquipmentCatalogSourceV1 | null {
  const value = flagValue(item, "equipmentCatalogSourceV1");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    typeof p.pack !== "string" ||
    typeof p.documentId !== "string" ||
    p.compendiumVersion !== KNIGHT_COMPENDIUM_VERSION ||
    p.knightSystemVersion !== "3.58.33"
  )
    return null;
  return {
    schemaVersion: 1,
    pack: p.pack,
    documentId: p.documentId,
    compendiumVersion: p.compendiumVersion,
    knightSystemVersion: p.knightSystemVersion,
  };
}

async function deleteManagedEquipment(
  actor: ActorLike,
  items: ActorItemLike[],
  warnings: string[],
): Promise<boolean> {
  if (items.length === 0) return true;
  const ids = items.map(itemID);
  if (
    ids.some((id) => !foundryId.test(id)) ||
    typeof actor.deleteEmbeddedDocuments !== "function"
  ) {
    for (const item of items)
      warnings.push(`equipment_delete_unavailable:${itemCatalogID(item)}`);
    return false;
  }
  await actor.deleteEmbeddedDocuments("Item", ids);
  return true;
}

interface DesiredEquipmentItem {
  catalogIds: string[];
  mapped: KnightEquipmentCrosswalkDocumentV1;
  quantity: number;
  instanceIndex: number;
  slotAlternativeId?: string;
  parentCatalogId?: string;
  moduleLevel?: 1 | 2 | 3;
}

function desiredEquipment(
  selections: EquipmentSelectionV1[],
  warnings: string[],
): DesiredEquipmentItem[] {
  const desired: DesiredEquipmentItem[] = [];
  const moduleFamilies = new Map<
    string,
    Omit<DesiredEquipmentItem, "instanceIndex">
  >();
  for (const selection of selections) {
    const documents = KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1[selection.catalogId];
    if (!documents) {
      warnings.push(`equipment_unmapped:${selection.catalogId}`);
      continue;
    }
    for (const mapped of documents) {
      if (mapped.moduleFamilyId && mapped.moduleLevel) {
        if (
          !selection.slotAlternativeId ||
          selection.slotAlternativeId === "handheld" ||
          selection.parentCatalogId
        )
          invalid(
            `equipment module ${selection.catalogId} has invalid placement`,
          );
        const existing = moduleFamilies.get(mapped.moduleFamilyId);
        if (!existing) {
          moduleFamilies.set(mapped.moduleFamilyId, {
            catalogIds: [selection.catalogId],
            mapped,
            quantity: selection.quantity,
            slotAlternativeId: selection.slotAlternativeId,
            moduleLevel: mapped.moduleLevel,
          });
        } else {
          if (
            existing.quantity !== selection.quantity ||
            existing.slotAlternativeId !== selection.slotAlternativeId
          )
            invalid(
              `equipment module family ${mapped.moduleFamilyId} must share quantity and placement`,
            );
          existing.catalogIds.push(selection.catalogId);
          if (mapped.moduleLevel > (existing.moduleLevel ?? 0)) {
            existing.mapped = mapped;
            existing.moduleLevel = mapped.moduleLevel;
          }
        }
      } else {
        if (mapped.itemType === "armure") {
          if (
            selection.quantity !== 1 ||
            selection.slotAlternativeId ||
            selection.parentCatalogId
          )
            invalid(
              `equipment armour ${selection.catalogId} has invalid semantics`,
            );
        } else if (
          mapped.itemType === "arme" &&
          (selection.slotAlternativeId !== "handheld" ||
            selection.parentCatalogId)
        ) {
          invalid(`equipment weapon ${selection.catalogId} must be handheld`);
        }
        for (
          let instanceIndex = 0;
          instanceIndex < selection.quantity;
          instanceIndex += 1
        ) {
          desired.push({
            catalogIds: [selection.catalogId],
            mapped,
            quantity: selection.quantity,
            instanceIndex,
            slotAlternativeId: selection.slotAlternativeId,
            parentCatalogId: selection.parentCatalogId,
          });
        }
      }
    }
  }
  for (const family of moduleFamilies.values()) {
    for (
      let instanceIndex = 0;
      instanceIndex < family.quantity;
      instanceIndex += 1
    )
      desired.push({ ...family, instanceIndex });
  }
  for (const item of desired) item.catalogIds.sort();
  return desired.sort((a, b) =>
    desiredEquipmentKey(a).localeCompare(desiredEquipmentKey(b)),
  );
}

function desiredEquipmentKey(item: DesiredEquipmentItem): string {
  return [
    item.catalogIds.join(","),
    item.mapped.pack,
    item.mapped.documentId,
    item.quantity,
    item.instanceIndex,
    item.slotAlternativeId ?? "",
    item.parentCatalogId ?? "",
    item.moduleLevel ?? 0,
  ].join("|");
}

function managedEquipmentKey(item: ActorItemLike): string | null {
  const source = itemCatalogSource(item);
  const ids = itemCatalogIDs(item);
  const variant = itemCatalogVariant(item);
  if (!source || ids.length === 0 || !variant) return null;
  return [
    ids.join(","),
    source.pack,
    source.documentId,
    variant.quantity,
    variant.instanceIndex,
    variant.slotAlternativeId ?? "",
    variant.parentCatalogId ?? "",
    variant.moduleLevel ?? 0,
  ].join("|");
}

function compendiumAvailabilityWarning(): string | null {
  const module = currentGame().modules?.get(KNIGHT_COMPENDIUM_MODULE_ID);
  if (!module?.active) return "equipment_compendium_missing";
  if (module.version !== KNIGHT_COMPENDIUM_VERSION)
    return `equipment_compendium_unsupported:${module.version ?? "unknown"}`;
  return null;
}

function applyModuleLevel(source: Dict, level: 1 | 2 | 3): boolean {
  if (
    typeof source.system !== "object" ||
    source.system === null ||
    Array.isArray(source.system)
  )
    return false;
  const system = { ...(source.system as Dict) };
  if (
    typeof system.niveau !== "object" ||
    system.niveau === null ||
    Array.isArray(system.niveau)
  )
    return false;
  const niveau = { ...(system.niveau as Dict) };
  const details = niveau.details;
  if (
    !Number.isSafeInteger(niveau.max) ||
    (niveau.max as number) < level ||
    !Array.isArray(niveau.liste) ||
    !niveau.liste.includes(level) ||
    typeof details !== "object" ||
    details === null ||
    !(`n${level}` in details)
  )
    return false;
  niveau.value = String(level);
  system.niveau = niveau;
  source.system = system;
  return true;
}

function applyModuleSlots(source: Dict, slotAlternativeId: string): boolean {
  if (
    typeof source.system !== "object" ||
    source.system === null ||
    Array.isArray(source.system)
  )
    return false;
  const system = { ...(source.system as Dict) };
  if (
    typeof system.slots !== "object" ||
    system.slots === null ||
    Array.isArray(system.slots)
  )
    return false;
  const foundryKeys = {
    tete: "tete",
    bras_gauche: "brasGauche",
    bras_droit: "brasDroit",
    torse: "torse",
    jambe_gauche: "jambeGauche",
    jambe_droite: "jambeDroite",
  } as const;
  const slots = { ...(system.slots as Dict) };
  if (Object.values(foundryKeys).some((key) => !(key in slots))) return false;
  for (const key of Object.values(foundryKeys)) slots[key] = 0;
  for (const part of slotAlternativeId.split("+")) {
    const [canonical, rawQuantity] = part.split("=");
    const foundry = foundryKeys[canonical as keyof typeof foundryKeys];
    const quantity = Number(rawQuantity);
    if (!foundry || !Number.isSafeInteger(quantity) || quantity < 1)
      return false;
    slots[foundry] = quantity;
  }
  system.slots = slots;
  source.system = system;
  return true;
}

export async function applyEquipment(
  actor: ActorLike,
  selections: EquipmentSelectionV1[] | undefined,
): Promise<{
  equipmentCompleteness: EquipmentCompleteness;
  warnings: string[];
}> {
  if (selections === undefined)
    return { equipmentCompleteness: "not_requested", warnings: [] };
  const warnings: string[] = [];
  const requested = new Set(selections.map((selection) => selection.catalogId));
  const desired = desiredEquipment(selections, warnings);
  const desiredByKey = new Map(
    desired.map((item) => [desiredEquipmentKey(item), item]),
  );
  const retainedKeys = new Set<string>();
  const unmappedRequested = new Set(
    selections
      .map((selection) => selection.catalogId)
      .filter((id) => KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1[id] === undefined),
  );
  const managed = actorItems(actor).filter(
    (item) => itemCatalogIDs(item).length > 0,
  );
  const stale: ActorItemLike[] = [];
  for (const item of managed) {
    const itemIDs = itemCatalogIDs(item);
    if (
      itemIDs.length > 0 &&
      itemIDs.every((id) => requested.has(id)) &&
      itemIDs.some((id) => unmappedRequested.has(id))
    ) {
      // A previous release may have managed an identity this exact fixture does
      // not know. Preserve it while requested; never guess a replacement.
      continue;
    }
    const key = managedEquipmentKey(item);
    if (key && desiredByKey.has(key) && !retainedKeys.has(key)) {
      retainedKeys.add(key);
      continue;
    }
    stale.push(item);
  }
  if (!(await deleteManagedEquipment(actor, stale, warnings))) {
    return { equipmentCompleteness: "partial", warnings };
  }

  const compendiumWarning =
    desired.length === 0 ? null : compendiumAvailabilityWarning();
  if (compendiumWarning) warnings.push(compendiumWarning);
  const packs = currentGame().packs;
  for (const item of desired) {
    const key = desiredEquipmentKey(item);
    if (retainedKeys.has(key) || compendiumWarning) continue;
    const pack = packs?.get(item.mapped.pack);
    const document = await pack?.getDocument(item.mapped.documentId);
    const raw = document?.toObject();
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      (raw as Dict).type !== item.mapped.itemType ||
      typeof actor.createEmbeddedDocuments !== "function"
    ) {
      warnings.push(`equipment_unavailable:${item.catalogIds.join("+")}`);
      continue;
    }
    const source = { ...(raw as Dict) };
    if (item.moduleLevel) {
      if (
        !applyModuleLevel(source, item.moduleLevel) ||
        !item.slotAlternativeId ||
        !applyModuleSlots(source, item.slotAlternativeId)
      ) {
        warnings.push(`equipment_unavailable:${item.catalogIds.join("+")}`);
        continue;
      }
    }
    delete source._id;
    delete source._stats;
    delete source.folder;
    delete source.ownership;
    const sourceFlags =
      typeof source.flags === "object" && source.flags !== null
        ? { ...(source.flags as Dict) }
        : {};
    const tcFlags =
      typeof sourceFlags[MODULE_ID] === "object" &&
      sourceFlags[MODULE_ID] !== null
        ? { ...(sourceFlags[MODULE_ID] as Dict) }
        : {};
    tcFlags.equipmentCatalogId = item.catalogIds.at(-1)!;
    tcFlags.equipmentCatalogVariantV1 = {
      schemaVersion: 1,
      catalogIds: item.catalogIds,
      quantity: item.quantity,
      instanceIndex: item.instanceIndex,
      ...(item.slotAlternativeId === undefined
        ? {}
        : { slotAlternativeId: item.slotAlternativeId }),
      ...(item.parentCatalogId === undefined
        ? {}
        : { parentCatalogId: item.parentCatalogId }),
      ...(item.moduleLevel === undefined
        ? {}
        : { moduleLevel: item.moduleLevel }),
    } satisfies EquipmentCatalogVariantV1;
    tcFlags.equipmentCatalogSourceV1 = {
      schemaVersion: 1,
      pack: item.mapped.pack,
      documentId: item.mapped.documentId,
      compendiumVersion: KNIGHT_COMPENDIUM_VERSION,
      knightSystemVersion: "3.58.33",
    } satisfies EquipmentCatalogSourceV1;
    sourceFlags[MODULE_ID] = tcFlags;
    source.flags = sourceFlags;
    await actor.createEmbeddedDocuments("Item", [source]);
  }
  return {
    equipmentCompleteness: warnings.length === 0 ? "complete" : "partial",
    warnings,
  };
}
