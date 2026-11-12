import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorUpsertV1,
  type ActorUpsertResultV1,
} from "../src/procedures/actorUpsert.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import { ownershipReplacement } from "../src/procedures/upsertShared.js";
import {
  AUTHORED_PATHS,
  authoredPatch,
} from "../src/procedures/actorUpsert.patch.js";
import {
  ACTOR_ID,
  ForcedReplacement,
  KNIGHT_SCHEMA_FIXTURES,
  USER_ID,
  approved,
  binding,
  fakeActor,
  hasFixturePath,
  pairCompanion,
  stubOperators,
  stubFoundry,
  wearingArmour,
  type FakeActor,
} from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

describe("actor.upsert.v1", () => {
  // The 3.58.33 fixtures stand in for every admitted version: the later ones
  // change only data preparation code, outside the written and read paths.
  for (const knightVersion of ["3.58.33", "3.58.35", "3.58.37"])
    for (const fixture of KNIGHT_SCHEMA_FIXTURES) {
      it(`maps only schema-backed Knight fields under Knight ${knightVersion} on Foundry ${fixture.foundryGeneration}`, async () => {
        expect(fixture.knightSystemVersion).toBe("3.58.33");
        expect(fixture.actorCreateAPI).toBe("Actor.implementation.create");
        const actor = wearingArmour(fakeActor());
        // The capture omits `wear`: this PC is in its armour.
        actor.system = {
          ...structuredClone(fixture.actor.system),
          wear: "armure",
        };
        stubFoundry(
          [actor],
          undefined,
          fixture.foundryGeneration,
          undefined,
          knightVersion,
        );

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
        // The three motivations are created in one request.
        expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
        const motivationCreates = actor.createEmbeddedDocuments.mock
          .calls[0]![1] as Record<string, unknown>[];
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
      createdActor = wearingArmour(fakeActor());
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
    expect(createdActor!.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(
      (
        createdActor!.createEmbeddedDocuments.mock.calls[0]![1] as Record<
          string,
          unknown
        >[]
      ).map((source) => source.type),
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

  it("creates without resources and then writes no current resource", async () => {
    const actors: FakeActor[] = [];
    const created = fakeActor();
    stubFoundry(
      actors,
      vi.fn(async () => (actors.push(created), created)),
    );

    const result = (await actorUpsertV1(
      approved({ resources: undefined, equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;

    expect(result.outcome).toBe("created");
    expect(result.warnings).toEqual([]);
    const keys = created.updates.flatMap((update) => Object.keys(update));
    expect(keys).toContain("system.aspects.chair.base");
    for (const path of [
      "system.sante.value",
      "system.espoir.value",
      "system.contacts.actuel",
      "system.equipements.armure.armure.value",
      "system.equipements.armure.energie.value",
    ])
      expect(keys).not.toContain(path);
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
    stubFoundry([], undefined, 12);
    await expect(actorUpsertV1(approved(), {} as never)).rejects.toMatchObject({
      code: "unsupported_runtime",
    });

    // A newer Foundry generation is not refused for being newer.
    vi.unstubAllGlobals();
    stubFoundry([], undefined, 15);
    await expect(actorUpsertV1(approved(), {} as never)).resolves.toMatchObject(
      {
        schemaVersion: 1,
      },
    );

    // The last Knight release below the floor, and version strings that only
    // look like an admitted one.
    for (const version of [
      "3.58.32",
      "3.57.99",
      "v3.58.36",
      "3.58.3",
      "4.0.0",
    ]) {
      vi.unstubAllGlobals();
      stubFoundry([], undefined, 14, undefined, version);
      await expect(
        actorUpsertV1(approved(), {} as never),
        version,
      ).rejects.toMatchObject({
        code: "unsupported_runtime",
        message:
          "actor.upsert.v1 requires Knight 3.58.33 or a later 3.x on Foundry 13 or later",
      });
    }
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

  it("writes armour and energy on the gear the Actor wears", async () => {
    const actor = fakeActor();
    actor.system.wear = "guardian";
    (actor.system.equipements as Record<string, unknown>).guardian = {
      armure: { value: 5 },
    };
    stubFoundry([actor]);
    const result = (await actorUpsertV1(
      approved({ assignedActorId: actor.id, equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;
    const keys = actor.updates.flatMap((update) => Object.keys(update));
    expect(keys).toContain("system.equipements.guardian.armure.value");
    expect(keys).not.toContain("system.equipements.armure.armure.value");
    expect(keys).not.toContain("system.equipements.armure.energie.value");
    expect(result.warnings).toContain("resource_unavailable:energy");
  });

  it("writes armour and energy on the armour Foundry wears, not on a stale wear", async () => {
    const upsertOn = async (generation: number | undefined, wear?: string) => {
      const actor = fakeActor();
      if (wear === undefined) delete actor.system.wear;
      else actor.system.wear = wear;
      (actor.system.equipements as Record<string, unknown>).tenueCivile = {
        armure: { value: 0 },
        energie: { value: 0 },
      };
      if (generation !== undefined)
        actor.items.contents = [
          ...actor.items.contents,
          { type: "armure", system: { generation } },
        ];
      stubFoundry([actor]);
      await actorUpsertV1(
        approved({ assignedActorId: actor.id, equipment: undefined }),
        {} as never,
      );
      return actor.updates
        .flatMap((update) => Object.keys(update))
        .filter((key) =>
          /^system\.equipements\.\w+\.(armure|energie)\./.test(key),
        );
    };
    expect(await upsertOn(4, "tenueCivile")).toEqual([
      "system.equipements.armure.armure.value",
      "system.equipements.armure.energie.value",
    ]);
    expect(await upsertOn(3, "tenueCivile")).toEqual([
      "system.equipements.tenueCivile.armure.value",
      "system.equipements.tenueCivile.energie.value",
    ]);
    expect(await upsertOn(undefined, undefined)).toEqual([
      "system.equipements.tenueCivile.armure.value",
      "system.equipements.tenueCivile.energie.value",
    ]);
  });

  it("writes armour and energy on the civilian gear when no armour Item backs an armour wear", async () => {
    for (const [wear, armoured, gear] of [
      ["armure", false, "tenueCivile"],
      ["ascension", false, "tenueCivile"],
      ["armure", true, "armure"],
      ["ascension", true, "ascension"],
    ] as const) {
      const actor = fakeActor();
      actor.system.wear = wear;
      if (armoured) wearingArmour(actor);
      for (const subtree of ["armure", "ascension", "tenueCivile"])
        (actor.system.equipements as Record<string, unknown>)[subtree] = {
          armure: { value: 0 },
          energie: { value: 0 },
        };
      stubFoundry([actor]);
      await actorUpsertV1(
        approved({ assignedActorId: actor.id, equipment: undefined }),
        {} as never,
      );
      const written = actor.updates
        .flatMap((update) => Object.keys(update))
        .filter((key) =>
          /^system\.equipements\.\w+\.(armure|energie)\./.test(key),
        );
      expect(written, `${wear} armoured=${armoured}`).toEqual([
        `system.equipements.${gear}.armure.value`,
        `system.equipements.${gear}.energie.value`,
      ]);
    }
  });

  it("clamps a current over the prepared maximum and warns", async () => {
    const actor = wearingArmour(fakeActor());
    Object.assign(actor.system, {
      armure: { max: 10 },
      energie: { max: Number.NaN },
    });
    (actor.system.sante as Record<string, unknown>).max = 30;
    stubFoundry([actor]);
    const result = (await actorUpsertV1(
      approved({
        assignedActorId: actor.id,
        equipment: undefined,
        resources: { health: 40, hope: 10, armour: 25, energy: 15, contact: 2 },
      }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.warnings).toEqual([
      "resource_clamped:health",
      "resource_clamped:armour",
    ]);
    expect(actor.system).toMatchObject({
      sante: { value: 30 },
      espoir: { value: 10 },
      contacts: { actuel: 2 },
      equipements: {
        armure: { armure: { value: 10 }, energie: { value: 15 } },
      },
    });
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

  it("converges on a retry after a failure between two embedded writes", async () => {
    const armour = {
      _id: "22826f541c384281",
      name: "Fixture armour",
      type: "armure",
      system: {},
      flags: {},
    };
    const compendium = {
      documents: {
        "knight-compendium.armours-base": { [armour._id]: armour },
      },
    };
    const equipment = {
      selections: [{ catalogId: "knight.armour.warrior", quantity: 1 }],
    };
    const itemsOf = (actor: FakeActor) =>
      actor.items.contents.map((item) => [item.type, item.name]);

    const clean = fakeActor();
    stubFoundry([clean], undefined, 14, compendium);
    const expected = (await actorUpsertV1(
      approved({ assignedActorId: clean.id, equipment }),
      {} as never,
    )) as ActorUpsertResultV1;

    const actor = fakeActor();
    stubFoundry([actor], undefined, 14, compendium);
    type Create = (
      type: string,
      data: Record<string, unknown>[],
    ) => Promise<unknown>;
    const create =
      actor.createEmbeddedDocuments.getMockImplementation() as Create;
    let failed = false;
    actor.createEmbeddedDocuments = vi.fn<Create>(async (type, data) => {
      // The motivations land, then the first equipment write fails.
      if (!failed && data[0]?.type !== "motivationMineure") {
        failed = true;
        throw new Error("connection lost");
      }
      return create(type, data);
    });
    const req = approved({ assignedActorId: actor.id, equipment });
    await expect(actorUpsertV1(req, {} as never)).rejects.toThrow(
      "connection lost",
    );
    expect(
      actor.items.contents.filter((i) => i.type === "motivationMineure"),
    ).toHaveLength(3);

    const retried = (await actorUpsertV1(
      req,
      {} as never,
    )) as ActorUpsertResultV1;
    // The failed attempt already bound the Actor: the retry finds it bound.
    expect(retried).toEqual({ ...expected, outcome: "updated" });
    expect(itemsOf(actor)).toEqual(itemsOf(clean));
    expect(actor.system).toEqual(clean.system);
  });

  it("removes a hand-made OWNER grant when no Foundry user is assigned", async () => {
    const COMPANION = "companion0000001";
    const actor = fakeActor();
    const req = approved({
      approvedRevision: 2,
      foundryUserId: undefined,
      equipment: undefined,
    });
    binding(actor, req);
    // The GM gave the player the sheet by hand in Foundry.
    actor.ownership = { default: 0, [USER_ID]: 3, [COMPANION]: 2 };
    stubFoundry([actor]);
    pairCompanion(COMPANION);
    const result = (await actorUpsertV1(
      req,
      {} as never,
    )) as ActorUpsertResultV1;
    expect(actor.ownership).toEqual({ default: 0, [COMPANION]: 2 });
    expect(actor.updates[0]?.ownership).toHaveProperty(`-=${USER_ID}`, null);
    expect(result.warnings).toContain("assign_foundry_user");
  });

  it("leaves a HOSTILE token disposition unchanged", async () => {
    const actor = fakeActor() as FakeActor & {
      prototypeToken: { disposition: number };
    };
    actor.prototypeToken = { disposition: -1 }; // CONST.TOKEN_DISPOSITIONS.HOSTILE
    stubFoundry([actor]);
    await actorUpsertV1(
      approved({ assignedActorId: actor.id, equipment: undefined }),
      {} as never,
    );
    const keys = actor.updates.flatMap((update) => Object.keys(update));
    expect(keys.some((key) => key.startsWith("prototypeToken"))).toBe(false);
    expect(actor.prototypeToken).toEqual({ disposition: -1 });
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

  describe("the Companion user's access", () => {
    const COMPANION = "companion0000001";

    it("is granted Observer when the lane creates the character", async () => {
      const create = vi.fn(async (_data: Record<string, unknown>) =>
        fakeActor(),
      );
      stubFoundry([], create);
      pairCompanion(COMPANION);
      await actorUpsertV1(approved({ equipment: undefined }), {} as never);
      expect(create.mock.calls[0][0].ownership).toEqual({
        default: 0,
        [USER_ID]: 3,
        [COMPANION]: 2,
      });
    });

    it.each([
      ["kept at Observer after Share", 2, 2],
      ["kept above Observer", 3, 3],
      ["raised to Observer from Limited", 1, 2],
      ["added when missing", undefined, 2],
    ])(
      "is %s on a later revision, and no other grant survives",
      async (_label, before, after) => {
        const actor = fakeActor();
        const req = approved({ approvedRevision: 2, equipment: undefined });
        binding(actor, req);
        actor.ownership = { default: 2, [USER_ID]: 3, stalePlayer: 3 };
        if (before !== undefined) actor.ownership[COMPANION] = before;
        stubFoundry([actor]);
        pairCompanion(COMPANION);

        await actorUpsertV1(req, {} as never);

        expect(actor.ownership).toEqual({
          default: 0,
          [USER_ID]: 3,
          [COMPANION]: after,
        });
        const patch = actor.updates[0]?.ownership as Record<string, unknown>;
        expect(patch).not.toHaveProperty(`-=${COMPANION}`);
        expect(patch).toHaveProperty("-=stalePlayer", null);
      },
    );

    it("never demotes a player who is also the paired user", async () => {
      const create = vi.fn(async (_data: Record<string, unknown>) =>
        fakeActor(),
      );
      stubFoundry([], create);
      pairCompanion(USER_ID);
      await actorUpsertV1(approved({ equipment: undefined }), {} as never);
      expect(create.mock.calls[0][0].ownership).toEqual({
        default: 0,
        [USER_ID]: 3,
      });
    });
  });
});

describe("ownership replacement", () => {
  const actor = { ownership: { default: 2, stale: 3 }, update: vi.fn() };

  it("uses Foundry 14's ForcedReplacement operator when the runtime has it", () => {
    stubOperators();
    const update = ownershipReplacement(actor, { default: 0, [USER_ID]: 3 });
    expect(update).toBeInstanceOf(ForcedReplacement);
    expect((update as ForcedReplacement).value).toEqual({
      default: 0,
      [USER_ID]: 3,
    });
  });

  it("falls back to the -=key syntax without it", () => {
    vi.stubGlobal("foundry", { data: {} });
    expect(ownershipReplacement(actor, { default: 0 })).toEqual({
      default: 0,
      "-=stale": null,
    });
  });
});

describe("actor.upsert.v1 base.name (compare-and-set)", () => {
  const draft = (overrides = {}) =>
    approved({ state: "draft", approvedRevision: 0, ...overrides });
  function boundActor(req = draft()): FakeActor {
    const actor = fakeActor();
    binding(actor, req);
    stubFoundry([actor]);
    return actor;
  }

  it("renames when Foundry still holds the base name", async () => {
    const actor = boundActor();
    await actorUpsertV1(draft({ base: { name: "Existing" } }), {} as never);
    expect(actor.name).toBe("Lancelot");
  });

  it("refuses with base_conflict and writes nothing when Foundry renamed first", async () => {
    const actor = boundActor();
    actor.name = "Renamed in Foundry";
    const error = await Promise.resolve(
      actorUpsertV1(draft({ base: { name: "Existing" } }), {} as never),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("base_conflict");
    expect(actor.updates).toHaveLength(0);
    expect(actor.name).toBe("Renamed in Foundry");
  });

  it("does not compare when Foundry already holds the requested name, nor on create", async () => {
    const actor = boundActor();
    actor.name = "Lancelot";
    await actorUpsertV1(draft({ base: { name: "Existing" } }), {} as never);
    expect(actor.updates.length).toBeGreaterThan(0);
    const created = vi.fn(async (_data: Record<string, unknown>) =>
      fakeActor(),
    );
    stubFoundry([], created);
    await actorUpsertV1(draft({ base: { name: "Elsewhere" } }), {} as never);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("without a base renames over a Foundry rename, as before", async () => {
    const actor = boundActor();
    actor.name = "Renamed in Foundry";
    await actorUpsertV1(draft(), {} as never);
    expect(actor.name).toBe("Lancelot");
  });

  it("accepts a base read before the app's own previous rename landed, not a later Foundry rename", async () => {
    const rev = (approvedRevision: number, name: string) =>
      approved({
        approvedRevision,
        name,
        equipment: undefined,
        base: { name: "Existing" },
      });
    const actor = boundActor(rev(1, "Lancelot"));
    await actorUpsertV1(rev(1, "Lancelot"), {} as never);
    await actorUpsertV1(rev(2, "Percival"), {} as never);
    expect(actor.name).toBe("Percival");
    actor.name = "Renamed in Foundry";
    await expect(
      actorUpsertV1(rev(3, "Galahad"), {} as never),
    ).rejects.toMatchObject({ code: "base_conflict" });
    expect(actor.name).toBe("Renamed in Foundry");
  });
});

describe("actor.upsert.v1 revisions", () => {
  async function appliedAt(revision: number): Promise<FakeActor> {
    const actor = fakeActor();
    const req = approved({ approvedRevision: revision });
    binding(actor, req);
    stubFoundry([actor]);
    await actorUpsertV1(req, {} as never);
    return actor;
  }

  const refusal = (payload: unknown): Promise<unknown> =>
    Promise.resolve(actorUpsertV1(payload as never, {} as never)).catch(
      (e: unknown) => e,
    );

  it("refuses an older approved revision with stale_revision and writes nothing", async () => {
    const actor = await appliedAt(2);
    const writes = actor.updates.length;
    const error = await refusal(approved({ approvedRevision: 1 }));
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("stale_revision");
    expect(actor.updates).toHaveLength(writes);
  });

  it("refuses the same revision with other content with revision_conflict", async () => {
    const actor = await appliedAt(2);
    const writes = actor.updates.length;
    const error = await refusal(
      approved({ approvedRevision: 2, name: "Perceval" }),
    );
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("revision_conflict");
    expect(actor.updates).toHaveLength(writes);
    expect(actor.name).toBe("Lancelot");
  });

  it("replays the same revision and content without writing", async () => {
    const actor = await appliedAt(2);
    const writes = actor.updates.length;
    const result = (await actorUpsertV1(
      approved({ approvedRevision: 2 }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.appliedRevision).toBe(2);
    expect(actor.updates).toHaveLength(writes);
  });
});

describe("actor.upsert.v1 keeps what the Gamemaster changed in Foundry", () => {
  const CHAIR = "system.aspects.chair.base";
  const draft = () => approved({ state: "draft", approvedRevision: 0 });

  /** A world where the draft creates a Knight-shaped Actor (the fixture's
   * defaults), as Foundry would. */
  function world(): FakeActor[] {
    const actors: FakeActor[] = [];
    stubFoundry(
      actors,
      vi.fn(async () => {
        const actor = fakeActor();
        actor.system = structuredClone(KNIGHT_SCHEMA_FIXTURES[1].actor.system);
        actors.push(actor);
        return actor;
      }),
    );
    return actors;
  }

  const upsert = async (req: unknown) =>
    (await actorUpsertV1(req as never, {} as never)) as ActorUpsertResultV1;
  const written = (actor: FakeActor) =>
    actor.updates.flatMap((update) => Object.keys(update));
  const flagOf = (actor: FakeActor) =>
    (actor.flags[MODULE_ID] as Record<string, any>).actorUpsertV1;

  it("names exactly the paths an approved patch writes", () => {
    const req = approved();
    const keys = Object.keys(
      authoredPatch(fakeActor() as never, req, {
        schemaVersion: 1,
        worldId: req.worldId,
        tableId: req.tableId,
        characterId: req.characterId,
      }),
    ).filter((key) => key.startsWith("system."));
    expect([...AUTHORED_PATHS].sort()).toEqual(keys.sort());
  });

  it("records what Foundry holds after the draft", async () => {
    const actors = world();
    await upsert(draft());
    expect(flagOf(actors[0]).written.fields[CHAIR]).toBe(0);
    expect(flagOf(actors[0]).written.fields["system.description"]).toBe("");
  });

  it("keeps a field the Gamemaster moved since the draft and writes the rest", async () => {
    const actors = world();
    await upsert(draft());
    const actor = actors[0];
    (actor.system.aspects as any).chair.base = 9;
    const before = actor.updates.length;
    const result = await upsert(approved({ equipment: undefined }));
    expect(result.outcome).toBe("updated");
    expect(result.warnings).toContain("foundry_kept:1");
    expect((actor.system.aspects as any).chair.base).toBe(9);
    const now = actor.updates.slice(before).flatMap((u) => Object.keys(u));
    expect(now).not.toContain(CHAIR);
    expect(now).toContain("system.aspects.bete.base");
    expect(now).toContain("system.description");
    expect((actor.system.aspects as any).bete.base).toBe(2);
    // A replay of the same revision answers the stored result, unwritten.
    const writes = actor.updates.length;
    expect(await upsert(approved({ equipment: undefined }))).toEqual(result);
    expect(actor.updates).toHaveLength(writes);
  });

  it("still keeps that field at the next approved revision", async () => {
    const actors = world();
    await upsert(draft());
    const actor = actors[0];
    (actor.system.aspects as any).chair.base = 9;
    await upsert(approved({ equipment: undefined }));
    const later = await upsert(
      approved({ approvedRevision: 2, equipment: undefined, name: "Perceval" }),
    );
    expect(later.outcome).toBe("updated");
    expect(later.warnings).toContain("foundry_kept:1");
    expect((actor.system.aspects as any).chair.base).toBe(9);
  });

  it("writes everything when nothing moved", async () => {
    const actors = world();
    await upsert(draft());
    const result = await upsert(approved({ equipment: undefined }));
    expect(result.warnings.some((w) => w.startsWith("foundry_kept"))).toBe(
      false,
    );
    expect(written(actors[0])).toContain(CHAIR);
    expect((actors[0].system.aspects as any).chair.base).toBe(3);
  });

  it("writes everything over an Actor drafted without the record", async () => {
    const actors = world();
    await upsert(draft());
    delete flagOf(actors[0]).written.fields;
    (actors[0].system.aspects as any).chair.base = 9;
    const result = await upsert(approved({ equipment: undefined }));
    expect(result.warnings.some((w) => w.startsWith("foundry_kept"))).toBe(
      false,
    );
    expect((actors[0].system.aspects as any).chair.base).toBe(3);
  });

  it("never keeps on create: the approved pass writes everything", async () => {
    const actors = world();
    const result = await upsert(approved({ equipment: undefined }));
    expect(result.outcome).toBe("created");
    expect(result.warnings.some((w) => w.startsWith("foundry_kept"))).toBe(
      false,
    );
    expect((actors[0].system.aspects as any).chair.base).toBe(3);
  });
});

describe("actor.upsert.v1 on Foundry 14", () => {
  const COMPANION = "companion0000001";

  // Foundry adds the creating Gamemaster as OWNER, so the authored update
  // must replace a map holding a grant the lane removes.
  function gmCreating(actors: FakeActor[]) {
    const create = vi.fn(async (data: Record<string, unknown>) => {
      const actor = fakeActor();
      actor.ownership = { ...(data.ownership as object), gm: 3 };
      actors.push(actor);
      return actor;
    });
    stubFoundry(actors, create, 14);
    stubOperators();
    pairCompanion(COMPANION);
    return create;
  }

  it("creates with the authored values written and exactly the lane's ownership", async () => {
    const actors: FakeActor[] = [];
    gmCreating(actors);
    const result = (await actorUpsertV1(
      approved({ equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.outcome).toBe("created");
    const actor = actors[0];
    expect(actor.name).toBe("Lancelot");
    expect(actor.system.origin).toBe("Europe");
    expect((actor.system.aspects as any).machine.base).toBe(4);
    expect(actor.ownership).toEqual({
      default: 0,
      [USER_ID]: 3,
      [COMPANION]: 2,
    });
  });

  it("answers procedure_failed when Foundry drops the authored update", async () => {
    const actors: FakeActor[] = [];
    const create = gmCreating(actors);
    const made = create.getMockImplementation()!;
    create.mockImplementation(async (data: Record<string, unknown>) => {
      const actor = await made(data);
      actor.update = async (changes) => {
        actor.updates.push(changes);
      };
      return actor;
    });
    await expect(
      actorUpsertV1(approved({ equipment: undefined }), {} as never),
    ).rejects.toMatchObject({ code: "procedure_failed" });
  });

  it("creates the character with a linked prototype token", async () => {
    const actors: FakeActor[] = [];
    const create = gmCreating(actors);
    await actorUpsertV1(approved({ equipment: undefined }), {} as never);
    expect(create.mock.calls[0][0].prototypeToken).toEqual({ actorLink: true });
  });
});

describe("actor.upsert.v1 after the world is linked again", () => {
  // The backend mints a new world id when the world is unlinked and linked
  // again; the table and character ids stay the same.
  it("replays the same revision under the new world id without writing or creating", async () => {
    const actor = fakeActor();
    binding(actor, approved());
    const create = vi.fn();
    stubFoundry([actor], create);
    const first = await actorUpsertV1(approved(), {} as never);
    const writes = actor.updates.length;

    const replay = await actorUpsertV1(
      approved({ worldId: "world-2" }),
      {} as never,
    );
    expect(replay).toEqual(first);
    expect(actor.updates).toHaveLength(writes);
    expect(create).not.toHaveBeenCalled();
  });

  it("updates the bound Actor named by expectedActorId on a higher revision and rebinds it", async () => {
    const actor = fakeActor();
    binding(actor, approved());
    const create = vi.fn();
    stubFoundry([actor], create);
    await actorUpsertV1(approved(), {} as never);

    const result = (await actorUpsertV1(
      approved({
        worldId: "world-2",
        approvedRevision: 2,
        expectedActorId: ACTOR_ID,
      }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.outcome).toBe("updated");
    expect(result.resultDocId).toBe(ACTOR_ID);
    expect(create).not.toHaveBeenCalled();
    expect(
      (actor.flags[MODULE_ID] as { binding: { worldId: string } }).binding
        .worldId,
    ).toBe("world-2");
  });
});
