import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorUpsertV1,
  validateKnightActorUpsertV1,
  type ActorUpsertResultV1,
  type KnightActorUpsertV1,
} from "../src/procedures/actorUpsert.js";
import { MODULE_ID } from "../src/constants.js";
import {
  KNIGHT_COMPENDIUM_SOURCE_COMMIT,
  KNIGHT_COMPENDIUM_VERSION,
  KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1,
} from "../src/refdata/knightCompendiumCrosswalkV14_0_1.js";
import { RpcError } from "../src/rpc/errors.js";

const USER_ID = "user000000000001";
const ACTOR_ID = "actor00000000001";
const CATALOG_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface KnightSchemaFixture {
  foundryGeneration: number;
  knightSystemVersion: string;
  actorCreateAPI: string;
  actor: { system: Record<string, unknown> };
  minorMotivationItem: { type: string; system: { description: string } };
}

const KNIGHT_SCHEMA_FIXTURES = [13, 14].map(
  (generation) =>
    JSON.parse(
      readFileSync(
        new URL(
          `./fixtures/knight-3.58.33-foundry${generation}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as KnightSchemaFixture,
);

function approved(
  overrides: Partial<KnightActorUpsertV1> = {},
): KnightActorUpsertV1 {
  return {
    schemaVersion: 1,
    actorType: "knight",
    state: "approved",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    approvedRevision: 1,
    name: "Lancelot",
    foundryUserId: USER_ID,
    profile: {
      description: "Chevalier solaire",
      limitedDescription: "Une silhouette d'or",
      history: "Ancien pilote",
      origin: "Europe",
      age: "32",
      archetype: "Héros",
      metaArmour: "Warrior",
      coatOfArms: "Lion",
      nickname: "Sol",
      section: "Dragon",
      highFeat: "Survivant",
      majorMotivation: "Protéger l'humanité",
      minorMotivations: [
        "Respecter le blason",
        "Tenir parole",
        "Protéger les faibles",
      ],
    },
    ai: { code: "AUBE", nickname: "Lux", personality: "Curieuse" },
    aspects: { chair: 3, bete: 2, machine: 4, dame: 3, masque: 2 },
    characteristics: {
      chair: { deplacement: 2, force: 3, endurance: 2 },
      bete: { combat: 3, hargne: 2, instinct: 1 },
      machine: { tir: 4, savoir: 2, technique: 3 },
      dame: { aura: 2, parole: 2, sangFroid: 3 },
      masque: { discretion: 1, dexterite: 2, perception: 3 },
    },
    resources: { health: 40, hope: 10, armour: 25, energy: 15, contact: 2 },
    equipment: {
      selections: [
        {
          catalogId: "knight.weapon.railgun",
          quantity: 1,
          slotAlternativeId: "handheld",
        },
      ],
    },
    characterCreation: {
      schemaVersion: 1,
      creationCatalogDigest: CATALOG_DIGEST,
      tarotCatalogDigest: CATALOG_DIGEST,
      richCatalogDigest: CATALOG_DIGEST,
      publicMetadata: {
        heroTarot: {
          cardIds: ["card-1", "card-2", "card-3", "card-4", "card-5"],
          advantageSourceIds: ["card-1", "card-2"],
          disadvantageSourceId: "card-3",
          roleplayLine: "Un passé public sans secret du MJ.",
        },
        derivedSources: {
          defense: "combat",
          reaction: "tir",
          initiative: "perception",
          health: "endurance",
          contact: "aura",
        },
      },
    },
    ...overrides,
  };
}

function setPath(
  root: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== "object" || cursor[part] === null)
      cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function hasFixturePath(root: unknown, dotted: string): boolean {
  let cursor = root;
  for (const part of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null || !(part in cursor))
      return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return true;
}

interface FakeActor {
  id: string;
  name: string;
  type: string;
  flags: Record<string, unknown>;
  ownership: Record<string, unknown>;
  system: Record<string, unknown>;
  items: { contents: Array<Record<string, unknown>> };
  updates: Array<Record<string, unknown>>;
  events: string[];
  update(changes: Record<string, unknown>): Promise<void>;
  prepareData(): void;
  createEmbeddedDocuments: ReturnType<typeof vi.fn>;
  deleteEmbeddedDocuments: ReturnType<typeof vi.fn>;
}

function fakeActor(id = ACTOR_ID, name = "Existing"): FakeActor {
  const actor: FakeActor = {
    id,
    name,
    type: "knight",
    flags: {},
    ownership: {},
    system: {
      sante: { value: 1 },
      espoir: { value: 1 },
      contacts: { actuel: 1, value: 1 },
      equipements: { armure: { armure: { value: 1 }, energie: { value: 1 } } },
    },
    items: {
      contents: [{ name: "Foreign item", flags: { other: { owned: true } } }],
    },
    updates: [],
    events: [],
    update: async (changes) => {
      actor.events.push("update");
      actor.updates.push(changes);
      for (const [key, value] of Object.entries(changes)) {
        if (key === "name") actor.name = String(value);
        else if (key.startsWith("flags."))
          setPath(actor as unknown as Record<string, unknown>, key, value);
        else if (key === "ownership") {
          for (const [ownershipKey, level] of Object.entries(
            value as Record<string, unknown>,
          )) {
            if (ownershipKey.startsWith("-="))
              delete actor.ownership[ownershipKey.slice(2)];
            else actor.ownership[ownershipKey] = level;
          }
        } else if (key.startsWith("ownership."))
          setPath(actor as unknown as Record<string, unknown>, key, value);
        else if (key.startsWith("system."))
          setPath(actor as unknown as Record<string, unknown>, key, value);
      }
    },
    prepareData: () => actor.events.push("prepare"),
    createEmbeddedDocuments: vi.fn(
      async (_type, data: Record<string, unknown>[]) => {
        for (const source of data) {
          const item: Record<string, unknown> = {
            ...source,
            id: `item${String(actor.items.contents.length).padStart(12, "0")}`,
          };
          item.update = vi.fn(async (changes: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(changes))
              setPath(item, key, value);
          });
          actor.items.contents.push(item);
        }
      },
    ),
    deleteEmbeddedDocuments: vi.fn(async (_type, ids: string[]) => {
      actor.items.contents = actor.items.contents.filter(
        (item) => !ids.includes(String(item.id ?? item._id ?? "")),
      );
    }),
  };
  return actor;
}

function binding(actor: FakeActor, req: KnightActorUpsertV1): void {
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: req.worldId,
      tableId: req.tableId,
      characterId: req.characterId,
    },
  };
}

interface StubCompendium {
  active?: boolean;
  version?: string;
  documents: Record<string, Record<string, Record<string, unknown>>>;
}

function stubFoundry(
  actors: FakeActor[],
  create?: ReturnType<typeof vi.fn>,
  generation = 13,
  compendium?: StubCompendium,
): void {
  const collection = {
    contents: actors,
    get: (id: string) => actors.find((actor) => actor.id === id),
  };
  vi.stubGlobal("game", {
    user: { id: "gm", isGM: true },
    users: { get: (id: string) => (id === USER_ID ? { id } : undefined) },
    actors: collection,
    modules: {
      get: (id: string) =>
        id === "knight-compendium" && compendium
          ? {
              active: compendium.active ?? true,
              version: compendium.version ?? KNIGHT_COMPENDIUM_VERSION,
            }
          : undefined,
    },
    packs: {
      get: (pack: string) => {
        const documents = compendium?.documents[pack];
        if (!documents) return undefined;
        return {
          getDocument: async (id: string) => {
            const source = documents[id];
            return source
              ? { toObject: () => structuredClone(source) }
              : undefined;
          },
        };
      },
    },
    system: { id: "knight", version: "3.58.33" },
    release: { generation },
  });
  vi.stubGlobal("Actor", {
    implementation: {
      create:
        create ??
        vi.fn(async () => {
          const actor = fakeActor();
          actors.push(actor);
          return actor;
        }),
    },
  });
}

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

describe("actor.upsert.v1", () => {
  for (const fixture of KNIGHT_SCHEMA_FIXTURES) {
    it(`maps only schema-backed Knight 3.58.33 fields on Foundry ${fixture.foundryGeneration}`, async () => {
      expect(fixture.knightSystemVersion).toBe("3.58.33");
      expect(fixture.actorCreateAPI).toBe("Actor.implementation.create");
      const actor = fakeActor();
      actor.system = structuredClone(fixture.actor.system);
      stubFoundry([actor], undefined, fixture.foundryGeneration);

      const result = (await actorUpsertV1(
        approved({ assignedActorId: actor.id, equipment: undefined }),
        {} as never,
      )) as ActorUpsertResultV1;

      const systemKeys = actor.updates
        .flatMap((update) => Object.keys(update))
        .filter((key) => key.startsWith("system."));
      expect(systemKeys.length).toBeGreaterThan(20);
      for (const key of systemKeys)
        expect(hasFixturePath(fixture.actor, key), key).toBe(true);
      const motivationCreates = actor.createEmbeddedDocuments.mock.calls.map(
        (call) => call[1][0] as Record<string, unknown>,
      );
      expect(motivationCreates).toHaveLength(3);
      for (const created of motivationCreates) {
        expect(created.type).toBe(fixture.minorMotivationItem.type);
        expect(hasFixturePath(created, "system.description")).toBe(true);
      }
      expect(result.warnings).toEqual([]);
    });
  }

  it("creates once, applies only authored bases/current values, and returns partial equipment", async () => {
    const actors: FakeActor[] = [];
    let createdActor: FakeActor | undefined;
    const create = vi.fn(async (data: Record<string, unknown>) => {
      createdActor = fakeActor();
      createdActor.name = String(data.name);
      createdActor.flags = data.flags as Record<string, unknown>;
      createdActor.ownership = data.ownership as Record<string, unknown>;
      actors.push(createdActor);
      return createdActor;
    });
    stubFoundry(actors, create);
    const req = approved();

    const first = (await actorUpsertV1(
      req,
      {} as never,
    )) as ActorUpsertResultV1;

    expect(first.outcome).toBe("created");
    expect(first.resultDocId).toBe(ACTOR_ID);
    expect(first.appliedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.equipmentCompleteness).toBe("partial");
    expect(first.warnings).toEqual([
      "equipment_unmapped:knight.weapon.railgun",
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    const createData = create.mock.calls[0][0];
    expect(createData.type).toBe("knight");
    expect(createData.ownership).toEqual({ default: 0, [USER_ID]: 3 });
    expect(Object.keys(createData.ownership as object)).toEqual([
      "default",
      USER_ID,
    ]);

    const keys = createdActor!.updates.flatMap((update) => Object.keys(update));
    expect(keys).toContain("system.aspects.chair.base");
    expect(keys).toContain(
      "system.aspects.dame.caracteristiques.sangFroid.base",
    );
    expect(keys).toContain("system.sante.value");
    expect(keys).not.toContain("system.aspects.chair.value");
    expect(
      keys.some(
        (key) =>
          key.includes(".max") ||
          key.includes("defense") ||
          key.includes("tarot"),
      ),
    ).toBe(false);
    expect(createdActor!.events.indexOf("prepare")).toBeLessThan(
      createdActor!.events.lastIndexOf("update"),
    );
    expect(createdActor!.createEmbeddedDocuments).toHaveBeenCalledTimes(3);
    expect(
      createdActor!.createEmbeddedDocuments.mock.calls.map(
        (call) => (call[1][0] as Record<string, unknown>).type,
      ),
    ).toEqual(["motivationMineure", "motivationMineure", "motivationMineure"]);
    expect(createdActor!.items.contents[0]).toMatchObject({
      name: "Foreign item",
      flags: { other: { owned: true } },
    }); // unrelated Item preserved
    const creationFlagUpdate = createdActor!.updates.find(
      (update) => `flags.${MODULE_ID}.characterCreationV1` in update,
    );
    expect(
      creationFlagUpdate?.[`flags.${MODULE_ID}.characterCreationV1`],
    ).toMatchObject({
      schemaVersion: 1,
      approvedRevision: 1,
      publicMetadata: {
        heroTarot: {
          cardIds: req.characterCreation!.publicMetadata.heroTarot.cardIds,
        },
      },
    });

    const updateCount = createdActor!.updates.length;
    const replay = (await actorUpsertV1(
      req,
      {} as never,
    )) as ActorUpsertResultV1;
    expect(replay).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(createdActor!.updates).toHaveLength(updateCount); // exact idempotent replay is read-only
  });

  it("adopts only an explicitly assigned unbound Actor and never matches a name", async () => {
    const sameName = fakeActor(ACTOR_ID, "Lancelot");
    const created = fakeActor("actor00000000002", "Lancelot");
    const create = vi.fn(async () => created);
    stubFoundry([sameName], create);

    const made = (await actorUpsertV1(
      approved({ equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(made.outcome).toBe("created");
    expect(made.resultDocId).toBe(created.id);
    expect(create).toHaveBeenCalledTimes(1); // same name was ignored

    vi.unstubAllGlobals();
    const assigned = fakeActor();
    assigned.ownership = { default: 2, everyone: 3, stalePlayer: 3 };
    stubFoundry([assigned]);
    const adopted = (await actorUpsertV1(
      approved({ assignedActorId: assigned.id, equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(adopted.outcome).toBe("adopted");
    expect(assigned.ownership).toEqual({ default: 0, [USER_ID]: 3 });
    expect(assigned.updates[0]?.ownership).toEqual({
      default: 0,
      "-=everyone": null,
      "-=stalePlayer": null,
      [USER_ID]: 3,
    });
  });

  it("fails closed on duplicate bindings, deleted links, and actors bound elsewhere", async () => {
    const req = approved({ equipment: undefined });
    const a = fakeActor(ACTOR_ID);
    const b = fakeActor("actor00000000002");
    binding(a, req);
    binding(b, req);
    stubFoundry([a, b]);
    await expect(actorUpsertV1(req, {} as never)).rejects.toMatchObject({
      code: "binding_collision",
    });

    vi.unstubAllGlobals();
    const create = vi.fn();
    stubFoundry([], create);
    await expect(
      actorUpsertV1(
        approved({ expectedActorId: ACTOR_ID, equipment: undefined }),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "deleted_link" });
    expect(create).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const assigned = fakeActor();
    assigned.flags[MODULE_ID] = {
      binding: {
        schemaVersion: 1,
        worldId: "other",
        tableId: "other",
        characterId: "other",
      },
    };
    stubFoundry([assigned]);
    await expect(
      actorUpsertV1(
        approved({ assignedActorId: ACTOR_ID, equipment: undefined }),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "binding_conflict" });
  });

  it("requires GM authority and the pinned Knight/Foundry runtime", async () => {
    stubFoundry([]);
    vi.stubGlobal("game", {
      user: { isGM: false },
      users: { get: () => ({}) },
      actors: { contents: [], get: () => undefined },
      system: { id: "knight" },
      release: { generation: 13 },
    });
    await expect(actorUpsertV1(approved(), {} as never)).rejects.toBeInstanceOf(
      RpcError,
    );

    vi.unstubAllGlobals();
    stubFoundry([], undefined, 15);
    await expect(actorUpsertV1(approved(), {} as never)).rejects.toMatchObject({
      code: "unsupported_runtime",
    });

    vi.unstubAllGlobals();
    stubFoundry([]);
    vi.stubGlobal("game", {
      user: { id: "gm", isGM: true },
      users: { get: () => ({}) },
      actors: { contents: [], get: () => undefined },
      system: { id: "knight", version: "3.58.34" },
      release: { generation: 14 },
    });
    await expect(actorUpsertV1(approved(), {} as never)).rejects.toMatchObject({
      code: "unsupported_runtime",
    });
  });

  it("rejects unknown secret/derived/max/ownership fields at every request boundary", () => {
    for (const extra of [
      { secretTarot: "Le Pendu" },
      { defense: 12 },
      { max: 99 },
      { ownership: { default: 3 } },
      { system: { anything: true } },
    ]) {
      expect(() =>
        validateKnightActorUpsertV1({ ...approved(), ...extra }),
      ).toThrow(/not allowed/);
    }
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        aspects: { ...approved().aspects!, value: 99 },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        characterCreation: {
          ...approved().characterCreation!,
          publicMetadata: {
            ...approved().characterCreation!.publicMetadata,
            heroTarot: {
              ...approved().characterCreation!.publicMetadata.heroTarot,
              secretPast: "Amnésique — secret MJ",
            },
          },
        },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        equipment: { catalogIds: ["knight.weapon.pistolet-de-service"] },
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      validateKnightActorUpsertV1({
        ...approved(),
        equipment: {
          selections: [
            {
              catalogId: "knight.module.griffes-de-combat.l1",
              quantity: 1,
              slotAlternativeId: "bras_droit=1+bras_gauche=1",
            },
          ],
        },
      }),
    ).toThrow(/canonical slot allocation/);
  });

  it("allows official Tarot overlap, optional IA, and only the redacted public projection", async () => {
    const actor = fakeActor();
    stubFoundry([actor]);
    const overlap = approved({
      assignedActorId: actor.id,
      ai: undefined,
      equipment: undefined,
    });
    overlap.characterCreation!.publicMetadata.heroTarot.disadvantageSourceId =
      "card-1";
    await expect(actorUpsertV1(overlap, {} as never)).resolves.toMatchObject({
      outcome: "adopted",
    });
    expect(
      actor.updates
        .flatMap((update) => Object.keys(update))
        .some((key) => key.startsWith("system.equipements.ia.")),
    ).toBe(false);

    vi.unstubAllGlobals();
    const pendingActor = fakeActor();
    stubFoundry([pendingActor]);
    const pending = approved({
      assignedActorId: pendingActor.id,
      equipment: undefined,
      characterCreation: {
        ...approved().characterCreation!,
        publicMetadata: {
          ...approved().characterCreation!.publicMetadata,
          heroTarot: {
            ...approved().characterCreation!.publicMetadata.heroTarot,
            advantageSourceIds: ["card-2"],
            disadvantageSourceId: undefined,
            roleplayLine: "",
          },
        },
      },
    });
    await expect(actorUpsertV1(pending, {} as never)).resolves.toMatchObject({
      outcome: "adopted",
    });
    const creation = pendingActor.updates.find(
      (update) => `flags.${MODULE_ID}.characterCreationV1` in update,
    )?.[`flags.${MODULE_ID}.characterCreationV1`] as Record<string, unknown>;
    expect(creation).not.toHaveProperty("gmSecretPending");
    expect(
      (creation.publicMetadata as Record<string, Record<string, unknown>>)
        .heroTarot,
    ).not.toHaveProperty("disadvantageSourceId");
  });

  it("reconciles the authoritative motivation list using only TC-managed Items", async () => {
    const actor = fakeActor();
    const managed = (id: string, index: number) => {
      const item: Record<string, unknown> = {
        id,
        type: "motivationMineure",
        system: { description: "old" },
        flags: {
          [MODULE_ID]: {
            actorUpsertMinorMotivationV1: { schemaVersion: 1, index },
          },
        },
      };
      item.update = vi.fn(async (changes: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(changes))
          setPath(item, key, value);
      });
      return item;
    };
    const keep = managed("motivation000001", 0);
    actor.items.contents.push(
      keep,
      managed("motivation000002", 0),
      managed("motivation000003", 1),
      managed("motivation000004", 3),
      {
        id: "motivation000005",
        type: "motivationMineure",
        system: { description: "MJ-authored; untouched" },
      },
    );
    stubFoundry([actor]);
    const req = approved({
      assignedActorId: actor.id,
      equipment: undefined,
      profile: {
        ...approved().profile!,
        minorMotivations: ["Respecter le blason"],
      },
    });
    const result = (await actorUpsertV1(
      req,
      {} as never,
    )) as ActorUpsertResultV1;

    expect(result.warnings).toContain("minor_motivation_collision:0");
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", [
      "motivation000002",
      "motivation000003",
      "motivation000004",
    ]);
    expect(keep.system).toEqual({ description: "Respecter le blason" });
    expect(actor.items.contents).toContainEqual(
      expect.objectContaining({
        id: "motivation000005",
        system: { description: "MJ-authored; untouched" },
      }),
    );
  });

  it("warns instead of guessing when the exact Contact current path is unavailable", async () => {
    const actor = fakeActor();
    delete actor.system.contacts;
    stubFoundry([actor]);
    const result = (await actorUpsertV1(
      approved({ assignedActorId: actor.id, equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.warnings).toContain("resource_unavailable:contact");
    expect(
      actor.updates.flatMap((update) => Object.keys(update)),
    ).not.toContain("system.contacts.actuel");
  });

  it("keeps an unassigned Actor GM-only and returns an actionable assignment warning", async () => {
    const actor = fakeActor();
    actor.ownership = { default: 2, everyone: 3 };
    stubFoundry([actor]);
    const result = (await actorUpsertV1(
      approved({
        foundryUserId: undefined,
        assignedActorId: actor.id,
        equipment: undefined,
      }),
      {} as never,
    )) as ActorUpsertResultV1;

    expect(actor.ownership).toEqual({ default: 0 });
    expect(result.warnings).toContain("assign_foundry_user");
  });

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

  it("keeps a draft to name, binding, sync flags, and target-user ownership", async () => {
    const actor = fakeActor();
    stubFoundry([actor]);
    const req = approved({
      state: "draft",
      approvedRevision: 0,
      assignedActorId: actor.id,
    });
    const result = (await actorUpsertV1(
      req,
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.outcome).toBe("adopted");
    const keys = actor.updates.flatMap((update) => Object.keys(update));
    expect(keys.some((key) => key.startsWith("system."))).toBe(false);
    expect(
      keys.every(
        (key) =>
          key === "name" ||
          key === "ownership" ||
          key.startsWith(`flags.${MODULE_ID}.`),
      ),
    ).toBe(true);
  });
});
