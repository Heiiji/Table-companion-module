import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorResourcesV1,
  validateKnightActorResourcesV1,
  type ActorResourcesResultV1,
} from "../src/procedures/actorResources.js";
import { actorItemsV1 } from "../src/procedures/actorItems.js";
import {
  actorUpsertV1,
  type ActorUpsertResultV1,
} from "../src/procedures/actorUpsert.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import {
  ACTOR_ID,
  approved,
  fakeActor,
  stubFoundry,
  stubOperators,
  wearingArmour,
  type FakeActor,
} from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

const NOW = "2026-11-12T13:05:00.000Z";
const flags = (actor: FakeActor) =>
  actor.flags[MODULE_ID] as Record<string, any>;

/** A Knight PC bound to `tableId` / `characterId`, with the lane records a
 * table leaves on it. */
function heldBy(
  tableId: string,
  characterId = "character-1",
  previous?: unknown,
): FakeActor {
  const actor = wearingArmour(fakeActor());
  actor.system = {
    wear: "armure",
    sante: { value: 1, max: 30 },
    espoir: { value: 1, max: 50 },
    equipements: {
      armure: { armure: { value: 1 }, energie: { value: 1 } },
    },
  };
  const record = (revision: number) => ({
    schemaVersion: 1,
    resultDocId: ACTOR_ID,
    outcome: "updated",
    appliedRevision: revision,
    appliedDigest: "f".repeat(64),
    warnings: [],
    written: { "resources.health": 9 },
  });
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: "world-1",
      tableId,
      characterId,
      ...(previous === undefined ? {} : { previous }),
    },
    // Another table's sequence is far ahead of this one's.
    actorResourcesV1: { ...record(9_999_999_999_999), gloryLineId: "3" },
    actorUpsertV1: {
      ...record(9_999_999_999_999),
      state: "approved",
      equipmentCompleteness: "not_requested",
    },
    npcUpsertV1: record(9_999_999_999_999),
    characterCreationV1: { schemaVersion: 1, approvedRevision: 4 },
  };
  return actor;
}

const entry = (tableId: string, characterId = "character-1", at = NOW) => ({
  tableId,
  characterId,
  at,
});

function resources(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    actorType: "knight",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    expectedActorId: ACTOR_ID,
    sequence: 7,
    resources: { health: 12 },
    ...overrides,
  };
}

const items = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  actorType: "knight",
  worldId: "world-1",
  tableId: "table-1",
  characterId: "character-1",
  expectedActorId: ACTOR_ID,
  op: {
    remove: { itemId: "item000000000099", kind: "module", expectedName: "x" },
  },
  ...overrides,
});

async function code(promise: unknown): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error.code;
    throw error;
  }
  throw new Error("expected an RpcError");
}

const applyResources = async (req: unknown) =>
  (await actorResourcesV1(req, {} as never)) as ActorResourcesResultV1;

describe("binding take-over", () => {
  it("takes an Actor bound by another table over through actor.resources", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    try {
      const actor = heldBy("table-2", "character-9", [entry("table-3")]);
      stubFoundry([actor]);
      const result = await applyResources(resources());
      expect(result.warnings).toEqual(["binding_taken_over"]);
      expect(actor.updates).toHaveLength(1);
      expect(flags(actor).binding).toEqual({
        schemaVersion: 1,
        worldId: "world-1",
        tableId: "table-1",
        characterId: "character-1",
        previous: [entry("table-3"), entry("table-2", "character-9")],
      });
      // The other table's lane records are gone; this lane's is its own.
      expect(flags(actor)).not.toHaveProperty("actorUpsertV1");
      expect(flags(actor)).not.toHaveProperty("npcUpsertV1");
      expect(flags(actor).actorResourcesV1).toEqual({
        ...result,
        contentDigest: expect.any(String),
        // Foundry stores the dotted record nested.
        written: { resources: { health: 12 } },
      });
      // The creation provenance is the character's, not a lane record.
      expect(flags(actor).characterCreationV1).toEqual({
        schemaVersion: 1,
        approvedRevision: 4,
      });
      expect(actor.system).toMatchObject({ sante: { value: 12 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the binding and the lane record with Foundry 14's operator", async () => {
    const actor = heldBy("table-2");
    stubFoundry([actor], undefined, 14);
    stubOperators();
    await applyResources(resources());
    expect(flags(actor).binding.tableId).toBe("table-1");
    expect(flags(actor).binding.previous).toEqual([
      entry("table-2", "character-1", expect.any(String)),
    ]);
    expect(flags(actor).actorResourcesV1).not.toHaveProperty("gloryLineId");
    expect(flags(actor)).not.toHaveProperty("actorUpsertV1");
  });

  it("then writes normally, and replays the taking write", async () => {
    const actor = heldBy("table-2");
    stubFoundry([actor]);
    const first = await applyResources(resources());
    expect(await applyResources(resources())).toEqual(first);
    expect(actor.updates).toHaveLength(1);
    const next = await applyResources(
      resources({ sequence: 8, resources: { health: 13 } }),
    );
    expect(next.warnings).toEqual([]);
    expect(actor.system).toMatchObject({ sante: { value: 13 } });
    expect(flags(actor).binding.previous).toHaveLength(1);
  });

  it("takes an NPC over through actor.resources", async () => {
    const npc = fakeActor(ACTOR_ID, "Garde");
    npc.type = "pnj";
    npc.items.contents = [];
    npc.system = { sante: { value: 2, max: 30 } };
    npc.flags[MODULE_ID] = {
      binding: {
        schemaVersion: 1,
        worldId: "world-1",
        tableId: "table-2",
        characterId: "npc-1",
      },
    };
    stubFoundry([npc]);
    const result = await applyResources(
      resources({ actorType: "pnj", characterId: "npc-7" }),
    );
    expect(result.warnings).toEqual(["binding_taken_over"]);
    expect(flags(npc).binding).toMatchObject({
      tableId: "table-1",
      characterId: "npc-7",
      previous: [entry("table-2", "npc-1", expect.any(String))],
    });
  });

  it("takes over through actor.items, before the Item operation", async () => {
    const actor = heldBy("table-2");
    stubFoundry([actor]);
    const result = (await actorItemsV1(items(), {} as never)) as {
      warnings: string[];
    };
    expect(result.warnings).toEqual(["binding_taken_over"]);
    expect(actor.updates).toHaveLength(1);
    expect(flags(actor).binding.tableId).toBe("table-1");
    expect(flags(actor)).not.toHaveProperty("actorResourcesV1");
    expect(flags(actor)).not.toHaveProperty("actorUpsertV1");
    // Once taken over, the lane runs without a binding write.
    await actorItemsV1(items(), {} as never);
    expect(actor.updates).toHaveLength(1);
  });

  it("answers procedure_failed when Foundry drops the actor.items take-over", async () => {
    const actor = heldBy("table-2");
    actor.update = async (changes) => {
      actor.updates.push(changes);
    };
    stubFoundry([actor]);
    expect(await code(actorItemsV1(items(), {} as never))).toBe(
      "procedure_failed",
    );
  });

  it("takes over through actor.upsert, by expectedActorId and by adoption", async () => {
    for (const ids of [
      { expectedActorId: ACTOR_ID },
      { assignedActorId: ACTOR_ID },
    ]) {
      vi.unstubAllGlobals();
      const actor = heldBy("table-2");
      stubFoundry([actor]);
      const result = (await actorUpsertV1(
        approved({ ...ids, equipment: undefined }),
        {} as never,
      )) as ActorUpsertResultV1;
      expect(result.warnings).toContain("binding_taken_over");
      expect(result.outcome).toBe(
        "assignedActorId" in ids ? "adopted" : "updated",
      );
      // Applied, not replayed from the other table's record.
      expect(result.appliedRevision).toBe(1);
      expect(actor.name).toBe("Lancelot");
      expect(flags(actor).binding).toMatchObject({
        tableId: "table-1",
        characterId: "character-1",
        previous: [entry("table-2", "character-1", expect.any(String))],
      });
      expect(flags(actor)).not.toHaveProperty("actorResourcesV1");
      expect(flags(actor)).not.toHaveProperty("npcUpsertV1");
      expect(flags(actor).actorUpsertV1.appliedRevision).toBe(1);
    }
  });

  describe("the table that lost the Actor", () => {
    const lost = () => heldBy("table-2", "character-2", [entry("table-1")]);

    it("gets binding_lost on actor.resources, actor.items and actor.upsert, nothing written", async () => {
      const actor = lost();
      const create = vi.fn();
      stubFoundry([actor], create);
      expect(await code(applyResources(resources()))).toBe("binding_lost");
      expect(await code(actorItemsV1(items(), {} as never))).toBe(
        "binding_lost",
      );
      for (const ids of [
        { expectedActorId: ACTOR_ID },
        { assignedActorId: ACTOR_ID },
        {},
      ])
        expect(
          await code(
            actorUpsertV1(
              approved({ ...ids, equipment: undefined }),
              {} as never,
            ),
          ),
        ).toBe("binding_lost");
      expect(actor.updates).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    });

    it("gets binding_lost, never deleted_link, from actor.upsert when the app names no live Actor", async () => {
      const actor = lost();
      actor.id = "actor00000000005";
      const create = vi.fn();
      stubFoundry([actor], create);
      expect(
        await code(
          actorUpsertV1(
            approved({ expectedActorId: ACTOR_ID, equipment: undefined }),
            {} as never,
          ),
        ),
      ).toBe("binding_lost");
      expect(create).not.toHaveBeenCalled();
    });

    /** A reclaim row as the apps send it: the identity keys, no values. */
    const reclaimRow = (overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = resources({
        reclaim: true,
        ...overrides,
      });
      if (!("resources" in overrides)) delete row.resources;
      return row;
    };

    /** The flags an update carries, everything else being a document field. */
    const documentFields = (actor: FakeActor) =>
      actor.updates.flatMap((u) =>
        Object.keys(u).filter((k) => !k.startsWith(`flags.${MODULE_ID}.`)),
      );

    it("takes it back with reclaim, writes no value, and leaves the history", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW));
      try {
        const actor = heldBy("table-2", "character-2", [
          entry("table-3", "character-3", "2026-11-01T00:00:00.000Z"),
          entry("table-1", "character-1", "2026-11-02T00:00:00.000Z"),
        ]);
        actor.name = "Played elsewhere";
        stubFoundry([actor]);
        const before = structuredClone(actor.system);
        const result = await applyResources(reclaimRow());
        expect(result.warnings).toEqual(["binding_taken_over"]);
        expect(flags(actor).binding).toMatchObject({
          tableId: "table-1",
          characterId: "character-1",
          previous: [
            entry("table-3", "character-3", "2026-11-01T00:00:00.000Z"),
            entry("table-2", "character-2"),
          ],
        });
        // The other table's lane records are gone; the reclaim's own records
        // nothing as written, so the next base compare reads Foundry.
        expect(flags(actor)).not.toHaveProperty("actorUpsertV1");
        expect(flags(actor).actorResourcesV1).toMatchObject({
          appliedRevision: 7,
          warnings: ["binding_taken_over"],
          written: {},
        });
        expect(actor.updates).toHaveLength(1);
        expect(documentFields(actor)).toEqual([]);
        expect(actor.system).toEqual(before);
        expect(actor.name).toBe("Played elsewhere");
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores the values an older app sends with a reclaim, and says so", async () => {
      const actor = lost();
      actor.name = "Played elsewhere";
      stubFoundry([actor]);
      const before = structuredClone(actor.system);
      const row = reclaimRow({
        resources: { health: 12, hope: 3 },
        name: "Local name",
        previousName: "Played elsewhere",
        base: { resources: { health: 2, hope: 4 } },
      });
      const result = await applyResources(row);
      expect(result.warnings).toEqual([
        "binding_taken_over",
        "reclaim_values_ignored",
      ]);
      expect(flags(actor).binding.tableId).toBe("table-1");
      expect(documentFields(actor)).toEqual([]);
      expect(actor.system).toEqual(before);
      expect(actor.name).toBe("Played elsewhere");
      expect(flags(actor).actorResourcesV1.written).toEqual({});
      // A re-send replays, with or without the ignored values.
      expect(await applyResources(row)).toEqual(result);
      expect(await applyResources(reclaimRow())).toEqual(result);
      expect(actor.updates).toHaveLength(1);
    });

    it("then applies the reclaiming table's next write based on Foundry's values", async () => {
      const actor = lost();
      stubFoundry([actor]);
      await applyResources(reclaimRow());
      // Foundry holds health 1 (the other table played it). A base naming the
      // reclaiming table's own old value is refused: the reclaim recorded
      // nothing as written.
      expect(
        await code(
          applyResources(
            resources({
              sequence: 8,
              resources: { health: 7 },
              base: { resources: { health: 2 } },
            }),
          ),
        ),
      ).toBe("base_conflict");
      // The app adopted Foundry's value: its next write applies.
      const next = await applyResources(
        resources({
          sequence: 9,
          resources: { health: 5 },
          base: { resources: { health: 1 } },
        }),
      );
      expect(next.warnings).toEqual([]);
      expect(next.appliedRevision).toBe(9);
      expect(actor.system).toMatchObject({ sante: { value: 5 } });
    });

    it("writes no value on a reclaim by the table that already holds the Actor", async () => {
      const actor = heldBy("table-1", "character-1", [entry("table-2")]);
      delete flags(actor).actorResourcesV1;
      stubFoundry([actor]);
      const before = structuredClone(actor.system);
      const result = await applyResources(
        reclaimRow({ resources: { health: 12 } }),
      );
      expect(result.warnings).toEqual(["reclaim_values_ignored"]);
      expect(documentFields(actor)).toEqual([]);
      expect(actor.system).toEqual(before);
      expect(flags(actor).binding.previous).toEqual([entry("table-2")]);
    });
  });

  it("lets no loser take an Actor automatically from a third table", async () => {
    // Table 1 lost it to table 2, which lost it to table 3.
    const actor = heldBy("table-3", "character-3", [
      entry("table-1"),
      entry("table-2", "character-2"),
    ]);
    stubFoundry([actor]);
    expect(await code(applyResources(resources()))).toBe("binding_lost");
    expect(
      await code(
        applyResources(
          resources({ tableId: "table-2", characterId: "character-2" }),
        ),
      ),
    ).toBe("binding_lost");
    expect(actor.updates).toHaveLength(0);
    // A fourth table takes it automatically.
    await applyResources(
      resources({ tableId: "table-4", characterId: "character-4" }),
    );
    expect(flags(actor).binding.previous.map((e: any) => e.tableId)).toEqual([
      "table-1",
      "table-2",
      "table-3",
    ]);
  });

  it("keeps binding_conflict for another character of the same table", async () => {
    const actor = heldBy("table-1", "character-2");
    stubFoundry([actor]);
    expect(await code(applyResources(resources()))).toBe("binding_conflict");
    expect(await code(applyResources(resources({ reclaim: true })))).toBe(
      "binding_conflict",
    );
    expect(await code(actorItemsV1(items(), {} as never))).toBe(
      "binding_conflict",
    );
    expect(
      await code(
        actorUpsertV1(
          approved({ assignedActorId: ACTOR_ID, equipment: undefined }),
          {} as never,
        ),
      ),
    ).toBe("binding_conflict");
    expect(actor.updates).toHaveLength(0);
  });

  it("keeps the 16 latest tables", async () => {
    const day = (i: number) =>
      `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`;
    const history = Array.from({ length: 16 }, (_, i) =>
      entry(`table-${i + 10}`, "c", day(i)),
    );
    const actor = heldBy("table-2", "character-9", history);
    stubFoundry([actor]);
    await applyResources(resources());
    const previous = flags(actor).binding.previous as Array<{
      tableId: string;
    }>;
    expect(previous).toHaveLength(16);
    // The oldest falls out; the table taken from comes last.
    expect(previous[0].tableId).toBe("table-11");
    expect(previous.at(-1)).toMatchObject({
      tableId: "table-2",
      characterId: "character-9",
    });
  });

  it("lists a table once: losing the Actor again moves it to the end", async () => {
    const actor = heldBy("table-2", "character-9", [
      entry("table-2", "character-9", "2026-10-01T00:00:00.000Z"),
      entry("table-5", "c", "2026-10-02T00:00:00.000Z"),
    ]);
    stubFoundry([actor]);
    await applyResources(resources());
    expect(flags(actor).binding.previous.map((e: any) => e.tableId)).toEqual([
      "table-5",
      "table-2",
    ]);
  });

  it("reads a malformed history as empty, never as an invalid binding", async () => {
    for (const bad of ["x", [{ tableId: 3 }], [entry("table-1"), null], {}]) {
      vi.unstubAllGlobals();
      const actor = heldBy("table-2", "character-2", bad);
      stubFoundry([actor]);
      // table-1 is in no readable history: an automatic take-over.
      const result = await applyResources(resources());
      expect(result.warnings).toEqual(["binding_taken_over"]);
      expect(flags(actor).binding.previous).toEqual([
        entry("table-2", "character-2", expect.any(String)),
      ]);
    }
  });

  it("keeps an Actor bound to the request's own character writable, its history kept", async () => {
    const actor = heldBy("table-1", "character-1", [entry("table-2")]);
    stubFoundry([actor]);
    // The record left is this table's own: a far newer sequence refuses.
    expect(await code(applyResources(resources()))).toBe("stale_revision");
    delete flags(actor).actorResourcesV1;
    const result = await applyResources(resources());
    expect(result.warnings).toEqual([]);
    expect(flags(actor).binding.previous).toEqual([entry("table-2")]);
  });

  it("keeps the history through an approved revision of the holder", async () => {
    const actor = heldBy("table-1", "character-1", [entry("table-2")]);
    delete flags(actor).actorUpsertV1;
    stubFoundry([actor]);
    await actorUpsertV1(approved({ equipment: undefined }), {} as never);
    expect(flags(actor).binding.previous).toEqual([entry("table-2")]);
  });
});

describe("actor.resources.v1 reclaim validation", () => {
  it("accepts reclaim true as the last key", () => {
    const req = resources({ reclaim: true });
    expect(validateKnightActorResourcesV1(req)).toEqual(req);
    expect(Object.keys(validateKnightActorResourcesV1(req)).at(-1)).toBe(
      "reclaim",
    );
  });

  it("accepts a reclaim with no value, and nothing else without one", () => {
    const row: Record<string, unknown> = resources({ reclaim: true });
    delete row.resources;
    expect(validateKnightActorResourcesV1(row)).toMatchObject({
      reclaim: true,
      resources: {},
    });
    delete row.reclaim;
    expect(() => validateKnightActorResourcesV1(row)).toThrow(
      "resources needs at least one value",
    );
  });

  it.each([
    [{ reclaim: false }, "reclaim must be true when present"],
    [{ reclaim: "true" }, "reclaim must be true when present"],
    [
      {
        reclaim: true,
        sheet: { gloryTotal: 1 },
        base: { sheet: { gloryTotal: 0 } },
      },
      "reclaim never rides with sheet or wear",
    ],
    [
      {
        reclaim: true,
        resources: undefined,
        wear: "armure",
        previousWear: "guardian",
      },
      "reclaim never rides with sheet or wear",
    ],
  ])("refuses %j", (overrides, message) => {
    expect(() => validateKnightActorResourcesV1(resources(overrides))).toThrow(
      message,
    );
  });
});
