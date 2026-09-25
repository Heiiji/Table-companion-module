import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorUpsertV1,
  type ActorUpsertResultV1,
} from "../src/procedures/actorUpsert.js";
import { MODULE_ID } from "../src/constants.js";
import {
  KNIGHT_COMPENDIUM_SOURCE_COMMIT,
  KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1,
} from "../src/refdata/knightCompendiumCrosswalkV14_0_1.js";
import {
  approved,
  fakeActor,
  stubFoundry,
  type StubCompendium,
} from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

describe("Knight Compendium 14.0.1 crosswalk", () => {
  it("pins every creation armour, weapon, and module-level identity", () => {
    const ids = Object.keys(KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1);
    expect(KNIGHT_COMPENDIUM_SOURCE_COMMIT).toBe(
      "a7c06e20245247752b5d350f8252a8b89ddeed9c",
    );
    expect(ids.filter((id) => id.startsWith("knight.armour."))).toHaveLength(9);
    expect(ids.filter((id) => id.startsWith("knight.weapon."))).toHaveLength(
      12,
    );
    expect(ids.filter((id) => id.startsWith("knight.module."))).toHaveLength(
      40,
    );
    expect(ids.some((id) => id.startsWith("knight.enhancement."))).toBe(false);
    for (const [id, documents] of Object.entries(
      KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1,
    )) {
      expect(documents.length, id).toBeGreaterThan(0);
      for (const document of documents) {
        expect(document.pack, id).toMatch(
          /^knight-compendium\.(armours-base|weapons-standard|modules-standard)$/,
        );
        expect(document.documentId, id).toMatch(/^[A-Za-z0-9_-]{16}$/);
        if (id.startsWith("knight.module.")) {
          expect(document.itemType, id).toBe("module");
          expect(document.moduleFamilyId, id).toBeTruthy();
          expect(document.moduleLevel, id).toBe(
            Number(id.match(/\.l([123])$/)?.[1]),
          );
        }
      }
    }
  });
});

describe("actor.upsert.v1 equipment import", () => {
  it("imports the pinned armour, multi-mode weapon, and highest module level exactly once", async () => {
    const actor = fakeActor();
    const item = (
      id: string,
      type: "armure" | "arme" | "module",
      system: Record<string, unknown> = {},
    ) => ({ _id: id, name: `Fixture ${id}`, type, system, flags: {} });
    const compendium: StubCompendium = {
      documents: {
        "knight-compendium.armours-base": {
          "22826f541c384281": item("22826f541c384281", "armure"),
        },
        "knight-compendium.weapons-standard": {
          df9dd63546eda43e: item("df9dd63546eda43e", "arme"),
          "448e9e2430dceff8": item("448e9e2430dceff8", "arme"),
        },
        "knight-compendium.modules-standard": {
          sXd50IHvgwvC3R5k: item("sXd50IHvgwvC3R5k", "module", {
            niveau: {
              value: "1",
              max: 3,
              liste: [1, 2, 3],
              details: { n1: {}, n2: {}, n3: {} },
            },
            slots: {
              tete: 0,
              brasGauche: 0,
              brasDroit: 0,
              torse: 0,
              jambeGauche: 1,
              jambeDroite: 1,
            },
          }),
        },
      },
    };
    stubFoundry([actor], undefined, 14, compendium);
    const equipment = {
      selections: [
        { catalogId: "knight.armour.warrior", quantity: 1 },
        {
          catalogId: "knight.weapon.pistolet-de-service",
          quantity: 2,
          slotAlternativeId: "handheld",
        },
        {
          catalogId: "knight.module.saut.l1",
          quantity: 1,
          slotAlternativeId: "jambe_gauche=1+jambe_droite=1",
        },
        {
          catalogId: "knight.module.saut.l2",
          quantity: 1,
          slotAlternativeId: "jambe_gauche=1+jambe_droite=1",
        },
      ],
    };

    const first = (await actorUpsertV1(
      approved({ assignedActorId: actor.id, equipment }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(first.equipmentCompleteness).toBe("complete");
    expect(first.warnings).toEqual([]);
    const imported = actor.items.contents.filter((candidate) =>
      ["armure", "arme", "module"].includes(String(candidate.type)),
    );
    expect(imported.map((candidate) => candidate.type)).toEqual([
      "armure",
      "module",
      "arme",
      "arme",
      "arme",
      "arme",
    ]);
    const module = imported.find((candidate) => candidate.type === "module")!;
    expect(module.system).toMatchObject({
      niveau: { value: "2" },
      slots: { jambeGauche: 1, jambeDroite: 1 },
    });
    expect(module.flags).toMatchObject({
      [MODULE_ID]: {
        equipmentCatalogVariantV1: {
          schemaVersion: 1,
          catalogIds: ["knight.module.saut.l1", "knight.module.saut.l2"],
          quantity: 1,
          instanceIndex: 0,
          slotAlternativeId: "jambe_gauche=1+jambe_droite=1",
          moduleLevel: 2,
        },
      },
    });

    const createCount = actor.createEmbeddedDocuments.mock.calls.length;
    const replay = await actorUpsertV1(
      approved({ assignedActorId: actor.id, equipment }),
      {} as never,
    );
    expect(replay).toEqual(first);
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(createCount);

    const upgraded = (await actorUpsertV1(
      approved({
        assignedActorId: actor.id,
        approvedRevision: 2,
        equipment: {
          selections: [
            ...equipment.selections,
            {
              catalogId: "knight.module.saut.l3",
              quantity: 1,
              slotAlternativeId: "jambe_gauche=1+jambe_droite=1",
            },
          ],
        },
      }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(upgraded.equipmentCompleteness).toBe("complete");
    const modules = actor.items.contents.filter(
      (candidate) => candidate.type === "module",
    );
    expect(modules).toHaveLength(1);
    expect(modules[0].system).toMatchObject({ niveau: { value: "3" } });
  });

  it("reports a missing or version-mismatched optional compendium without synthesizing items", async () => {
    const actor = fakeActor();
    stubFoundry([actor]);
    const missing = (await actorUpsertV1(
      approved({
        assignedActorId: actor.id,
        equipment: {
          selections: [{ catalogId: "knight.armour.warrior", quantity: 1 }],
        },
      }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(missing.equipmentCompleteness).toBe("partial");
    expect(missing.warnings).toContain("equipment_compendium_missing");
    expect(
      actor.items.contents.some((candidate) => candidate.type === "armure"),
    ).toBe(false);
  });

  it("reconciles only module-stamped equipment and keeps unmapped identities partial", async () => {
    const actor = fakeActor();
    actor.items.contents.push(
      {
        id: "managed000000001",
        type: "arme",
        flags: {
          [MODULE_ID]: { equipmentCatalogId: "knight.weapon.retired" },
        },
      },
      {
        id: "managed000000002",
        type: "arme",
        flags: {
          [MODULE_ID]: { equipmentCatalogId: "knight.weapon.railgun" },
        },
      },
    );
    stubFoundry([actor]);

    const partial = (await actorUpsertV1(
      approved({ assignedActorId: actor.id }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(partial.equipmentCompleteness).toBe("partial");
    expect(partial.warnings).toContain(
      "equipment_unmapped:knight.weapon.railgun",
    );
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", [
      "managed000000001",
    ]);
    expect(actor.items.contents).toContainEqual(
      expect.objectContaining({ name: "Foreign item" }),
    );
    expect(actor.items.contents).toContainEqual(
      expect.objectContaining({ id: "managed000000002" }),
    );

    vi.unstubAllGlobals();
    const emptyActor = fakeActor();
    emptyActor.items.contents.push({
      id: "managed000000003",
      type: "arme",
      flags: {
        [MODULE_ID]: { equipmentCatalogId: "knight.weapon.retired" },
      },
    });
    stubFoundry([emptyActor]);
    const empty = (await actorUpsertV1(
      approved({
        assignedActorId: emptyActor.id,
        equipment: { selections: [] },
      }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(empty.equipmentCompleteness).toBe("complete");
    expect(emptyActor.items.contents).not.toContainEqual(
      expect.objectContaining({ id: "managed000000003" }),
    );
  });
});
