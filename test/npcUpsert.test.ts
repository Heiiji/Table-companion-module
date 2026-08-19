import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  npcUpsertV1,
  validateKnightNpcUpsertV1,
  type KnightNpcUpsertV1,
  type NpcUpsertResultV1,
} from "../src/procedures/npcUpsert.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";

const ACTOR_ID = "actor00000000pnj";

interface PnjSchemaFixture {
  foundryGeneration: number;
  knightSystemVersion: string;
  actorCreateAPI: string;
  actor: {
    type: string;
    ownership: Record<string, unknown>;
    prototypeToken: Record<string, unknown>;
    system: Record<string, unknown>;
  };
}

const PNJ_SCHEMA_FIXTURES = [13, 14].map(
  (generation) =>
    JSON.parse(
      readFileSync(
        new URL(
          `./fixtures/knight-pnj-3.58.33-foundry${generation}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as PnjSchemaFixture,
);

function request(
  overrides: Partial<KnightNpcUpsertV1> = {},
): KnightNpcUpsertV1 {
  return {
    schemaVersion: 1,
    actorType: "pnj",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "npc-1",
    contentRevision: 1_755_555_555_000,
    name: "Lena Valcourt",
    visibility: "hidden",
    aspects: { chair: 5, bete: 7, machine: 4, dame: 6, masque: 3 },
    resources: {
      health: { max: 30, current: 24 },
      armour: { max: 20, current: 20 },
      energy: { max: 10, current: 10 },
      forceField: 4,
    },
    defenses: { defense: 5, reaction: 6, initiative: 4 },
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
  prototypeToken: Record<string, unknown>;
  system: Record<string, unknown>;
  updates: Array<Record<string, unknown>>;
  update(changes: Record<string, unknown>): Promise<void>;
}

function fakeActor(id = ACTOR_ID, name = "Existing", type = "pnj"): FakeActor {
  const actor: FakeActor = {
    id,
    name,
    type,
    flags: {},
    ownership: {},
    prototypeToken: {},
    system: {},
    updates: [],
    update: async (changes) => {
      actor.updates.push(changes);
      for (const [key, value] of Object.entries(changes)) {
        if (key === "name") actor.name = String(value);
        else if (key === "ownership") {
          for (const [ownershipKey, level] of Object.entries(
            value as Record<string, unknown>,
          )) {
            if (ownershipKey.startsWith("-="))
              delete actor.ownership[ownershipKey.slice(2)];
            else actor.ownership[ownershipKey] = level;
          }
        } else
          setPath(actor as unknown as Record<string, unknown>, key, value);
      }
    },
  };
  return actor;
}

function binding(actor: FakeActor, req: KnightNpcUpsertV1): void {
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: req.worldId,
      tableId: req.tableId,
      characterId: req.characterId,
    },
  };
}

function stubFoundry(
  actors: FakeActor[],
  create?: ReturnType<typeof vi.fn>,
  generation = 13,
  system: { id: string; version: string } = {
    id: "knight",
    version: "3.58.33",
  },
  isGM = true,
): ReturnType<typeof vi.fn> {
  const collection = {
    contents: actors,
    get: (id: string) => actors.find((actor) => actor.id === id),
  };
  const createFn =
    create ??
    vi.fn(async (data: Record<string, unknown>) => {
      const actor = fakeActor(
        `actor${String(actors.length).padStart(11, "0")}`,
        String(data.name ?? ""),
        String(data.type ?? ""),
      );
      actor.flags = structuredClone(data.flags ?? {}) as Record<
        string,
        unknown
      >;
      actor.ownership = structuredClone(data.ownership ?? {}) as Record<
        string,
        unknown
      >;
      actor.prototypeToken = structuredClone(
        data.prototypeToken ?? {},
      ) as Record<string, unknown>;
      actors.push(actor);
      return actor;
    });
  vi.stubGlobal("game", {
    user: { id: "gm", isGM },
    actors: collection,
    system,
    release: { generation },
  });
  vi.stubGlobal("Actor", { implementation: { create: createFn } });
  return createFn;
}

async function expectRpcError(run: unknown, code: string): Promise<void> {
  const error = await Promise.resolve(run).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).code).toBe(code);
}

afterEach(() => vi.unstubAllGlobals());

describe("pnj schema fixtures", () => {
  it("carry the pnj identity for both Foundry generations", () => {
    for (const fixture of PNJ_SCHEMA_FIXTURES) {
      expect(fixture.knightSystemVersion).toBe("3.58.33");
      expect(fixture.actorCreateAPI).toBe("Actor.implementation.create");
      expect(fixture.actor.type).toBe("pnj");
    }
    expect(PNJ_SCHEMA_FIXTURES.map((f) => f.foundryGeneration)).toEqual([
      13, 14,
    ]);
  });
});

describe("npc.upsert.v1", () => {
  for (const fixture of PNJ_SCHEMA_FIXTURES) {
    it(`writes only fixture-proven pnj paths on Foundry ${fixture.foundryGeneration}`, async () => {
      const actors: FakeActor[] = [];
      stubFoundry(actors, undefined, fixture.foundryGeneration);

      const result = (await npcUpsertV1(
        request() as unknown as Record<string, unknown>,
        {} as never,
      )) as NpcUpsertResultV1;
      expect(result.outcome).toBe("created");

      const written = actors[0].updates.flatMap((update) =>
        Object.keys(update),
      );
      const systemKeys = written.filter((key) => key.startsWith("system."));
      // The mapping is real only if it writes a substantive pnj surface.
      expect(systemKeys.length).toBeGreaterThan(10);
      for (const key of systemKeys) {
        expect(
          hasFixturePath(fixture.actor.system, key.slice("system.".length)),
          key,
        ).toBe(true);
      }
      for (const key of written.filter((k) => k.startsWith("prototypeToken."))) {
        expect(
          hasFixturePath(fixture.actor.prototypeToken, key.slice(15)),
          key,
        ).toBe(true);
      }
    });
  }

  it("creates a hidden pnj Actor fail-closed: ownership NONE, disposition SECRET", async () => {
    const actors: FakeActor[] = [];
    const create = stubFoundry(actors);

    const result = (await npcUpsertV1(
      request() as unknown as Record<string, unknown>,
      {} as never,
    )) as NpcUpsertResultV1;

    expect(result.outcome).toBe("created");
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0] as Record<string, unknown>;
    expect(data.type).toBe("pnj");
    expect(data.ownership).toEqual({ default: 0 });
    expect(data.prototypeToken).toEqual({ disposition: -2 });
    const actor = actors[0];
    expect(actor.ownership).toEqual({ default: 0 });
    expect(actor.prototypeToken.disposition).toBe(-2);
    expect(actor.system).toMatchObject({
      aspects: { bete: { value: 7 }, masque: { value: 3 } },
      sante: { base: 30, value: 24 },
      armure: { base: 20, value: 20 },
      energie: { base: 10, value: 10 },
      champDeForce: { base: 4 },
      defense: { base: 5 },
      reaction: { base: 6 },
      initiative: { bonus: { user: 4 } },
    });
    expect(
      (actor.flags[MODULE_ID] as Record<string, unknown>).binding,
    ).toEqual({
      schemaVersion: 1,
      worldId: "world-1",
      tableId: "table-1",
      characterId: "npc-1",
    });
  });

  it("maps visible to ownership LIMITED and disposition NEUTRAL", async () => {
    const actors: FakeActor[] = [];
    stubFoundry(actors);

    await npcUpsertV1(
      request({ visibility: "visible" }) as unknown as Record<string, unknown>,
      {} as never,
    );

    expect(actors[0].ownership).toEqual({ default: 1 });
    expect(actors[0].prototypeToken.disposition).toBe(0);
  });

  it("revokes stale grants and re-hides on a visible-to-hidden flip", async () => {
    const req = request({ contentRevision: 2_000_000_000_000 });
    const actor = fakeActor();
    binding(actor, req);
    actor.ownership = { default: 1, user000000000001: 3 };
    actor.prototypeToken = { disposition: 0 };
    stubFoundry([actor]);

    const result = (await npcUpsertV1(
      req as unknown as Record<string, unknown>,
      {} as never,
    )) as NpcUpsertResultV1;

    expect(result.outcome).toBe("updated");
    expect(actor.ownership).toEqual({ default: 0 });
    expect(actor.prototypeToken.disposition).toBe(-2);
  });

  it("never adopts by name: an unbound same-name pnj Actor is left alone", async () => {
    const bystander = fakeActor("actor0bystander", "Lena Valcourt");
    const actors = [bystander];
    stubFoundry(actors);

    const result = (await npcUpsertV1(
      request() as unknown as Record<string, unknown>,
      {} as never,
    )) as NpcUpsertResultV1;

    expect(result.outcome).toBe("created");
    expect(actors).toHaveLength(2);
    expect(bystander.updates).toHaveLength(0);
  });

  it("replays the stored result with zero writes on a digest-equal resend", async () => {
    const req = request();
    const actors: FakeActor[] = [];
    stubFoundry(actors);

    const first = (await npcUpsertV1(
      req as unknown as Record<string, unknown>,
      {} as never,
    )) as NpcUpsertResultV1;
    const writesAfterFirst = actors[0].updates.length;

    const replay = (await npcUpsertV1(
      req as unknown as Record<string, unknown>,
      {} as never,
    )) as NpcUpsertResultV1;

    expect(replay).toEqual(first);
    expect(replay.outcome).toBe("created");
    expect(actors[0].updates.length).toBe(writesAfterFirst);
  });

  it("re-applies on a higher content revision and converges the sync flag", async () => {
    const actors: FakeActor[] = [];
    stubFoundry(actors);
    await npcUpsertV1(request() as unknown as Record<string, unknown>, {} as never);

    const next = request({
      contentRevision: 1_755_555_556_000,
      name: "Lena Valcourt — blessée",
      resources: { health: { max: 30, current: 6 } },
    });
    const result = (await npcUpsertV1(
      next as unknown as Record<string, unknown>,
      {} as never,
    )) as NpcUpsertResultV1;

    expect(result.outcome).toBe("updated");
    expect(result.appliedRevision).toBe(1_755_555_556_000);
    expect(actors[0].name).toBe("Lena Valcourt — blessée");
    expect(actors[0].system).toMatchObject({ sante: { base: 30, value: 6 } });
    const sync = (actors[0].flags[MODULE_ID] as Record<string, unknown>)
      .npcUpsertV1 as Record<string, unknown>;
    expect(sync.appliedRevision).toBe(1_755_555_556_000);
  });

  it("rejects a stale revision and a same-revision different-content resend", async () => {
    const actors: FakeActor[] = [];
    stubFoundry(actors);
    await npcUpsertV1(request() as unknown as Record<string, unknown>, {} as never);

    await expectRpcError(
      npcUpsertV1(
        request({ contentRevision: 1 }) as unknown as Record<string, unknown>,
        {} as never,
      ),
      "stale_revision",
    );
    await expectRpcError(
      npcUpsertV1(
        request({ name: "Someone Else" }) as unknown as Record<string, unknown>,
        {} as never,
      ),
      "revision_conflict",
    );
  });

  it("fails closed on binding collisions and non-pnj bindings", async () => {
    const req = request();
    const first = fakeActor("actor00000000aaa");
    const second = fakeActor("actor00000000bbb");
    binding(first, req);
    binding(second, req);
    stubFoundry([first, second]);
    await expectRpcError(
      npcUpsertV1(req as unknown as Record<string, unknown>, {} as never),
      "binding_collision",
    );

    const wrongType = fakeActor("actor00000000ccc", "Bound PC", "knight");
    binding(wrongType, req);
    stubFoundry([wrongType]);
    await expectRpcError(
      npcUpsertV1(req as unknown as Record<string, unknown>, {} as never),
      "binding_conflict",
    );
  });

  it("requires a GM responder and the exact fixture-pinned runtime", async () => {
    stubFoundry([], undefined, 13, { id: "knight", version: "3.58.33" }, false);
    await expectRpcError(
      npcUpsertV1(request() as unknown as Record<string, unknown>, {} as never),
      "permission_denied",
    );

    stubFoundry([], undefined, 13, { id: "knight", version: "3.58.34" });
    await expectRpcError(
      npcUpsertV1(request() as unknown as Record<string, unknown>, {} as never),
      "unsupported_runtime",
    );

    stubFoundry([], undefined, 15);
    await expectRpcError(
      npcUpsertV1(request() as unknown as Record<string, unknown>, {} as never),
      "unsupported_runtime",
    );
  });
});

describe("validateKnightNpcUpsertV1", () => {
  it("accepts the full request and an aspects-only request", () => {
    expect(() => validateKnightNpcUpsertV1(request())).not.toThrow();
    expect(() =>
      validateKnightNpcUpsertV1(
        request({ resources: undefined, defenses: undefined }),
      ),
    ).not.toThrow();
  });

  it("rejects unknown fields recursively", () => {
    const attempts: Array<Record<string, unknown>> = [
      { ...request(), system: { sante: { value: 999 } } },
      { ...request(), flags: {} },
      { ...request(), ownership: { default: 3 } },
      { ...request(), img: "https://example.invalid/x.png" },
      { ...request(), aspects: { ...request().aspects, ae: { majeur: 1 } } },
      {
        ...request(),
        resources: { health: { max: 1, current: 1, temp: 1 } },
      },
      { ...request(), resources: { hope: 10 } },
      { ...request(), defenses: { defense: 1, esquive: 2 } },
    ];
    for (const attempt of attempts) {
      expect(
        () => validateKnightNpcUpsertV1(attempt),
        JSON.stringify(attempt),
      ).toThrow(/not allowed/);
    }
  });

  it("rejects wrong identities, visibilities, and revisions", () => {
    expect(() =>
      validateKnightNpcUpsertV1({ ...request(), actorType: "knight" }),
    ).toThrow(/actorType/);
    expect(() =>
      validateKnightNpcUpsertV1({ ...request(), schemaVersion: 2 }),
    ).toThrow(/schemaVersion/);
    expect(() =>
      validateKnightNpcUpsertV1({ ...request(), visibility: "revealed" }),
    ).toThrow(/visibility/);
    expect(() =>
      validateKnightNpcUpsertV1(
        request({ contentRevision: 0 }) as unknown as Record<string, unknown>,
      ),
    ).toThrow(/contentRevision/);
    expect(() =>
      validateKnightNpcUpsertV1(
        request({ contentRevision: 1.5 }) as unknown as Record<string, unknown>,
      ),
    ).toThrow(/contentRevision/);
    expect(() =>
      validateKnightNpcUpsertV1({ ...request(), aspects: undefined }),
    ).toThrow(/aspects/);
    expect(() =>
      validateKnightNpcUpsertV1(
        request({
          aspects: { chair: 21, bete: 0, machine: 0, dame: 0, masque: 0 },
        }) as unknown as Record<string, unknown>,
      ),
    ).toThrow(/aspects\.chair/);
  });

  it("admits epoch-millisecond content revisions", () => {
    const parsed = validateKnightNpcUpsertV1(
      request({ contentRevision: 1_755_555_555_123 }),
    );
    expect(parsed.contentRevision).toBe(1_755_555_555_123);
  });
});
