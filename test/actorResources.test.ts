import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorResourcesV1,
  validateKnightActorResourcesV1,
  type ActorResourcesResultV1,
  type KnightActorResourcesV1,
} from "../src/procedures/actorResources.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import {
  canonicalDigest,
  recordedFields,
  valueAt,
} from "../src/procedures/upsertShared.js";
import {
  knightSheetSource,
  reprepare,
  withKnightSheet,
  type KnightSheetState,
} from "./support/knightSheetActor.js";
import {
  ACTOR_ID,
  KNIGHT_SCHEMA_FIXTURES,
  fakeActor,
  hasFixturePath,
  stubFoundry,
  wearingArmour,
  type FakeActor,
  type KnightSchemaFixture,
} from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

function request(
  overrides: Partial<KnightActorResourcesV1> = {},
): KnightActorResourcesV1 {
  return {
    schemaVersion: 1,
    actorType: "knight",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    expectedActorId: ACTOR_ID,
    sequence: 7,
    resources: { health: 12, hope: 3 },
    ...overrides,
  };
}

/** A bound Knight PC with every resource path and prepared maxima. */
function boundActor(id = ACTOR_ID): FakeActor {
  const actor = wearingArmour(fakeActor(id));
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: "world-1",
      tableId: "table-1",
      characterId: "character-1",
    },
  };
  actor.system = {
    wear: "armure",
    sante: { value: 1, max: 30 },
    espoir: { value: 1, max: 50 },
    heroisme: { value: 0, max: 6 },
    contacts: { actuel: 1, value: 3 },
    armure: { max: 40 },
    energie: { max: 20 },
    equipements: {
      armure: { armure: { value: 1 }, energie: { value: 1 } },
      guardian: { armure: { value: 5 } },
      tenueCivile: {},
    },
  };
  return actor;
}

/** SYNTHETIC: a prepared-shape Knight PC built from a captured fixture. The
 * captures are source data only (no `wear`, `heroisme`, top-level `armure` /
 * `energie`, nor any `max`); this adds the fields the Knight system prepares,
 * so the six resources run against the shape a live world serves. It stands in
 * until a prepared actor is captured from a live world. */
function preparedKnightActor(fixture: KnightSchemaFixture): FakeActor {
  const actor = boundActor();
  const system = structuredClone(fixture.actor.system);
  const at = (key: string) => system[key] as Record<string, unknown>;
  Object.assign(at("sante"), { max: 30 });
  Object.assign(at("espoir"), { max: 50 });
  system.wear = "armure";
  system.heroisme = { value: 0, max: 6 };
  system.armure = { max: 40 };
  system.energie = { max: 20 };
  actor.system = system;
  return actor;
}

async function apply(req: unknown): Promise<ActorResourcesResultV1> {
  return (await actorResourcesV1(req, {} as never)) as ActorResourcesResultV1;
}

async function rpcCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error.code;
    throw error;
  }
  throw new Error("expected an RpcError");
}

describe("validateKnightActorResourcesV1", () => {
  it("refuses 10000 with the lane's invalid-args error", () => {
    expect(() =>
      validateKnightActorResourcesV1(
        request({ resources: { health: 10_000 } }),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_args" }));
  });

  it("accepts every resource and the full sequence range", () => {
    const req = request({
      sequence: Number.MAX_SAFE_INTEGER,
      resources: {
        health: 0,
        hope: 9999,
        armour: 1,
        energy: 2,
        heroism: 3,
        contact: 4,
      },
    });
    expect(validateKnightActorResourcesV1(req)).toEqual(req);
  });

  it.each([
    ["unknown top-level key", { system: {} }],
    ["unknown resource key", { resources: { health: 1, healthMax: 30 } }],
    ["no resource", { resources: {} }],
    ["string value", { resources: { health: "12" } }],
    ["fraction", { resources: { health: 1.5 } }],
    ["negative", { resources: { hope: -1 } }],
    ["above 9999", { resources: { hope: 10_000 } }],
    ["wrong actor type", { actorType: "pnj" }],
    ["wrong schema", { schemaVersion: 2 }],
    ["missing expected id", { expectedActorId: undefined }],
    ["short expected id", { expectedActorId: "abc" }],
    ["punctuated expected id", { expectedActorId: "actor000000000-1" }],
    ["zero sequence", { sequence: 0 }],
    ["unsafe sequence", { sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["bad character id", { characterId: "a b" }],
    ["no resource and no name", { resources: undefined }],
    ["blank name", { name: "  " }],
    ["name with NUL", { name: "A\0B" }],
    ["name over 200 code points", { name: "é".repeat(201) }],
    ["non-string name", { name: 7 }],
    ["previousName without a name", { previousName: "Old" }],
    ["blank previousName", { name: "New", previousName: "" }],
  ])("refuses %s", (_name, overrides) => {
    expect(() =>
      validateKnightActorResourcesV1({ ...request(), ...overrides }),
    ).toThrow(RpcError);
  });
});

function withoutResources(): Omit<KnightActorResourcesV1, "resources"> {
  const base: Partial<KnightActorResourcesV1> = request();
  delete base.resources;
  return base as Omit<KnightActorResourcesV1, "resources">;
}

describe("validateKnightActorResourcesV1 name", () => {
  it("accepts a name alone, with or without previousName", () => {
    const base = withoutResources();
    expect(
      validateKnightActorResourcesV1({ ...base, name: "é".repeat(200) }),
    ).toEqual({ ...base, resources: {}, name: "é".repeat(200) });
    expect(
      validateKnightActorResourcesV1({
        ...base,
        name: "New",
        previousName: "Old",
      }),
    ).toEqual({ ...base, resources: {}, name: "New", previousName: "Old" });
  });
});

describe("actor.resources.v1 name", () => {
  const nameOnly = (overrides: Record<string, unknown> = {}) => {
    return { ...withoutResources(), name: "Renamed", ...overrides };
  };

  it("renames the bound Actor in one update with the result flag", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const result = await apply(nameOnly());
    expect(actor.name).toBe("Renamed");
    expect(actor.updates).toEqual([
      {
        name: "Renamed",
        [`flags.${MODULE_ID}.actorResourcesV1`]: {
          ...result,
          contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          written: {},
        },
      },
    ]);
    expect(result).not.toHaveProperty("name");
  });

  it("applies when previousName matches the Actor's name", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    await apply(
      nameOnly({ previousName: "Existing", resources: { health: 12 } }),
    );
    expect(actor.updates[0]).toMatchObject({
      name: "Renamed",
      "system.sante.value": 12,
    });
  });

  it("refuses with name_conflict and writes nothing when Foundry renamed first", async () => {
    const actor = boundActor();
    actor.name = "Renamed in Foundry";
    stubFoundry([actor]);
    expect(
      await rpcCode(
        apply(
          nameOnly({ previousName: "Existing", resources: { health: 12 } }),
        ),
      ),
    ).toBe("name_conflict");
    expect(actor.updates).toHaveLength(0);
    expect(actor.name).toBe("Renamed in Foundry");
  });

  it("replays the same sequence and digest after the rename", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const first = await apply(nameOnly({ previousName: "Existing" }));
    const again = await apply(nameOnly({ previousName: "Existing" }));
    expect(again).toEqual(first);
    expect(actor.updates).toHaveLength(1);
  });

  it("writes nothing when a new sequence re-sends the recorded name and values", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    await apply(
      request({ sequence: 7, name: "Renamed", previousName: "Existing" }),
    );
    await apply(
      request({ sequence: 8, name: "Renamed", previousName: "Existing" }),
    );
    expect(actor.updates).toHaveLength(1);
    // Another name under a new sequence is a change.
    await apply(
      request({ sequence: 9, name: "Again", previousName: "Renamed" }),
    );
    expect(actor.updates).toHaveLength(2);
    expect(actor.updates[1]).toMatchObject({ name: "Again" });
  });

  it("writes no name the Actor already carries", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    await apply(nameOnly({ name: "Existing" }));
    expect(actor.updates).toHaveLength(1);
    expect(actor.updates[0]).not.toHaveProperty("name");
  });
});

describe("actor.resources.v1", () => {
  it("writes every current value on the bound Actor in one update with the result flag", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const result = await apply(
      request({
        resources: {
          health: 12,
          hope: 3,
          armour: 8,
          energy: 5,
          heroism: 2,
          contact: 0,
        },
      }),
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      resultDocId: ACTOR_ID,
      outcome: "updated",
      appliedRevision: 7,
      warnings: [],
    });
    expect(result.appliedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(actor.updates).toHaveLength(1);
    expect(actor.updates[0]).toEqual({
      "system.sante.value": 12,
      "system.espoir.value": 3,
      "system.equipements.armure.armure.value": 8,
      "system.equipements.armure.energie.value": 5,
      "system.heroisme.value": 2,
      "system.contacts.actuel": 0,
      [`flags.${MODULE_ID}.actorResourcesV1`]: {
        ...result,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        written: {
          "resources.health": 12,
          "resources.hope": 3,
          "resources.armour": 8,
          "resources.energy": 5,
          "resources.heroism": 2,
          "resources.contact": 0,
        },
      },
    });
  });

  it("follows the worn gear and warns where that gear has no path", async () => {
    const guardian = boundActor();
    guardian.system.wear = "guardian";
    stubFoundry([guardian]);
    const onGuardian = await apply(
      request({ resources: { armour: 4, energy: 3 } }),
    );
    expect(onGuardian.warnings).toEqual(["resource_unavailable:energy"]);
    expect(guardian.updates[0]).toMatchObject({
      "system.equipements.guardian.armure.value": 4,
    });
    expect(Object.keys(guardian.updates[0])).not.toContain(
      "system.equipements.armure.armure.value",
    );

    const civilian = boundActor();
    civilian.system.wear = "tenueCivile";
    stubFoundry([civilian]);
    const onCivilian = await apply(
      request({ resources: { armour: 4, energy: 3, health: 2 } }),
    );
    expect(onCivilian.warnings).toEqual([
      "resource_unavailable:armour",
      "resource_unavailable:energy",
    ]);
    expect(
      Object.keys(civilian.updates[0]).filter((k) => k.startsWith("system.")),
    ).toEqual(["system.sante.value"]);
  });

  it("writes on the armour Foundry wears: generation 4 or later whatever wear stores", async () => {
    const armour = (generation: number) => ({
      type: "armure",
      system: { generation },
    });
    const modern = boundActor();
    modern.system.wear = "tenueCivile";
    modern.items.contents = [armour(4)];
    stubFoundry([modern]);
    expect(
      (await apply(request({ resources: { armour: 4 } }))).warnings,
    ).toEqual([]);
    expect(modern.updates[0]).toMatchObject({
      "system.equipements.armure.armure.value": 4,
    });

    const older = boundActor();
    older.system.wear = "tenueCivile";
    older.items.contents = [armour(3)];
    stubFoundry([older]);
    expect(
      (await apply(request({ resources: { armour: 4 } }))).warnings,
    ).toEqual(["resource_unavailable:armour"]);

    const unset = boundActor();
    delete unset.system.wear;
    stubFoundry([unset]);
    expect(
      (await apply(request({ resources: { armour: 4 } }))).warnings,
    ).toEqual(["resource_unavailable:armour"]);
  });

  it("clamps to the prepared maximum and warns", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const result = await apply(
      request({ resources: { health: 99, heroism: 6, energy: 21 } }),
    );
    expect(result.warnings).toEqual([
      "resource_clamped:health",
      "resource_clamped:energy",
    ]);
    expect(actor.updates[0]).toMatchObject({
      "system.sante.value": 30,
      "system.heroisme.value": 6,
      "system.equipements.armure.energie.value": 20,
    });
  });

  it("writes nothing but the result when no path exists on this Actor", async () => {
    const actor = boundActor();
    delete actor.system.heroisme;
    stubFoundry([actor]);
    const result = await apply(request({ resources: { heroism: 1 } }));
    expect(result.warnings).toEqual(["resource_unavailable:heroism"]);
    expect(Object.keys(actor.updates[0])).toEqual([
      `flags.${MODULE_ID}.actorResourcesV1`,
    ]);
  });

  it("re-writes no value Foundry already holds, a capped re-send included", async () => {
    const actor = boundActor();
    actor.system.sante = { value: 30, max: 30 };
    stubFoundry([actor]);
    const result = await apply(
      request({ resources: { health: 99, hope: 1, heroism: 4 } }),
    );
    expect(result).toMatchObject({
      outcome: "updated",
      appliedRevision: 7,
      warnings: ["resource_clamped:health"],
    });
    expect(actor.updates[0]).toEqual({
      "system.heroisme.value": 4,
      [`flags.${MODULE_ID}.actorResourcesV1`]: {
        ...result,
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        // The capped value is what Foundry holds.
        written: {
          "resources.health": 30,
          "resources.hope": 1,
          "resources.heroism": 4,
        },
      },
    });
  });

  it("writes the result flag on a first no-op, so an older sequence stays refused", async () => {
    const actor = boundActor();
    actor.system.sante = { value: 30, max: 30 };
    stubFoundry([actor]);
    const noop = await apply(
      request({ sequence: 9, resources: { health: 99 } }),
    );
    expect(Object.keys(actor.updates[0])).toEqual([
      `flags.${MODULE_ID}.actorResourcesV1`,
    ]);
    expect(noop.appliedRevision).toBe(9);
    // An older sequence that drains after it never lands over it.
    expect(
      await rpcCode(apply(request({ sequence: 8, resources: { health: 4 } }))),
    ).toBe("stale_revision");
    expect(actor.updates).toHaveLength(1);
  });

  it("writes nothing when a new sequence re-sends the values the flag records", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const first = await apply(request({ sequence: 7 }));
    expect(actor.updates).toHaveLength(1);
    const flagKey = `flags.${MODULE_ID}.actorResourcesV1`;
    const firstDigest = (actor.updates[0][flagKey] as Record<string, unknown>)
      .contentDigest;
    expect(firstDigest).toMatch(/^[0-9a-f]{64}$/);
    // The result handed back keeps the strict shape: no contentDigest.
    expect(first).not.toHaveProperty("contentDigest");

    const again = await apply(request({ sequence: 8 }));
    expect(again).toMatchObject({ outcome: "updated", appliedRevision: 8 });
    expect(again).not.toHaveProperty("contentDigest");
    expect(actor.updates).toHaveLength(1);

    // Changed values write the patch and a flag with the new digest.
    await apply(request({ sequence: 9, resources: { health: 13 } }));
    expect(actor.updates).toHaveLength(2);
    expect(actor.updates[1]).toMatchObject({ "system.sante.value": 13 });
    const flag = actor.updates[1][flagKey] as Record<string, unknown>;
    expect(flag.appliedRevision).toBe(9);
    expect(flag.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(flag.contentDigest).not.toBe(firstDigest);
  });

  it("writes the flag once over an older flag that has no content digest", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const flagKey = `flags.${MODULE_ID}.actorResourcesV1`;
    await apply(request({ sequence: 7 }));
    const legacy = {
      ...(actor.updates[0][flagKey] as Record<string, unknown>),
    };
    delete legacy.contentDigest;
    (actor.flags[MODULE_ID] as Record<string, unknown>).actorResourcesV1 =
      legacy;
    await apply(request({ sequence: 8 }));
    expect(actor.updates).toHaveLength(2);
    expect(Object.keys(actor.updates[1])).toEqual([flagKey]);
    await apply(request({ sequence: 9 }));
    expect(actor.updates).toHaveLength(2);
  });

  it("accepts the captured Knight actor shape", async () => {
    for (const fixture of KNIGHT_SCHEMA_FIXTURES) {
      const actor = boundActor();
      // The capture omits `wear`: this PC is in its armour.
      actor.system = {
        ...structuredClone(fixture.actor.system),
        wear: "armure",
      };
      stubFoundry([actor], undefined, fixture.foundryGeneration);
      const result = await apply(
        request({
          resources: { health: 1, hope: 1, armour: 1, energy: 1, contact: 1 },
        }),
      );
      expect(result.warnings).toEqual([]);
    }
  });

  it("writes the six resources on a prepared-shape actor, and nothing on a re-send", async () => {
    const all = {
      health: 31,
      hope: 4,
      armour: 41,
      energy: 7,
      heroism: 2,
      contact: 3,
    };
    for (const fixture of KNIGHT_SCHEMA_FIXTURES) {
      const actor = preparedKnightActor(fixture);
      stubFoundry([actor], undefined, fixture.foundryGeneration);
      const result = await apply(request({ resources: all }));
      expect(result.warnings).toEqual([
        "resource_clamped:health",
        "resource_clamped:armour",
      ]);
      expect(actor.updates).toHaveLength(1);
      expect(actor.system).toMatchObject({
        sante: { value: 30 },
        espoir: { value: 4 },
        heroisme: { value: 2 },
        contacts: { actuel: 3 },
        equipements: {
          armure: { armure: { value: 40 }, energie: { value: 7 } },
        },
      });
      await apply(request({ sequence: 8, resources: all }));
      expect(actor.updates).toHaveLength(1);
    }
  });

  it("follows an ascension wear, and warns when that gear has no path", async () => {
    const actor = boundActor();
    actor.system.wear = "ascension";
    // Synthetic gear subtree: the paths follow whatever `wear` names.
    (actor.system.equipements as Record<string, unknown>).ascension = {
      armure: { value: 1 },
      energie: { value: 1 },
    };
    stubFoundry([actor]);
    const result = await apply(
      request({ resources: { armour: 9, energy: 4 } }),
    );
    expect(result.warnings).toEqual([]);
    expect(actor.updates[0]).toMatchObject({
      "system.equipements.ascension.armure.value": 9,
      "system.equipements.ascension.energie.value": 4,
    });
    expect(Object.keys(actor.updates[0])).not.toContain(
      "system.equipements.armure.armure.value",
    );

    const bare = boundActor();
    bare.system.wear = "ascension";
    stubFoundry([bare]);
    const missing = await apply(
      request({ resources: { armour: 9, energy: 4 } }),
    );
    expect(missing.warnings).toEqual([
      "resource_unavailable:armour",
      "resource_unavailable:energy",
    ]);
  });

  it("writes armour unclamped when the prepared armure.max is absent", async () => {
    const actor = boundActor();
    delete actor.system.armure;
    stubFoundry([actor]);
    const result = await apply(request({ resources: { armour: 999 } }));
    expect(result.warnings).toEqual([]);
    expect(actor.updates[0]).toMatchObject({
      "system.equipements.armure.armure.value": 999,
    });
  });

  it("replays the same sequence, refuses an older one and a reused one with other values", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const first = await apply(request());
    expect(await apply(request())).toEqual(first);
    expect(actor.updates).toHaveLength(1);

    expect(await rpcCode(apply(request({ resources: { health: 13 } })))).toBe(
      "revision_conflict",
    );
    expect(await rpcCode(apply(request({ sequence: 6 })))).toBe(
      "stale_revision",
    );
    const next = await apply(
      request({ sequence: 8, resources: { health: 13 } }),
    );
    expect(next.appliedRevision).toBe(8);
    expect(actor.updates).toHaveLength(2);
  });

  it("writes an unbound Actor the app imported, named by its id", async () => {
    const imported = boundActor();
    delete imported.flags[MODULE_ID];
    stubFoundry([imported]);
    const result = await apply(request());
    expect(result.resultDocId).toBe(ACTOR_ID);
    expect(imported.updates[0]).toMatchObject({ "system.sante.value": 12 });
    // The imported Actor is written, never bound.
    expect(
      (imported.flags[MODULE_ID] as Record<string, unknown>).binding,
    ).toBeUndefined();
  });

  it("never writes an imported id bound to another character or of another type", async () => {
    const elsewhere = boundActor();
    (
      elsewhere.flags[MODULE_ID] as { binding: { characterId: string } }
    ).binding.characterId = "character-2";
    stubFoundry([elsewhere]);
    expect(await rpcCode(apply(request()))).toBe("binding_conflict");
    expect(elsewhere.updates).toHaveLength(0);

    const npc = boundActor();
    delete npc.flags[MODULE_ID];
    npc.type = "pnj";
    stubFoundry([npc]);
    expect(await rpcCode(apply(request()))).toBe("binding_conflict");
    expect(npc.updates).toHaveLength(0);
  });

  it("never creates, adopts or retargets an Actor", async () => {
    const create = vi.fn();
    const unbound = fakeActor("actor00000000009");
    stubFoundry([unbound], create);
    expect(await rpcCode(apply(request()))).toBe("deleted_link");

    const other = boundActor("actor00000000002");
    stubFoundry([other], create);
    expect(await rpcCode(apply(request()))).toBe("binding_conflict");

    const npc = boundActor();
    npc.type = "pnj";
    stubFoundry([npc], create);
    expect(await rpcCode(apply(request()))).toBe("binding_conflict");

    stubFoundry([boundActor(), boundActor("actor00000000003")], create);
    expect(await rpcCode(apply(request()))).toBe("binding_collision");

    expect(create).not.toHaveBeenCalled();
    expect(unbound.updates).toHaveLength(0);
    expect(other.updates).toHaveLength(0);
    expect(npc.updates).toHaveLength(0);
  });

  it("requires a GM responder on an admitted Knight runtime", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const game = (globalThis as unknown as { game: Record<string, unknown> })
      .game;
    vi.stubGlobal("game", { ...game, user: { id: "p", isGM: false } });
    expect(await rpcCode(apply(request()))).toBe("permission_denied");

    stubFoundry([actor], undefined, 13, undefined, "3.58.32");
    expect(await rpcCode(apply(request()))).toBe("unsupported_runtime");
    expect(actor.updates).toHaveLength(0);
  });

  it("validates before touching the world", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    expect(await rpcCode(apply({ ...request(), flags: { x: 1 } }))).toBe(
      "invalid_args",
    );
    expect(actor.updates).toHaveLength(0);
  });
});

describe("actor.resources.v1 base (compare-and-set)", () => {
  async function refusal(promise: Promise<unknown>): Promise<RpcError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("validates base.resources with the request's keys and bounds", () => {
    expect(
      validateKnightActorResourcesV1(
        request({ base: { resources: { health: 1 } } }),
      ).base,
    ).toEqual({ resources: { health: 1 } });
    expect(() =>
      validateKnightActorResourcesV1(
        request({ base: { resources: { mana: 1 } } as never }),
      ),
    ).toThrow(/base\.resources\.mana/);
    expect(() =>
      validateKnightActorResourcesV1(
        request({ base: { resources: { health: -1 } } }),
      ),
    ).toThrow(/base\.resources\.health/);
    expect(() =>
      validateKnightActorResourcesV1(request({ base: { hp: 1 } } as never)),
    ).toThrow(/base\.hp/);
  });

  it("writes when Foundry still holds the base", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    await apply(request({ base: { resources: { health: 1, hope: 1 } } }));
    expect(actor.updates[0]).toMatchObject({
      "system.sante.value": 12,
      "system.espoir.value": 3,
    });
  });

  it("refuses the whole request with base_conflict when a written value moved in Foundry", async () => {
    const actor = boundActor();
    (actor.system as { sante: { value: number } }).sante.value = 5;
    stubFoundry([actor]);
    const error = await refusal(
      apply(request({ base: { resources: { health: 1, hope: 1 } } })),
    );
    expect(error.code).toBe("base_conflict");
    expect(error.message).toContain("resources.health");
    expect(error.message).not.toContain("resources.hope");
    // Nothing written, not even the unmoved hope nor the result flag.
    expect(actor.updates).toHaveLength(0);
  });

  it("does not compare a field Foundry already holds at the requested value", async () => {
    const actor = boundActor();
    (actor.system as { sante: { value: number } }).sante.value = 12;
    stubFoundry([actor]);
    await apply(request({ base: { resources: { health: 1 } } }));
    expect(actor.updates[0]).toMatchObject({ "system.espoir.value": 3 });
  });

  it("ignores a base for a value the request does not write", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    await apply(
      request({
        resources: { health: 12 },
        base: { resources: { health: 1, hope: 40 } },
      }),
    );
    expect(actor.updates[0]).toMatchObject({ "system.sante.value": 12 });
  });

  it("without a base writes over a Foundry edit, as before", async () => {
    const actor = boundActor();
    (actor.system as { sante: { value: number } }).sante.value = 5;
    stubFoundry([actor]);
    await apply(request());
    expect(actor.updates[0]).toMatchObject({ "system.sante.value": 12 });
  });

  it("accepts a base read before the app's own previous write landed, not a later Foundry edit", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    await apply(request({ sequence: 7, base: { resources: { health: 1 } } }));
    // Sequence 8 was based on the same read (health 1); Foundry holds 12 now,
    // the app's own write.
    await apply(
      request({
        sequence: 8,
        resources: { health: 9 },
        base: { resources: { health: 1 } },
      }),
    );
    expect(actor.updates[1]).toMatchObject({ "system.sante.value": 9 });
    (actor.system as { sante: { value: number } }).sante.value = 4;
    await expect(
      apply(
        request({
          sequence: 9,
          resources: { health: 2 },
          base: { resources: { health: 1 } },
        }),
      ),
    ).rejects.toMatchObject({ code: "base_conflict" });
  });
});

describe("actor.resources.v1 non-player actors", () => {
  type NpcType = "pnj" | "creature" | "bande" | "vehicule";
  const fixtureSystem = (file: string): Record<string, unknown> =>
    (
      JSON.parse(
        readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"),
      ) as { actor: { system: Record<string, unknown> } }
    ).actor.system;
  const FIXTURES: Record<NpcType, Record<string, unknown>> = {
    pnj: fixtureSystem("knight-pnj-3.58.33-foundry14.json"),
    creature: fixtureSystem("knight-creature-3.58.37-model.json"),
    bande: fixtureSystem("knight-bande-3.58.37-model.json"),
    vehicule: fixtureSystem("knight-vehicule-3.58.37-model.json"),
  };
  const KEYS: Record<NpcType, Array<"health" | "armour" | "energy">> = {
    pnj: ["health", "armour", "energy"],
    creature: ["health", "armour", "energy"],
    bande: ["health"],
    vehicule: ["armour", "energy"],
  };

  /** An Actor of `type` from its fixture, with the maxima Knight prepares
   * (the pnj capture is source data, without them). Unbound, as imported. */
  function npcActor(type: NpcType, id = ACTOR_ID): FakeActor {
    const actor = fakeActor(id, "Garde");
    actor.type = type;
    actor.items.contents = [];
    actor.system = structuredClone(FIXTURES[type]);
    for (const [field, max] of [
      ["sante", 30],
      ["armure", 20],
      ["energie", 10],
    ] as const)
      Object.assign(actor.system[field] as object, { value: 2, max });
    return actor;
  }

  function npcRequest(
    type: NpcType,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...request({
        resources: Object.fromEntries(KEYS[type].map((key) => [key, 7])),
      }),
      actorType: type,
      ...overrides,
    };
  }

  async function refusal(promise: Promise<unknown>): Promise<RpcError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("writes a pnj's health on the top-level sante.value, never a PC gear path", async () => {
    const actor = npcActor("pnj");
    stubFoundry([actor]);
    const result = await apply(npcRequest("pnj", { resources: { health: 7 } }));
    expect(result).toMatchObject({ outcome: "updated", warnings: [] });
    const update = actor.updates[0];
    expect(update["system.sante.value"]).toBe(7);
    expect(Object.keys(update).some((k) => k.includes("equipements"))).toBe(
      false,
    );
    expect(Object.keys(update).filter((k) => k.startsWith("system."))).toEqual([
      "system.sante.value",
    ]);
  });

  it("writes a creature's armour on armure.value", async () => {
    const actor = npcActor("creature");
    stubFoundry([actor]);
    await apply(npcRequest("creature", { resources: { armour: 9 } }));
    expect(actor.updates[0]["system.armure.value"]).toBe(9);
  });

  for (const type of ["pnj", "creature", "bande", "vehicule"] as const)
    it(`writes only the ${type}'s meter paths its fixture carries`, async () => {
      const actor = npcActor(type);
      stubFoundry([actor]);
      const result = await apply(npcRequest(type));
      expect(result.warnings).toEqual([]);
      const keys = Object.keys(actor.updates[0]).filter((k) =>
        k.startsWith("system."),
      );
      expect(keys.sort()).toEqual(
        KEYS[type]
          .map(
            (k) =>
              `system.${{ health: "sante", armour: "armure", energy: "energie" }[k]}.value`,
          )
          .sort(),
      );
      for (const key of keys)
        expect(
          hasFixturePath(FIXTURES[type], key.slice("system.".length)),
          key,
        ).toBe(true);
    });

  it("clamps to the prepared maximum and warns", async () => {
    const actor = npcActor("pnj");
    stubFoundry([actor]);
    const result = await apply(
      npcRequest("pnj", { resources: { health: 99 } }),
    );
    expect(result.warnings).toEqual(["resource_clamped:health"]);
    expect(actor.updates[0]["system.sante.value"]).toBe(30);
  });

  it("leaves a pool the Actor's options switch off unwritten", async () => {
    const actor = npcActor("creature");
    (actor.system.options as Record<string, unknown>) = {
      ...(actor.system.options as object),
      armure: false,
    };
    stubFoundry([actor]);
    const result = await apply(
      npcRequest("creature", { resources: { armour: 5, health: 7 } }),
    );
    expect(result.warnings).toEqual(["resource_unavailable:armour"]);
    expect(actor.updates[0]["system.armure.value"]).toBeUndefined();
    expect(actor.updates[0]["system.sante.value"]).toBe(7);
  });

  it("writes a bound app NPC", async () => {
    const actor = npcActor("pnj");
    actor.flags[MODULE_ID] = {
      binding: {
        schemaVersion: 1,
        worldId: "world-1",
        tableId: "table-1",
        characterId: "character-1",
      },
    };
    stubFoundry([actor]);
    await apply(npcRequest("pnj", { resources: { energy: 4 } }));
    expect(actor.updates[0]["system.energie.value"]).toBe(4);
  });

  it.each([
    [
      { actorType: "mechaarmure" },
      "actorType must be knight, pnj, creature, bande or vehicule",
    ],
    [
      { actorType: "ia" },
      "actorType must be knight, pnj, creature, bande or vehicule",
    ],
    [
      { actorType: "hazard" },
      "actorType must be knight, pnj, creature, bande or vehicule",
    ],
    [
      { actorType: "bande", resources: { armour: 1 } },
      "resources.armour is not written on a bande",
    ],
    [
      { actorType: "vehicule", resources: { health: 1 } },
      "resources.health is not written on a vehicule",
    ],
    [
      { actorType: "pnj", resources: { hope: 1 } },
      "resources.hope is not written on a pnj",
    ],
    [
      {
        actorType: "bande",
        resources: { health: 1 },
        base: { resources: { energy: 1 } },
      },
      "base.resources.energy is not written on a bande",
    ],
    [
      { actorType: "pnj", resources: { health: 1 }, name: "Garde" },
      "name is not written on a pnj",
    ],
    [
      { actorType: "pnj", resources: { health: 1, mana: 1 } },
      "resources.mana is not allowed",
    ],
  ])("refuses %j: %s", async (overrides, message) => {
    expect(() =>
      validateKnightActorResourcesV1({ ...request(), ...overrides }),
    ).toThrow(message);
    const actor = npcActor("pnj");
    stubFoundry([actor]);
    expect(await rpcCode(apply({ ...request(), ...overrides }))).toBe(
      "invalid_args",
    );
    expect(actor.updates).toHaveLength(0);
  });

  it("refuses a request whose type is not the Actor's", async () => {
    const creature = npcActor("creature");
    stubFoundry([creature]);
    expect(await rpcCode(apply(npcRequest("pnj")))).toBe("binding_conflict");
    const pc = boundActor();
    stubFoundry([pc]);
    expect(await rpcCode(apply(npcRequest("pnj")))).toBe("binding_conflict");
    const boundCreature = npcActor("creature");
    boundCreature.flags[MODULE_ID] = {
      binding: {
        schemaVersion: 1,
        worldId: "world-1",
        tableId: "table-1",
        characterId: "character-1",
      },
    };
    stubFoundry([boundCreature]);
    expect(await rpcCode(apply(npcRequest("pnj")))).toBe("binding_conflict");
    for (const actor of [creature, pc, boundCreature])
      expect(actor.updates).toHaveLength(0);
  });

  it("never writes a pnj bound to another character, named by its id", async () => {
    const actor = npcActor("pnj");
    actor.flags[MODULE_ID] = {
      binding: {
        schemaVersion: 1,
        worldId: "world-1",
        tableId: "table-1",
        characterId: "character-2",
      },
    };
    stubFoundry([actor]);
    expect(await rpcCode(apply(npcRequest("pnj")))).toBe("binding_conflict");
    expect(actor.updates).toHaveLength(0);
  });

  it("refuses a stale base with base_conflict and writes nothing", async () => {
    const actor = npcActor("pnj");
    (actor.system.sante as { value: number }).value = 5;
    stubFoundry([actor]);
    const error = await refusal(
      apply(
        npcRequest("pnj", {
          resources: { health: 7 },
          base: { resources: { health: 3 } },
        }),
      ),
    );
    expect(error.code).toBe("base_conflict");
    expect(actor.updates).toHaveLength(0);
  });

  it("is refused below the verified Knight floor and on a later major", async () => {
    for (const version of ["3.58.32", "4.0.0"]) {
      const actor = npcActor("pnj");
      stubFoundry([actor], undefined, 13, undefined, version);
      expect(await rpcCode(apply(npcRequest("pnj")))).toBe(
        "unsupported_runtime",
      );
      expect(actor.updates).toHaveLength(0);
    }
  });
});

describe("actor.resources.v1 wear", () => {
  const wear = (
    to: string,
    from: string,
    overrides: Record<string, unknown> = {},
  ) => ({ ...withoutResources(), wear: to, previousWear: from, ...overrides });

  /** A bound PC folded to `guardian` with one armour Item of `generation`. */
  function folded(generation = 1, stored = "guardian"): FakeActor {
    const actor = boundActor();
    actor.items.contents = [
      { type: "armure", name: "Paladin", system: { generation } },
    ];
    actor.system.wear = stored;
    stubFoundry([actor]);
    return actor;
  }

  it("validates wear and previousWear", () => {
    const refused = (req: unknown) =>
      expect(() => validateKnightActorResourcesV1(req)).toThrow(
        expect.objectContaining({ code: "invalid_args" }),
      );
    expect(validateKnightActorResourcesV1(wear("armure", "ascension"))).toEqual(
      {
        ...withoutResources(),
        resources: {},
        wear: "armure",
        previousWear: "ascension",
      },
    );
    validateKnightActorResourcesV1(
      wear("tenueCivile", "armure", { name: "N" }),
    );
    validateKnightActorResourcesV1(
      wear("guardian", "armure", { resources: {} }),
    );
    refused(wear("ascension", "armure"));
    refused(wear("armour", "guardian"));
    refused(wear("armure", "nope"));
    refused({ ...withoutResources(), wear: "armure" });
    refused({ ...withoutResources(), name: "N", previousWear: "armure" });
    refused(wear("armure", "guardian", { resources: { energy: 3 } }));
    refused(wear("armure", "guardian", { base: { resources: {} } }));
    refused(wear("armure", "guardian", { actorType: "pnj" }));
  });

  it("deploys: one update writes system.wear with the result flag, never a meter first", async () => {
    const actor = folded();
    const result = await apply(wear("armure", "guardian"));
    expect(result.warnings).toEqual([]);
    expect(actor.updates).toHaveLength(1);
    const [patch] = actor.updates;
    expect(Object.keys(patch)[0]).toBe("system.wear");
    expect(patch).toEqual({
      "system.wear": "armure",
      [`flags.${MODULE_ID}.actorResourcesV1`]: expect.objectContaining({
        contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(actor.system.wear).toBe("armure");
  });

  it("refuses wear_conflict and writes nothing when Foundry moved the wear first", async () => {
    const actor = folded(1, "tenueCivile");
    expect(await rpcCode(apply(wear("armure", "guardian")))).toBe(
      "wear_conflict",
    );
    expect(actor.updates).toHaveLength(0);
  });

  it("refuses wear_conflict while a capacity holds the ascension", async () => {
    const actor = folded(1, "ascension");
    expect(await rpcCode(apply(wear("guardian", "ascension")))).toBe(
      "wear_conflict",
    );
    expect(actor.updates).toHaveLength(0);
  });

  it("refuses wear_conflict when deploying with no armour Item", async () => {
    const actor = folded();
    actor.items.contents = [];
    expect(await rpcCode(apply(wear("armure", "guardian")))).toBe(
      "wear_conflict",
    );
    expect(actor.updates).toHaveLength(0);
  });

  it("writes no wear for a generation 4 armour, which Foundry wears anyway", async () => {
    const actor = folded(4);
    const result = await apply(wear("guardian", "armure"));
    expect(result.warnings).toEqual(["wear_forced"]);
    expect(actor.system.wear).toBe("guardian");
    for (const patch of actor.updates)
      expect(patch).not.toHaveProperty("system.wear");
  });

  it("is applied when the Actor already wears it, and a new sequence writes nothing", async () => {
    const actor = folded(1, "armure");
    const first = await apply(wear("armure", "guardian", { sequence: 7 }));
    expect(first.warnings).toEqual([]);
    expect(actor.updates).toHaveLength(1);
    expect(actor.updates[0]).not.toHaveProperty("system.wear");
    await apply(wear("armure", "guardian", { sequence: 8 }));
    expect(actor.updates).toHaveLength(1);
  });

  it("folds with the name in one update", async () => {
    const actor = folded(1, "armure");
    await apply(
      wear("tenueCivile", "armure", {
        name: "Renamed",
        previousName: "Existing",
      }),
    );
    expect(actor.updates[0]).toMatchObject({
      "system.wear": "tenueCivile",
      name: "Renamed",
    });
  });

  it("keeps the digest of a request without wear", async () => {
    const actor = folded(1, "armure");
    await apply(request({ sequence: 7 }));
    const flag = (actor.flags[MODULE_ID] as Record<string, any>)
      .actorResourcesV1;
    expect(flag.contentDigest).toBe(
      await canonicalDigest({ health: 12, hope: 3 }),
    );
  });
});

describe("actor.resources.v1 after the world is linked again", () => {
  // The backend mints a new world id when the world is unlinked and linked
  // again; the table and character ids stay the same.
  it("writes the Actor bound under the old world id, and replays a re-sent sequence", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    const first = await apply(request());
    expect(actor.updates).toHaveLength(1);
    expect(await apply(request({ worldId: "world-2" }))).toEqual(first);
    expect(actor.updates).toHaveLength(1);

    const next = await apply(
      request({ worldId: "world-2", sequence: 8, resources: { health: 13 } }),
    );
    expect(next.resultDocId).toBe(ACTOR_ID);
    expect(actor.updates).toHaveLength(2);
    expect(actor.updates[1]).toMatchObject({ "system.sante.value": 13 });
  });

  it("takes over an Actor bound to another table under the same world id", async () => {
    const elsewhere = boundActor();
    (
      elsewhere.flags[MODULE_ID] as { binding: { tableId: string } }
    ).binding.tableId = "table-2";
    stubFoundry([elsewhere]);
    expect((await apply(request())).warnings).toEqual(["binding_taken_over"]);
    expect(
      (elsewhere.flags[MODULE_ID] as { binding: { tableId: string } }).binding
        .tableId,
    ).toBe("table-1");
  });
});

describe("actor.resources.v1 landed check", () => {
  it("answers procedure_failed when Foundry drops a meters-only update", async () => {
    const actor = boundActor();
    // Foundry 14 drops a refused update whole and resolves undefined.
    actor.update = async (changes) => {
      actor.updates.push(changes);
    };
    stubFoundry([actor]);
    const error = await apply(request()).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "procedure_failed",
      message: "actor.resources.v1: Foundry did not apply the update",
    });
    expect(actor.updates).toHaveLength(1);
    expect(actor.flags[MODULE_ID]).not.toHaveProperty("actorResourcesV1");
  });

  it("is applied when the update resolves undefined but the values are there", async () => {
    const actor = boundActor();
    stubFoundry([actor]);
    // The harness update resolves undefined, as Foundry's no-difference one.
    const result = await apply(request());
    expect(result.outcome).toBe("updated");
    expect(actor.system).toMatchObject({ sante: { value: 12 } });
  });
});

describe("actor.resources.v1 landed check, prepared values", () => {
  it("is applied when Foundry prepares a written value differently", async () => {
    const actor = boundActor();
    // Foundry applies the update, then prepares the pool lower than written
    // (a derived value): the update landed, so the write is applied.
    const update = actor.update.bind(actor);
    actor.update = async (changes) => {
      await update(changes);
      (actor.system as { sante: { value: number } }).sante.value = 11;
    };
    stubFoundry([actor]);
    const result = await apply(request());
    expect(result.outcome).toBe("updated");
    expect(actor.flags[MODULE_ID]).toHaveProperty("actorResourcesV1");
  });
});

describe("actor.resources.v1 sheet validation", () => {
  const sheetOnly = (overrides: Record<string, unknown>) => ({
    ...withoutResources(),
    sheet: { aspects: { chair: 5 } },
    base: { sheet: { aspects: { chair: 4 } } },
    ...overrides,
  });

  it("accepts every field with its base, alone or beside the meters", () => {
    const sheet = {
      aspects: { chair: 0, masque: 20 },
      characteristics: { force: 4, sangFroid: 3 },
      experienceCurrent: 99_999,
      gloryTotal: 0,
      gloryCurrent: -99_999,
      age: "é".repeat(100),
      nickname: "",
      majorMotivation: "m".repeat(2000),
    };
    const alone = sheetOnly({ sheet, base: { sheet } });
    expect(validateKnightActorResourcesV1(alone)).toEqual({
      ...alone,
      resources: {},
    });
    const both = request({
      sheet,
      base: { resources: { health: 1 }, sheet },
    } as never);
    expect(validateKnightActorResourcesV1(both)).toEqual(both);
  });

  it.each([
    [
      {
        actorType: "pnj",
        resources: { health: 1 },
        sheet: { gloryTotal: 1 },
        base: { sheet: { gloryTotal: 1 } },
      },
      "sheet is not written on a pnj",
    ],
    [
      { wear: "armure", previousWear: "guardian" },
      "sheet never rides with wear",
    ],
    [{ sheet: {} }, "sheet needs at least one field"],
    [{ sheet: { aspects: {} } }, "sheet.aspects needs at least one key"],
    [
      { sheet: { characteristics: {} } },
      "sheet.characteristics needs at least one key",
    ],
    [{ sheet: { aspects: { chair: 21 } } }, "sheet.aspects.chair outside 0-20"],
    [
      { sheet: { characteristics: { force: -1 } } },
      "sheet.characteristics.force outside 0-20",
    ],
    [
      { sheet: { experienceCurrent: 100_000 } },
      "sheet.experienceCurrent outside 0-99999",
    ],
    [{ sheet: { gloryTotal: 1.5 } }, "sheet.gloryTotal outside 0-99999"],
    [
      { sheet: { gloryCurrent: 100_000 } },
      "sheet.gloryCurrent outside -99999-99999",
    ],
    [
      { sheet: { gloryCurrent: -100_000 } },
      "sheet.gloryCurrent outside -99999-99999",
    ],
    [
      { sheet: { gloryCurrent: "3" } },
      "sheet.gloryCurrent outside -99999-99999",
    ],
    [
      { base: { sheet: { aspects: { chair: 4 }, gloryCurrent: 1 } } },
      "base.sheet must name every field of sheet",
    ],
    [
      { sheet: { age: "a".repeat(101) } },
      "sheet.age must be text of at most 100 characters without NUL",
    ],
    [
      { sheet: { nickname: "A\0B" } },
      "sheet.nickname must be text of at most 200 characters without NUL",
    ],
    [
      { sheet: { majorMotivation: "m".repeat(2001) } },
      "sheet.majorMotivation must be text of at most 2000 characters without NUL",
    ],
    [{ sheet: { age: 31 } }, "sheet.age must be text of at most 100"],
    [{ sheet: { origin: "x" } }, "sheet.origin is not allowed"],
    [
      { sheet: { aspects: { esprit: 1 } } },
      "sheet.aspects.esprit is not allowed",
    ],
    [
      { sheet: { characteristics: { sang_froid: 1 } } },
      "sheet.characteristics.sang_froid is not allowed",
    ],
    [{ base: undefined }, "base.sheet must name every field of sheet"],
    [
      { sheet: { aspects: { chair: 5 }, gloryTotal: 3 } },
      "base.sheet must name every field of sheet",
    ],
    [
      { base: { sheet: { aspects: { chair: 4 }, gloryTotal: 1 } } },
      "base.sheet must name every field of sheet",
    ],
    [
      { base: { sheet: { aspects: { chair: 4, dame: 2 } } } },
      "base.sheet must name every field of sheet",
    ],
    [
      { sheet: undefined, resources: { health: 1 } },
      "base.sheet must name every field of sheet",
    ],
    [
      { base: { sheet: { aspects: { chair: 4, x: 1 } } } },
      "base.sheet.aspects.x is not allowed",
    ],
    [
      { base: { sheet: { aspects: { chair: 21 } } } },
      "base.sheet.aspects.chair outside 0-20",
    ],
    [
      { base: { sheet: { aspects: { chair: 4 } }, hp: 1 } },
      "base.hp is not allowed",
    ],
    [
      { sheet: undefined, base: undefined },
      "resources needs at least one value, a name, a wear or a sheet field",
    ],
  ])("refuses %j: %s", async (overrides, message) => {
    const req = sheetOnly(overrides);
    expect(() => validateKnightActorResourcesV1(req)).toThrow(message);
    const actor = boundActor();
    stubFoundry([actor]);
    expect(await rpcCode(apply(req))).toBe("invalid_args");
    expect(actor.updates).toHaveLength(0);
  });
});

describe("actor.resources.v1 sheet", () => {
  /** A bound Knight PC prepared as Foundry 14 / Knight 3.58.38 does. */
  function sheetPc(
    bases: Record<string, number> = {},
    wounds: Record<string, number> = {},
    edit?: (source: Record<string, any>) => void,
  ): { actor: FakeActor; state: KnightSheetState } {
    const actor = boundActor();
    const source = knightSheetSource(bases);
    edit?.(source);
    const state = withKnightSheet(actor, source, wounds);
    stubFoundry([actor]);
    return { actor, state };
  }

  const sheetReq = (
    sheet: Record<string, unknown>,
    base: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) => ({ ...withoutResources(), sheet, base: { sheet: base }, ...overrides });

  const stored = (state: KnightSheetState, path: string) =>
    valueAt(state.source, path);
  const prepared = (actor: FakeActor, path: string) =>
    valueAt(actor.system, path);
  const written = (actor: FakeActor) =>
    recordedFields(
      (actor.flags[MODULE_ID] as Record<string, any>).actorResourcesV1.written,
    );
  const flagWarnings = (actor: FakeActor) =>
    (actor.flags[MODULE_ID] as Record<string, any>).actorResourcesV1.warnings;

  it("inverts Knight's formula on a wounded PC: no conflict, the base takes the wound", async () => {
    const { actor, state } = sheetPc({ chair: 4 }, { chair: 1 });
    expect(prepared(actor, "aspects.chair.value")).toBe(3);
    const result = await apply(
      sheetReq(
        { aspects: { chair: 4 } },
        { aspects: { chair: 3 } },
        { resources: { health: 12 } },
      ),
    );
    expect(result.warnings).toEqual([]);
    expect(actor.updates).toHaveLength(1);
    expect(actor.updates[0]).toMatchObject({
      "system.sante.value": 12,
      "system.aspects.chair.base": 5,
    });
    expect(stored(state, "aspects.chair.base")).toBe(5);
    expect(prepared(actor, "aspects.chair.value")).toBe(4);
    expect(written(actor)).toMatchObject({
      "resources.health": 12,
      "sheet.aspects.chair": 4,
    });
  });

  it("counts an XP purchase line's bonus once", async () => {
    const { actor, state } = sheetPc({ chair: 6, force: 3 }, {}, (s) => {
      s.progression.experience = {
        total: 8,
        depense: {
          liste: {
            1: { addOrder: 1, caracteristique: "force", bonus: 1, cout: 8 },
          },
        },
      };
    });
    expect(prepared(actor, "aspects.chair.caracteristiques.force.value")).toBe(
      4,
    );
    await apply(
      sheetReq(
        { characteristics: { force: 5 } },
        { characteristics: { force: 4 } },
      ),
    );
    expect(stored(state, "aspects.chair.caracteristiques.force.base")).toBe(4);
    expect(prepared(actor, "aspects.chair.caracteristiques.force.value")).toBe(
      5,
    );
  });

  it("computes the base from the current prepared value after its own write, never twice", async () => {
    const { actor, state } = sheetPc({ chair: 4 });
    await apply(sheetReq({ aspects: { chair: 5 } }, { aspects: { chair: 4 } }));
    expect(stored(state, "aspects.chair.base")).toBe(5);
    // Built before the app saw its own write: base 4, Foundry holds 5.
    await apply(
      sheetReq(
        { aspects: { chair: 6 } },
        { aspects: { chair: 4 } },
        { sequence: 8 },
      ),
    );
    expect(stored(state, "aspects.chair.base")).toBe(6);
    expect(prepared(actor, "aspects.chair.value")).toBe(6);
  });

  it("refuses base_conflict when Foundry moved the stat first, and writes no meter", async () => {
    const { actor, state } = sheetPc({ chair: 4 });
    state.source.aspects.chair.base = 6;
    reprepare(actor, state);
    const error = await apply(
      sheetReq(
        { aspects: { chair: 5 } },
        { aspects: { chair: 4 } },
        { resources: { health: 12 } },
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "base_conflict" });
    expect((error as Error).message).toContain("sheet.aspects.chair");
    expect(actor.updates).toHaveLength(0);
    expect(stored(state, "sante.value")).toBe(1);
  });

  it("replays a sequence without an update, and writes no base Foundry already prepares", async () => {
    const { actor } = sheetPc({ chair: 4 });
    const req = sheetReq({ aspects: { chair: 5 } }, { aspects: { chair: 4 } });
    const first = await apply(req);
    expect(await apply(req)).toEqual(first);
    expect(actor.updates).toHaveLength(1);
    await apply(
      sheetReq(
        { aspects: { chair: 5 } },
        { aspects: { chair: 5 } },
        { sequence: 8, resources: { health: 12 } },
      ),
    );
    expect(actor.updates).toHaveLength(2);
    expect(
      Object.keys(actor.updates[1]).filter((k) => k.endsWith(".base")),
    ).toEqual([]);
  });

  it("skips an overridden aspect with stat_overridden and writes the rest", async () => {
    const { actor, state } = sheetPc({}, {}, (s) => {
      s.aspects.dame.override = { lab: 6 };
    });
    expect(prepared(actor, "aspects.dame.value")).toBe(6);
    const result = await apply(
      sheetReq(
        { aspects: { chair: 3, dame: 7 } },
        { aspects: { chair: 2, dame: 6 } },
      ),
    );
    expect(result.warnings).toEqual(["stat_overridden:aspects.dame"]);
    expect(stored(state, "aspects.chair.base")).toBe(3);
    expect(stored(state, "aspects.dame.base")).toBe(2);
    expect(written(actor)).not.toHaveProperty(["sheet.aspects.dame"]);
    expect(flagWarnings(actor)).toEqual(["stat_overridden:aspects.dame"]);
  });

  it("skips a prepared value that is not a number with stat_unavailable", async () => {
    const { actor, state } = sheetPc();
    state.after = (s) => {
      Object.defineProperty(s.aspects.bete, "value", { value: "4" });
      Object.defineProperty(s.aspects.chair.caracteristiques.force, "value", {
        value: Number.NaN,
      });
    };
    reprepare(actor, state);
    const result = await apply(
      sheetReq(
        {
          aspects: { chair: 3, bete: 3 },
          characteristics: { force: 2 },
        },
        {
          aspects: { chair: 2, bete: 4 },
          characteristics: { force: 1 },
        },
      ),
    );
    expect(result.warnings).toEqual([
      "stat_unavailable:aspects.bete",
      "stat_unavailable:characteristics.force",
    ]);
    expect(stored(state, "aspects.chair.base")).toBe(3);
    expect(stored(state, "aspects.bete.base")).toBe(2);
    expect(stored(state, "aspects.chair.caracteristiques.force.base")).toBe(1);
  });

  it("undoes a capped characteristic: the base never moves down, nothing recorded, the warning replays", async () => {
    // A wound lowers chair to 3; force (base 4, an XP bonus of 1) is capped
    // to 3 by its aspect. The inverse of force 4 would be base 3.
    const { actor, state } = sheetPc(
      { chair: 4, force: 4 },
      { chair: 1 },
      (s) => {
        s.progression.experience = {
          total: 8,
          depense: {
            liste: {
              1: { addOrder: 1, caracteristique: "force", bonus: 1, cout: 8 },
            },
          },
        };
      },
    );
    expect(prepared(actor, "aspects.chair.caracteristiques.force.value")).toBe(
      3,
    );
    const req = sheetReq(
      { characteristics: { force: 4 } },
      { characteristics: { force: 3 } },
    );
    const result = await apply(req);
    expect(result.warnings).toEqual(["stat_clamped:characteristics.force"]);
    expect(stored(state, "aspects.chair.caracteristiques.force.base")).toBe(4);
    expect(actor.updates).toHaveLength(2);
    expect(written(actor)).not.toHaveProperty(["sheet.characteristics.force"]);
    expect(flagWarnings(actor)).toEqual(["stat_clamped:characteristics.force"]);
    expect(await apply(req)).toEqual(result);
    expect(actor.updates).toHaveLength(2);
  });

  it("undoes an aspect held at its maximum, and one floored at base 0", async () => {
    const { actor, state } = sheetPc({ chair: 7 }, {}, (s) => {
      s.aspects.chair.max = 7;
      s.aspects.bete.optimisation.bonus = { module: 3 };
    });
    expect(prepared(actor, "aspects.bete.value")).toBe(5);
    const result = await apply(
      sheetReq(
        { aspects: { chair: 8, bete: 1 } },
        { aspects: { chair: 7, bete: 5 } },
      ),
    );
    expect(result.warnings).toEqual([
      "stat_clamped:aspects.chair",
      "stat_clamped:aspects.bete",
    ]);
    expect(stored(state, "aspects.chair.base")).toBe(7);
    expect(stored(state, "aspects.bete.base")).toBe(2);
    expect(prepared(actor, "aspects.chair.value")).toBe(7);
    expect(prepared(actor, "aspects.bete.value")).toBe(5);
  });

  it("reports an aspect whose base is already at Knight's bound without writing it", async () => {
    const { actor, state } = sheetPc({ chair: 9 });
    const result = await apply(
      sheetReq({ aspects: { chair: 10 } }, { aspects: { chair: 9 } }),
    );
    expect(result.warnings).toEqual(["stat_clamped:aspects.chair"]);
    expect(actor.updates).toHaveLength(1);
    expect(stored(state, "aspects.chair.base")).toBe(9);
    expect(written(actor)).not.toHaveProperty(["sheet.aspects.chair"]);
  });

  it("undoes a characteristic its restored aspect caps again", async () => {
    const { actor, state } = sheetPc({ chair: 4, force: 4 }, {}, (s) => {
      s.aspects.chair.max = 5;
    });
    const result = await apply(
      sheetReq(
        { aspects: { chair: 6 }, characteristics: { force: 5 } },
        { aspects: { chair: 4 }, characteristics: { force: 4 } },
      ),
    );
    expect(result.warnings).toEqual([
      "stat_clamped:aspects.chair",
      "stat_clamped:characteristics.force",
    ]);
    expect(stored(state, "aspects.chair.base")).toBe(4);
    expect(stored(state, "aspects.chair.caracteristiques.force.base")).toBe(4);
    expect(actor.updates).toHaveLength(3);
    const kept = written(actor);
    expect(kept).not.toHaveProperty(["sheet.aspects.chair"]);
    expect(kept).not.toHaveProperty(["sheet.characteristics.force"]);
  });

  describe("unspent XP", () => {
    const withLine =
      (cout: number, total: number) => (s: Record<string, any>) => {
        s.progression.experience = {
          total,
          depense: {
            liste: { 1: { addOrder: 1, caracteristique: "", bonus: 0, cout } },
          },
        };
      };

    it("writes by difference on the total, up and down", async () => {
      const up = sheetPc({}, {}, withLine(8, 20));
      expect(prepared(up.actor, "progression.experience.actuel")).toBe(12);
      await apply(
        sheetReq({ experienceCurrent: 15 }, { experienceCurrent: 12 }),
      );
      expect(stored(up.state, "progression.experience.total")).toBe(23);
      expect(written(up.actor)).toMatchObject({
        "sheet.experienceCurrent": 15,
      });

      const down = sheetPc({}, {}, withLine(8, 20));
      await apply(
        sheetReq({ experienceCurrent: 0 }, { experienceCurrent: 12 }),
      );
      expect(stored(down.state, "progression.experience.total")).toBe(8);
      expect(prepared(down.actor, "progression.experience.actuel")).toBe(0);
    });

    it("refuses base_conflict when Foundry moved it first", async () => {
      const { actor } = sheetPc({}, {}, withLine(8, 20));
      expect(
        await rpcCode(
          apply(sheetReq({ experienceCurrent: 15 }, { experienceCurrent: 10 })),
        ),
      ).toBe("base_conflict");
      expect(actor.updates).toHaveLength(0);
    });

    it("undoes a total that would go below zero", async () => {
      // A refund line: unspent 8 on a total of 3.
      const { actor, state } = sheetPc({}, {}, withLine(-5, 3));
      expect(prepared(actor, "progression.experience.actuel")).toBe(8);
      const result = await apply(
        sheetReq({ experienceCurrent: 0 }, { experienceCurrent: 8 }),
      );
      expect(result.warnings).toEqual(["stat_clamped:experienceCurrent"]);
      expect(stored(state, "progression.experience.total")).toBe(3);
      expect(written(actor)).not.toHaveProperty(["sheet.experienceCurrent"]);
    });
  });

  it("writes Glory total and the three texts as is, with the meters in one update", async () => {
    const { actor, state } = sheetPc();
    const sheet = {
      gloryTotal: 37,
      age: "31",
      nickname: "Ace",
      majorMotivation: "Find her",
    };
    await apply(
      sheetReq(
        sheet,
        { gloryTotal: 0, age: "", nickname: "", majorMotivation: "" },
        { resources: { health: 12 }, name: "Renamed" },
      ),
    );
    expect(actor.updates).toHaveLength(1);
    expect(actor.updates[0]).toMatchObject({
      name: "Renamed",
      "system.sante.value": 12,
      "system.progression.gloire.total": 37,
      "system.age": "31",
      "system.surnom": "Ace",
      "system.motivations.majeure": "Find her",
    });
    expect(state.source).toMatchObject({
      age: "31",
      surnom: "Ace",
      motivations: { majeure: "Find her" },
      progression: { gloire: { total: 37 } },
    });
    expect(written(actor)).toMatchObject({
      "sheet.gloryTotal": 37,
      "sheet.age": "31",
      "sheet.nickname": "Ace",
      "sheet.majorMotivation": "Find her",
    });
    const flag = (actor.flags[MODULE_ID] as Record<string, any>)
      .actorResourcesV1;
    expect(flag.contentDigest).toBe(
      await canonicalDigest({
        resources: { health: 12 },
        name: "Renamed",
        sheet,
      }),
    );
  });

  it("refuses base_conflict when Foundry changed a text first", async () => {
    const { actor } = sheetPc({}, {}, (s) => {
      s.surnom = "Ghost";
    });
    expect(
      await rpcCode(apply(sheetReq({ nickname: "Ace" }, { nickname: "" }))),
    ).toBe("base_conflict");
    expect(actor.updates).toHaveLength(0);
  });

  it("answers procedure_failed when Foundry drops the update, and the next sequence applies", async () => {
    const { actor, state } = sheetPc({ chair: 4 });
    state.refuse = true;
    const req = sheetReq(
      { aspects: { chair: 5 } },
      { aspects: { chair: 4 } },
      { resources: { health: 12 } },
    );
    expect(await rpcCode(apply(req))).toBe("procedure_failed");
    expect(stored(state, "aspects.chair.base")).toBe(4);
    expect(actor.flags[MODULE_ID]).not.toHaveProperty("actorResourcesV1");
    state.refuse = false;
    await apply({ ...req, sequence: 8 });
    expect(stored(state, "aspects.chair.base")).toBe(5);
    expect(stored(state, "sante.value")).toBe(12);
  });

  it("answers procedure_failed when Foundry drops the undo", async () => {
    const { actor, state } = sheetPc({ chair: 7 }, {}, (s) => {
      s.aspects.chair.max = 7;
    });
    const update = actor.update;
    actor.update = async (changes) => {
      if (actor.updates.length > 0) state.refuse = true;
      return update(changes);
    };
    expect(
      await rpcCode(
        apply(sheetReq({ aspects: { chair: 8 } }, { aspects: { chair: 7 } })),
      ),
    ).toBe("procedure_failed");
  });

  describe("unspent Glory", () => {
    const AUTRE = "progression.gloire.depense.autre";
    const line = (order: string, nom: string, cout: number | string) => ({
      order,
      nom,
      cout,
      gratuit: false,
    });

    /** A PC with `total` Glory, the « other expense » lines `autre` and
     * `itemsSpent` Glory spent on Items. */
    function gloryPc(
      total: number,
      autre: Record<string, unknown> = {},
      itemsSpent?: number,
    ) {
      const pc = sheetPc({}, {}, (s) => {
        s.progression.gloire = { total, depense: { autre } };
      });
      pc.state.itemsSpent = itemsSpent;
      reprepare(pc.actor, pc.state);
      return pc;
    }
    const glory = (
      n: number,
      e: number,
      overrides: Record<string, unknown> = {},
    ) => sheetReq({ gloryCurrent: n }, { gloryCurrent: e }, overrides);
    const flag = (actor: FakeActor) =>
      (actor.flags[MODULE_ID] as Record<string, any>).actorResourcesV1;
    const actuel = (actor: FakeActor) =>
      prepared(actor, "progression.gloire.actuel");

    it("spends on a new « Table Companion » line after the highest key, the total untouched", async () => {
      const { actor, state } = gloryPc(200, {
        "1": line("1", "Potion", 0),
        "4": line("3", "Gift", "0"),
      });
      expect(actuel(actor)).toBe(200);
      const req = glory(190, 200);
      const result = await apply(req);
      expect(result.warnings).toEqual([]);
      expect(actor.updates).toHaveLength(1);
      expect(stored(state, `${AUTRE}.5`)).toEqual(
        line("4", "Table Companion", 10),
      );
      expect(stored(state, "progression.gloire.total")).toBe(200);
      expect(actuel(actor)).toBe(190);
      expect(flag(actor).gloryLineId).toBe("5");
      expect(written(actor)).toMatchObject({ "sheet.gloryCurrent": 190 });
      expect(flag(actor).contentDigest).toBe(
        await canonicalDigest({ resources: {}, sheet: { gloryCurrent: 190 } }),
      );
      // A replay of the same request answers the stored result.
      expect(await apply(req)).toEqual(result);
      expect(actor.updates).toHaveLength(1);
    });

    it("reuses its line for the next spend, a refund, and a refund below zero", async () => {
      const { actor, state } = gloryPc(200);
      await apply(glory(190, 200));
      expect(stored(state, `${AUTRE}.1`)).toEqual(
        line("1", "Table Companion", 10),
      );
      await apply(glory(175, 190, { sequence: 8 }));
      expect(Object.keys(stored(state, AUTRE) as object)).toEqual(["1"]);
      expect(stored(state, `${AUTRE}.1.cout`)).toBe(25);
      await apply(glory(185, 175, { sequence: 9 }));
      expect(stored(state, `${AUTRE}.1.cout`)).toBe(15);
      await apply(glory(210, 185, { sequence: 10 }));
      expect(stored(state, `${AUTRE}.1.cout`)).toBe(-10);
      expect(actuel(actor)).toBe(210);
      expect(stored(state, "progression.gloire.total")).toBe(200);
    });

    it("takes the requested total into the difference when both ride together", async () => {
      const { actor, state } = gloryPc(200);
      await apply(
        sheetReq(
          { gloryTotal: 250, gloryCurrent: 230 },
          { gloryTotal: 200, gloryCurrent: 200 },
        ),
      );
      expect(stored(state, "progression.gloire.total")).toBe(250);
      expect(stored(state, `${AUTRE}.1.cout`)).toBe(20);
      expect(actuel(actor)).toBe(230);
    });

    it("never counts the Glory spent on Items twice", async () => {
      const { actor, state } = gloryPc(340, {}, 140);
      expect(actuel(actor)).toBe(200);
      await apply(glory(180, 200));
      // The Items' entry is Knight's order 1: the lane's line comes next.
      expect(stored(state, `${AUTRE}.1`)).toEqual(
        line("2", "Table Companion", 20),
      );
      expect(actuel(actor)).toBe(180);
    });

    it("creates a new line when the Gamemaster deleted its own, and the flag follows", async () => {
      const { actor, state } = gloryPc(200, { "4": line("1", "Gift", 0) });
      await apply(glory(190, 200));
      expect(flag(actor).gloryLineId).toBe("5");
      // In Foundry: the lane's line deleted, another added by Knight's « + ».
      delete state.source.progression.gloire.depense.autre["5"];
      state.source.progression.gloire.depense.autre["6"] = line("2", "", "0");
      reprepare(actor, state);
      expect(actuel(actor)).toBe(200);
      await apply(glory(180, 200, { sequence: 8 }));
      expect(stored(state, `${AUTRE}.7`)).toEqual(
        line("3", "Table Companion", 20),
      );
      expect(stored(state, `${AUTRE}.6`)).toEqual(line("2", "", "0"));
      expect(flag(actor).gloryLineId).toBe("7");
      expect(actuel(actor)).toBe(180);
    });

    it("finds a renamed line by its id and keeps the Gamemaster's name", async () => {
      const { actor, state } = gloryPc(200);
      await apply(glory(190, 200));
      state.source.progression.gloire.depense.autre["1"].nom = "Renamed";
      reprepare(actor, state);
      await apply(glory(185, 190, { sequence: 8 }));
      expect(stored(state, `${AUTRE}.1`)).toEqual(line("1", "Renamed", 15));
      expect(Object.keys(stored(state, AUTRE) as object)).toEqual(["1"]);
    });

    it("adds to a cost Knight stored as a string", async () => {
      const { actor, state } = gloryPc(100, { "2": line("1", "Ours", "5") });
      (actor.flags[MODULE_ID] as Record<string, unknown>).actorResourcesV1 = {
        schemaVersion: 1,
        resultDocId: ACTOR_ID,
        outcome: "updated",
        appliedRevision: 1,
        appliedDigest: "0".repeat(64),
        warnings: [],
        gloryLineId: "2",
      };
      expect(actuel(actor)).toBe(95);
      await apply(glory(90, 95));
      expect(stored(state, `${AUTRE}.2.cout`)).toBe(10);
      expect(Object.keys(stored(state, AUTRE) as object)).toEqual(["2"]);
    });

    it("ignores keys that are not numbers when choosing a new one", async () => {
      const { state } = gloryPc(100, {
        abc: line("1", "Odd", 0),
        "2": line("2", "Gift", 0),
      });
      await apply(glory(90, 100));
      expect(stored(state, `${AUTRE}.3`)).toEqual(
        line("3", "Table Companion", 10),
      );
    });

    it("refuses base_conflict when Foundry moved it first, and writes none of the row", async () => {
      const { actor, state } = gloryPc(200);
      expect(
        await rpcCode(
          apply(
            sheetReq(
              { gloryCurrent: 190, nickname: "Ace" },
              { gloryCurrent: 210, nickname: "" },
              { resources: { health: 12 } },
            ),
          ),
        ),
      ).toBe("base_conflict");
      expect(actor.updates).toHaveLength(0);
      expect(stored(state, AUTRE)).toEqual({});
      expect(stored(state, "sante.value")).toBe(1);
    });

    it("accepts a base read before its own last write, and counts from the current value", async () => {
      const { actor, state } = gloryPc(200);
      await apply(glory(190, 200));
      // Built on the read before sequence 7 landed (200); Foundry holds 190.
      await apply(glory(180, 200, { sequence: 8 }));
      expect(stored(state, `${AUTRE}.1.cout`)).toBe(20);
      expect(actuel(actor)).toBe(180);
    });

    it("skips a prepared unspent Glory that is not a number", async () => {
      const { actor, state } = gloryPc(200);
      state.after = (s) =>
        Object.defineProperty(s.progression.gloire, "actuel", {
          value: Number.NaN,
        });
      reprepare(actor, state);
      const result = await apply(glory(190, 200));
      expect(result.warnings).toEqual(["stat_unavailable:gloryCurrent"]);
      expect(stored(state, AUTRE)).toEqual({});
      expect(written(actor)).not.toHaveProperty(["sheet.gloryCurrent"]);
    });

    it("deletes the line it created when Foundry does not prepare the target", async () => {
      const { actor, state } = gloryPc(200);
      state.ignoredLines = ["1"];
      const req = glory(190, 200);
      const result = await apply(req);
      expect(result.warnings).toEqual(["stat_clamped:gloryCurrent"]);
      expect(actor.updates).toHaveLength(2);
      expect(stored(state, AUTRE)).toEqual({});
      expect(flag(actor).warnings).toEqual(["stat_clamped:gloryCurrent"]);
      expect(flag(actor)).not.toHaveProperty("gloryLineId");
      expect(written(actor)).not.toHaveProperty(["sheet.gloryCurrent"]);
      expect(await apply(req)).toEqual(result);
    });

    it("puts its own line's cost back, as Knight stored it, when Foundry does not prepare the target", async () => {
      const { actor, state } = gloryPc(100, { "2": line("1", "Ours", "5") });
      (actor.flags[MODULE_ID] as Record<string, unknown>).actorResourcesV1 = {
        schemaVersion: 1,
        resultDocId: ACTOR_ID,
        outcome: "updated",
        appliedRevision: 1,
        appliedDigest: "0".repeat(64),
        warnings: [],
        gloryLineId: "2",
      };
      state.ignoredLines = ["2"];
      reprepare(actor, state);
      expect(actuel(actor)).toBe(100);
      const result = await apply(glory(90, 100));
      expect(result.warnings).toEqual(["stat_clamped:gloryCurrent"]);
      expect(stored(state, `${AUTRE}.2`)).toEqual(line("1", "Ours", "5"));
      expect(flag(actor).gloryLineId).toBe("2");
    });

    it("brings an overspent PC back to zero", async () => {
      const { actor, state } = gloryPc(10, { "1": line("1", "Debt", 28) });
      expect(actuel(actor)).toBe(-18);
      await apply(glory(0, -18));
      expect(stored(state, `${AUTRE}.2`)).toEqual(
        line("2", "Table Companion", -18),
      );
      expect(actuel(actor)).toBe(0);
    });

    it("writes nothing for a difference of zero", async () => {
      const { actor, state } = gloryPc(200);
      await apply(glory(200, 200, { resources: { health: 12 } }));
      expect(stored(state, AUTRE)).toEqual({});
      expect(written(actor)).toMatchObject({ "sheet.gloryCurrent": 200 });
      expect(flag(actor)).not.toHaveProperty("gloryLineId");
    });
  });
});
