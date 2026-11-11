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
