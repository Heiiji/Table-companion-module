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
  stubFoundry,
  type FakeActor,
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
  const actor = fakeActor(id);
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
  ])("refuses %s", (_name, overrides) => {
    expect(() =>
      validateKnightActorResourcesV1({ ...request(), ...overrides }),
    ).toThrow(RpcError);
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
      [`flags.${MODULE_ID}.actorResourcesV1`]: result,
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

  it("accepts the captured Knight actor shape", async () => {
    for (const fixture of KNIGHT_SCHEMA_FIXTURES) {
      const actor = boundActor();
      actor.system = structuredClone(fixture.actor.system);
      stubFoundry([actor], undefined, fixture.foundryGeneration);
      const result = await apply(
        request({
          resources: { health: 1, hope: 1, armour: 1, energy: 1, contact: 1 },
        }),
      );
      expect(result.warnings).toEqual([]);
    }
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
    const next = await apply(request({ sequence: 8 }));
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

    stubFoundry([actor], undefined, 13, undefined, "3.58.36");
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
