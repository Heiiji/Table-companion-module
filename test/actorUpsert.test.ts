import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorUpsertV1,
  type ActorUpsertResultV1,
} from "../src/procedures/actorUpsert.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import {
  ACTOR_ID,
  KNIGHT_SCHEMA_FIXTURES,
  USER_ID,
  approved,
  binding,
  fakeActor,
  hasFixturePath,
  stubFoundry,
  type FakeActor,
} from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

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
    stubFoundry([], undefined, 12);
    await expect(actorUpsertV1(approved(), {} as never)).rejects.toMatchObject({
      code: "unsupported_runtime",
    });

    // A newer Foundry generation is not refused for being newer.
    vi.unstubAllGlobals();
    stubFoundry([], undefined, 15);
    await expect(actorUpsertV1(approved(), {} as never)).resolves.toMatchObject({
      schemaVersion: 1,
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
