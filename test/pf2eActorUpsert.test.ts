import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { MODULE_ID, SETTING_AGENT_USER } from "../src/constants.js";
import {
  pf2eActorUpsertV1,
  validatePf2eActorUpsertV1,
  type Pf2eActorUpsertV1,
} from "../src/procedures/pf2eActorUpsert.js";
import {
  fakeActor,
  stubOperators,
  USER_ID,
  type FakeActor,
} from "./support/actorUpsertHarness.js";
import type { ActorUpsertResultV1 } from "../src/procedures/actorUpsert.types.js";

// SYNTHETIC, shape-only: the pf2e paths these fakes carry are source-derived
// (pf2e 8.6.1), not captured from a live world. The fakes model only what the
// procedure reads: `game.packs` ABC indexes with `system.slug`, a
// `fromCompendium` that clones and stamps the compendium source, the world
// schema version setting, and an Actor whose update applies dotted keys.

const COMPANION_ID = "companion0000001";
const SCHEMA = 0.959;

afterEach(() => vi.unstubAllGlobals());

function run(payload: unknown): Promise<ActorUpsertResultV1> {
  return Promise.resolve(
    pf2eActorUpsertV1(payload, {} as never),
  ) as Promise<ActorUpsertResultV1>;
}

function draft(overrides: Partial<Pf2eActorUpsertV1> = {}): Pf2eActorUpsertV1 {
  return {
    schemaVersion: 1,
    actorType: "character",
    state: "draft",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    approvedRevision: 1,
    name: "Amiri",
    foundryUserId: USER_ID,
    pf2e: {
      level: 3,
      ancestry: "human",
      heritage: "versatile-human",
      background: "barkeep",
      class: "barbarian",
    },
    ...overrides,
  };
}

function character(id = "actor00000000001"): FakeActor {
  const actor = fakeActor(id);
  actor.type = "character";
  actor.system = {};
  actor.items.contents = [];
  return actor;
}

function bind(actor: FakeActor, req = draft()): void {
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: req.worldId,
      tableId: req.tableId,
      characterId: req.characterId,
    },
  };
}

type Packs = Record<
  string,
  Array<{ _id: string; source: Record<string, unknown> }>
>;

function abcPacks(): Packs {
  const item = (slug: string, type: string, rules: unknown[] = []) => ({
    _id: `${slug.replace(/-/g, "").slice(0, 10).padEnd(10, "x")}000001`,
    source: { name: slug, type, system: { slug, rules } },
  });
  return {
    "pf2e.ancestries": [item("elf", "ancestry"), item("human", "ancestry")],
    "pf2e.heritages": [item("versatile-human", "heritage")],
    "pf2e.backgrounds": [
      item("barkeep", "background", [
        { key: "ChoiceSet", selection: "athletics" },
      ]),
    ],
    "pf2e.classes": [item("barbarian", "class")],
  };
}

interface World {
  actors: FakeActor[];
  create: Mock<
    (data: Record<string, unknown>, options?: unknown) => Promise<FakeActor>
  >;
  fromCompendium: ReturnType<typeof vi.fn>;
}

function stubWorld(
  actors: FakeActor[] = [],
  options: {
    packs?: Packs;
    version?: string;
    id?: string;
    generation?: number;
    isGM?: boolean;
    schema?: unknown;
  } = {},
): World {
  const packs = options.packs ?? abcPacks();
  const create = vi.fn(
    async (data: Record<string, unknown>, _options?: unknown) => {
      const actor = character(
        `created${String(actors.length).padStart(9, "0")}`,
      );
      actor.name = String(data.name);
      actor.type = String(data.type);
      actor.system = structuredClone(data.system as Record<string, unknown>);
      actor.flags = structuredClone(data.flags as Record<string, unknown>);
      actor.ownership = { ...(data.ownership as Record<string, unknown>) };
      // source-derived (pf2e 8.6.1): ActorPF2e.createDocuments raises a
      // character's default ownership to LIMITED.
      actor.ownership.default = 1;
      actors.push(actor);
      return actor;
    },
  );
  const fromCompendium = vi.fn(
    (doc: { toObject(): Record<string, unknown> }) => ({
      ...doc.toObject(),
      _stats: { compendiumSource: "Compendium.pf2e.test.Item.x" },
    }),
  );
  vi.stubGlobal("game", {
    user: { id: "gm", isGM: options.isGM ?? true },
    users: {
      get: (id: string) =>
        id === USER_ID || id === COMPANION_ID ? { id } : undefined,
    },
    actors: {
      contents: actors,
      get: (id: string) => actors.find((a) => a.id === id),
    },
    packs: {
      get: (id: string) => {
        const entries = packs[id];
        if (!entries) return undefined;
        return {
          getIndex: async ({ fields }: { fields?: string[] } = {}) =>
            entries.map((e) => ({
              _id: e._id,
              name: e.source.name,
              ...(fields?.includes("system.slug")
                ? {
                    system: {
                      slug: (e.source.system as { slug: string }).slug,
                    },
                  }
                : {}),
            })),
          getDocument: async (docId: string) => {
            const e = entries.find((x) => x._id === docId);
            return e ? { toObject: () => structuredClone(e.source) } : null;
          },
        };
      },
    },
    items: { fromCompendium },
    settings: {
      get: (scope: string, key: string) => {
        if (scope === "pf2e" && key === "worldSchemaVersion")
          return "schema" in options ? options.schema : SCHEMA;
        if (scope === MODULE_ID && key === SETTING_AGENT_USER)
          return COMPANION_ID;
        return "";
      },
    },
    system: { id: options.id ?? "pf2e", version: options.version ?? "8.6.1" },
    release: { generation: options.generation ?? 14 },
  });
  vi.stubGlobal("Actor", { implementation: { create } });
  return { actors, create, fromCompendium };
}

function embedded(actor: FakeActor): Array<Record<string, unknown>> {
  return actor.createEmbeddedDocuments.mock.calls.flatMap(
    (call) => call[1] as Array<Record<string, unknown>>,
  );
}

function storedFlag(actor: FakeActor): Record<string, unknown> {
  return (actor.flags[MODULE_ID] as Record<string, unknown>)
    .pf2eUpsertV1 as Record<string, unknown>;
}

describe("pf2e.actor.upsert.v1 validation", () => {
  it("accepts a full draft and one without ABC slugs", () => {
    expect(validatePf2eActorUpsertV1(draft())).toEqual(draft());
    const bare = draft({ pf2e: { level: 1 } });
    delete bare.foundryUserId;
    expect(validatePf2eActorUpsertV1(bare)).toEqual(bare);
  });

  it.each([
    ["unknown top-level key", { extra: 1 }],
    ["schemaVersion 2", { schemaVersion: 2 }],
    ["another actor type", { actorType: "npc" }],
    ["state approved", { state: "approved" }],
    ["revision 0", { approvedRevision: 0 }],
    ["revision above 2^31-1", { approvedRevision: 2_147_483_648 }],
    ["fractional revision", { approvedRevision: 1.5 }],
    ["blank name", { name: "   " }],
    ["name of 201 characters", { name: "a".repeat(201) }],
    ["bad world id", { worldId: "world 1" }],
    ["bad character id", { characterId: "" }],
    ["default as user", { foundryUserId: "default" }],
    ["bad user id", { foundryUserId: "user/1" }],
    [
      "assigned differs from expected",
      {
        assignedActorId: "actorAAAAAAAAAA1",
        expectedActorId: "actorBBBBBBBBBB1",
      },
    ],
    ["missing pf2e block", { pf2e: undefined }],
    ["level 0", { pf2e: { level: 0 } }],
    ["level 21", { pf2e: { level: 21 } }],
    ["level as string", { pf2e: { level: "3" } }],
    ["unknown pf2e key", { pf2e: { level: 1, deity: "iomedae" } }],
    ["uppercase slug", { pf2e: { level: 1, ancestry: "Human" } }],
    ["slug with a space", { pf2e: { level: 1, class: "bar barian" } }],
    [
      "slug with a trailing hyphen",
      { pf2e: { level: 1, background: "barkeep-" } },
    ],
    ["slug over 64 bytes", { pf2e: { level: 1, heritage: "a".repeat(65) } }],
  ])("refuses %s", (_label, patch) => {
    expect(() =>
      validatePf2eActorUpsertV1({ ...draft(), ...patch }),
    ).toThrowError(expect.objectContaining({ code: "invalid_args" }));
  });

  it("refuses a non-object payload", () => {
    expect(() => validatePf2eActorUpsertV1([])).toThrowError(
      expect.objectContaining({ code: "invalid_args" }),
    );
  });
});

describe("pf2e.actor.upsert.v1 runtime gate", () => {
  it.each(["8.6.1", "8.6.2", "8.7.0", "8.99.0"])(
    "admits pf2e %s",
    async (version) => {
      const world = stubWorld([], { version });
      await expect(run(draft())).resolves.toMatchObject({
        outcome: "created",
      });
      expect(world.create).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["pf2e", "8.6.0", 14],
    ["pf2e", "8.5.9", 14],
    ["pf2e", "v8.6.1", 14],
    ["pf2e", "8.6.1-beta", 14],
    ["pf2e", "8.6.1", 13],
    ["sf2e", "8.6.1", 14],
    // A later major may move the paths the draft writes.
    ["pf2e", "9.0.0", 14],
  ] as const)(
    "refuses %s %s on Foundry %s",
    async (id, version, generation) => {
      const world = stubWorld([], { id, version, generation });
      await expect(run(draft())).rejects.toMatchObject({
        code: "unsupported_runtime",
        message:
          "pf2e.actor.upsert.v1 requires pf2e 8.6.1 or a later 8.x on Foundry 14",
      });
      expect(world.create).not.toHaveBeenCalled();
    },
  );

  it("refuses a non-GM responder before touching the world", async () => {
    const world = stubWorld([], { isGM: false });
    await expect(run(draft())).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(world.create).not.toHaveBeenCalled();
  });

  it("refuses a foundryUserId that is not a world User", async () => {
    stubWorld();
    await expect(
      run(draft({ foundryUserId: "nobody0000000001" })),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("pf2e.actor.upsert.v1 creation", () => {
  it("creates a stamped character with the level, the binding and the ownership", async () => {
    const world = stubWorld();
    const result = await run(draft());
    const data = world.create.mock.calls[0][0] as Record<string, unknown>;
    expect(data).toEqual({
      name: "Amiri",
      type: "character",
      system: {
        details: { level: { value: 3 } },
        _migration: { version: SCHEMA },
      },
      flags: {
        [MODULE_ID]: {
          binding: {
            schemaVersion: 1,
            worldId: "world-1",
            tableId: "table-1",
            characterId: "character-1",
          },
          pf2eUpsertCreatedV1: true,
        },
      },
      ownership: { default: 0, [USER_ID]: 3, [COMPANION_ID]: 2 },
    });
    expect(world.create.mock.calls[0][1]).toEqual({ renderSheet: false });
    // pf2e's LIMITED default is replaced; player OWNER, Companion OBSERVER.
    const actor = world.actors[0];
    expect(actor.ownership).toEqual({
      default: 0,
      [USER_ID]: 3,
      [COMPANION_ID]: 2,
    });
    expect(result).toEqual({
      schemaVersion: 1,
      resultDocId: actor.id,
      outcome: "created",
      appliedRevision: 1,
      appliedDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      equipmentCompleteness: "complete",
      warnings: [],
    });
  });

  describe("on Foundry 14", () => {
    // Foundry adds the creating Gamemaster as OWNER on top of pf2e's LIMITED.
    function gmCreating(): World {
      const world = stubWorld();
      stubOperators();
      const made = world.create.getMockImplementation()!;
      world.create.mockImplementation(async (data, options) => {
        const actor = await made(data, options);
        actor.ownership.gm = 3;
        return actor;
      });
      return world;
    }

    it("creates with exactly the lane's ownership", async () => {
      const world = gmCreating();
      const result = await run(draft());
      expect(result.outcome).toBe("created");
      // pf2e's LIMITED default and the creator's grant are both replaced.
      expect(world.actors[0].ownership).toEqual({
        default: 0,
        [USER_ID]: 3,
        [COMPANION_ID]: 2,
      });
    });

    it("answers procedure_failed when Foundry drops the authored update", async () => {
      const world = gmCreating();
      const made = world.create.getMockImplementation()!;
      world.create.mockImplementation(async (data, options) => {
        const actor = await made(data, options);
        actor.update = async (changes) => {
          actor.updates.push(changes);
        };
        return actor;
      });
      await expect(run(draft())).rejects.toMatchObject({
        code: "procedure_failed",
      });
    });
  });

  it("never writes system.abilities or any other build path", async () => {
    const world = stubWorld();
    await run(draft());
    const actor = world.actors[0];
    expect(Object.keys(actor.system).sort()).toEqual(["_migration", "details"]);
    for (const update of actor.updates)
      for (const key of Object.keys(update))
        expect(key.startsWith("system."), key).toBe(false);
  });

  it("refuses to create without the world schema version", async () => {
    const world = stubWorld([], { schema: undefined });
    await expect(run(draft())).rejects.toMatchObject({
      code: "unsupported_runtime",
    });
    expect(world.create).not.toHaveBeenCalled();
  });

  it("warns assign_foundry_user and keeps only the Companion grant without a player", async () => {
    const world = stubWorld();
    const req = draft();
    delete req.foundryUserId;
    const result = await run(req);
    expect(result.warnings).toEqual(["assign_foundry_user"]);
    expect(world.actors[0].ownership).toEqual({
      default: 0,
      [COMPANION_ID]: 2,
    });
  });
});

describe("pf2e.actor.upsert.v1 ABC items", () => {
  it("embeds every found item from its compendium source, in ABC order, in one call", async () => {
    const world = stubWorld();
    const result = await run(draft());
    const actor = world.actors[0];
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(actor.createEmbeddedDocuments.mock.calls[0][0]).toBe("Item");
    const items = embedded(actor);
    expect(items.map((i) => (i.system as { slug: string }).slug)).toEqual([
      "human",
      "versatile-human",
      "barkeep",
      "barbarian",
    ]);
    for (const item of items)
      expect(item._stats).toEqual({
        compendiumSource: "Compendium.pf2e.test.Item.x",
      });
    expect(world.fromCompendium).toHaveBeenCalledTimes(4);
    expect(result.equipmentCompleteness).toBe("complete");
  });

  it("warns abc_item_not_found for a slug no pack entry carries", async () => {
    const world = stubWorld();
    const result = await run(
      draft({ pf2e: { level: 1, ancestry: "kobold", class: "barbarian" } }),
    );
    expect(result.warnings).toEqual(["abc_item_not_found:kobold"]);
    expect(result.equipmentCompleteness).toBe("partial");
    expect(
      embedded(world.actors[0]).map((i) => (i.system as { slug: string }).slug),
    ).toEqual(["barbarian"]);
  });

  it("skips an item whose ChoiceSet has no selection, and warns", async () => {
    const packs = abcPacks();
    packs["pf2e.classes"][0].source.system = {
      slug: "barbarian",
      rules: [
        { key: "GrantItem", uuid: "Compendium.pf2e.classfeatures.Item.x" },
        { key: "ChoiceSet", flag: "instinct", choices: [] },
      ],
    };
    const world = stubWorld([], { packs });
    const result = await run(draft());
    expect(result.warnings).toEqual(["abc_item_skipped:barbarian"]);
    expect(result.equipmentCompleteness).toBe("partial");
    expect(
      embedded(world.actors[0]).map((i) => (i.system as { slug: string }).slug),
    ).toEqual(["human", "versatile-human", "barkeep"]);
  });

  it("warns abc_pack_missing when a system pack is absent", async () => {
    const packs = abcPacks();
    delete packs["pf2e.heritages"];
    stubWorld([], { packs });
    const result = await run(draft());
    expect(result.warnings).toEqual(["abc_pack_missing:heritage"]);
    expect(result.equipmentCompleteness).toBe("partial");
  });

  it("embeds nothing when no slug is requested, and reports complete", async () => {
    const world = stubWorld();
    const result = await run(draft({ pf2e: { level: 1 } }));
    expect(world.actors[0].createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(world.fromCompendium).not.toHaveBeenCalled();
    expect(result.equipmentCompleteness).toBe("complete");
  });

  it("embeds nothing when every requested item was skipped", async () => {
    const world = stubWorld([], { packs: {} });
    const result = await run(draft({ pf2e: { level: 1, class: "barbarian" } }));
    expect(world.actors[0].createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(["abc_pack_missing:class"]);
  });
});

describe("pf2e.actor.upsert.v1 resolution", () => {
  it("updates the bound character: name and ownership only, no ABC, no level", async () => {
    const actor = character();
    actor.system = { details: { level: { value: 7 } } };
    actor.ownership = { default: 1, stranger00000001: 3, [COMPANION_ID]: 3 };
    bind(actor);
    const world = stubWorld([actor]);
    const result = await run(draft({ name: "Amiri the Bold" }));
    expect(world.create).not.toHaveBeenCalled();
    expect(result.outcome).toBe("updated");
    expect(result.equipmentCompleteness).toBe("not_requested");
    expect(actor.name).toBe("Amiri the Bold");
    expect(actor.ownership).toEqual({
      default: 0,
      [USER_ID]: 3,
      [COMPANION_ID]: 3,
    });
    expect(actor.system).toEqual({ details: { level: { value: 7 } } });
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("adopts an unbound assigned character and binds it", async () => {
    const actor = character("assigned00000001");
    const world = stubWorld([actor]);
    const result = await run(draft({ assignedActorId: "assigned00000001" }));
    expect(world.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "adopted",
      resultDocId: "assigned00000001",
      equipmentCompleteness: "not_requested",
    });
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(
      (actor.flags[MODULE_ID] as Record<string, unknown>).binding,
    ).toMatchObject({ characterId: "character-1" });
  });

  it.each([
    ["a missing assigned Actor", [], "actor_not_found"],
    [
      "an assigned Actor of another type",
      [Object.assign(character("assigned00000001"), { type: "npc" })],
      "invalid_args",
    ],
    [
      "an assigned Actor bound elsewhere",
      [
        (() => {
          const a = character("assigned00000001");
          bind(a, draft({ characterId: "other" }));
          return a;
        })(),
      ],
      "binding_conflict",
    ],
  ] as const)("refuses %s", async (_label, actors, code) => {
    const world = stubWorld([...actors]);
    await expect(
      run(draft({ assignedActorId: "assigned00000001" })),
    ).rejects.toMatchObject({ code });
    expect(world.create).not.toHaveBeenCalled();
  });

  it("refuses deleted_link when the expected Actor is gone, without creating", async () => {
    const world = stubWorld();
    await expect(
      run(draft({ expectedActorId: "gone000000000001" })),
    ).rejects.toMatchObject({ code: "deleted_link" });
    expect(world.create).not.toHaveBeenCalled();
  });

  it("refuses binding_conflict when the binding points elsewhere", async () => {
    const actor = character();
    bind(actor);
    stubWorld([actor]);
    await expect(
      run(draft({ expectedActorId: "other00000000001" })),
    ).rejects.toMatchObject({ code: "binding_conflict" });
  });

  it("refuses binding_collision when two Actors carry the binding", async () => {
    const a = character("actorA0000000001");
    const b = character("actorB0000000001");
    bind(a);
    bind(b);
    stubWorld([a, b]);
    await expect(run(draft())).rejects.toMatchObject({
      code: "binding_collision",
    });
  });
});

describe("pf2e.actor.upsert.v1 replay", () => {
  it("replays the stored result for the same revision and content, writing nothing", async () => {
    const world = stubWorld();
    const first = await run(draft());
    const actor = world.actors[0];
    const updates = actor.updates.length;
    const again = await run(draft());
    expect(again).toEqual(first);
    expect(actor.updates.length).toBe(updates);
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
  });

  it("refuses an older revision as stale and other content at the same one as a conflict", async () => {
    stubWorld();
    await run(draft({ approvedRevision: 5 }));
    await expect(run(draft({ approvedRevision: 4 }))).rejects.toMatchObject({
      code: "stale_revision",
    });
    await expect(
      run(draft({ approvedRevision: 5, name: "Other" })),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("applies a newer revision as an update and never re-embeds", async () => {
    const world = stubWorld();
    await run(draft());
    const result = await run(draft({ approvedRevision: 2, name: "Amiri II" }));
    const actor = world.actors[0];
    expect(result.outcome).toBe("updated");
    expect(actor.name).toBe("Amiri II");
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(storedFlag(actor)).toMatchObject({ appliedRevision: 2 });
  });

  it("writes the result flag last; a failed embed leaves it unrecorded and the retry redoes the creation", async () => {
    const world = stubWorld();
    const create = world.create.getMockImplementation()!;
    world.create.mockImplementationOnce(
      async (data: Record<string, unknown>) => {
        const actor = (await create(data)) as FakeActor;
        actor.createEmbeddedDocuments.mockRejectedValueOnce(
          new Error("socket closed"),
        );
        return actor;
      },
    );
    await expect(run(draft())).rejects.toThrow("socket closed");
    const actor = world.actors[0];
    expect(storedFlag(actor)).toBeUndefined();
    expect(actor.events.at(-1)).toBe("update");

    const retry = await run(draft());
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(retry.outcome).toBe("created");
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(2);
    expect(storedFlag(actor)).toMatchObject({
      outcome: "created",
      appliedRevision: 1,
      equipmentCompleteness: "complete",
    });
    // The flag is the last write of the successful apply.
    expect(Object.keys(actor.updates.at(-1)!)).toEqual([
      `flags.${MODULE_ID}.pf2eUpsertV1`,
    ]);
  });

  it("never re-embeds the ABC Items when the retry follows an embed that went through", async () => {
    const world = stubWorld();
    const create = world.create.getMockImplementation()!;
    world.create.mockImplementationOnce(
      async (data: Record<string, unknown>) => {
        const actor = (await create(data)) as FakeActor;
        const update = actor.update;
        // The embed lands; the final result-flag write is lost.
        actor.update = async (changes) => {
          if (`flags.${MODULE_ID}.pf2eUpsertV1` in changes) {
            actor.update = update;
            throw new Error("socket closed");
          }
          return update(changes);
        };
        return actor;
      },
    );
    await expect(run(draft())).rejects.toThrow("socket closed");
    const actor = world.actors[0];
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(storedFlag(actor)).toBeUndefined();

    const retry = await run(draft());
    expect(retry.outcome).toBe("created");
    expect(retry.equipmentCompleteness).toBe("complete");
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const types = actor.items.contents.map((item) => item.type);
    expect(types.sort()).toEqual(
      ["ancestry", "background", "class", "heritage"].sort(),
    );
  });
});

describe("pf2e.actor.upsert.v1 after the world is linked again", () => {
  it("creates no second Actor under the new world id: same revision replays, a newer one updates and rebinds", async () => {
    const world = stubWorld();
    const first = await run(draft());
    const actor = world.actors[0];
    const updates = actor.updates.length;
    await expect(run(draft({ worldId: "world-2" }))).resolves.toEqual(first);
    expect(actor.updates.length).toBe(updates);

    await run(draft({ worldId: "world-2", approvedRevision: 2 }));
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.actors).toHaveLength(1);
    expect(
      (actor.flags[MODULE_ID] as { binding: { worldId: string } }).binding
        .worldId,
    ).toBe("world-2");
  });
});
