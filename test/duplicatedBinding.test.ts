import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorResourcesV1,
  type ActorResourcesResultV1,
} from "../src/procedures/actorResources.js";
import { actorItemsV1 } from "../src/procedures/actorItems.js";
import {
  actorUpsertV1,
  type ActorUpsertResultV1,
} from "../src/procedures/actorUpsert.js";
import {
  PROVISIONING_OPTION,
  stripDuplicatedBinding,
} from "../src/procedures/upsertShared.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import {
  ACTOR_ID,
  ForcedDeletion,
  approved,
  binding,
  fakeActor,
  stubFoundry,
  stubOperators,
  wearingArmour,
  type FakeActor,
} from "./support/actorUpsertHarness.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const COPY_ID = "actorCopy0000001";

/** A Knight PC bound to character-1 of table-1. */
function bound(id = ACTOR_ID): FakeActor {
  const actor = wearingArmour(fakeActor(id));
  binding(actor, approved());
  actor.system = {
    wear: "armure",
    sante: { value: 1, max: 30 },
    espoir: { value: 1, max: 50 },
    equipements: {
      armure: { armure: { value: 1 }, energie: { value: 1 } },
    },
  };
  return actor;
}

/** A copy of `original` as Foundry's « Duplicate » makes it: the same flags,
 * and `_stats.duplicateSource` set to the original's uuid (Foundry 14,
 * `Document#clone` with `addSource`). Without `recorded`, a copy whose source
 * Foundry did not record. */
function copyOf(original: FakeActor, recorded = true): FakeActor {
  const copy = bound(COPY_ID);
  copy.flags = structuredClone(original.flags);
  return Object.assign(copy, {
    _stats: { duplicateSource: recorded ? `Actor.${original.id}` : null },
  });
}

const resources = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  actorType: "knight",
  worldId: "world-1",
  tableId: "table-1",
  characterId: "character-1",
  expectedActorId: ACTOR_ID,
  sequence: 7,
  resources: { health: 12 },
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

describe("a duplicated Knight PC carrying the same binding", () => {
  it("actor.resources writes the Actor the request names, either one", async () => {
    const original = bound();
    const copy = copyOf(original, false);
    stubFoundry([original, copy]);
    await actorResourcesV1(resources(), {} as never);
    expect(original.updates).toHaveLength(1);
    expect(copy.updates).toHaveLength(0);

    const result = (await actorResourcesV1(
      resources({ expectedActorId: COPY_ID, sequence: 8 }),
      {} as never,
    )) as ActorResourcesResultV1;
    expect(result.warnings).toEqual([]);
    expect(copy.updates).toHaveLength(1);
  });

  it("actor.resources still refuses binding_collision when the named Actor is neither", async () => {
    const original = bound();
    stubFoundry([original, copyOf(original), bound("actorOther000001")]);
    expect(
      await code(
        actorResourcesV1(
          resources({ expectedActorId: "actorUnrelated01" }),
          {} as never,
        ),
      ),
    ).toBe("binding_collision");
  });

  it("actor.items reaches the named Actor past the collision", async () => {
    const original = bound();
    const copy = copyOf(original, false);
    stubFoundry([original, copy]);
    const req = {
      schemaVersion: 1,
      actorType: "knight",
      worldId: "world-1",
      tableId: "table-1",
      characterId: "character-1",
      expectedActorId: COPY_ID,
      op: {
        remove: {
          itemId: "item000000000099",
          kind: "module",
          expectedName: "x",
        },
      },
    };
    // Past the lookup, the lane answers on the copy's own Items.
    await expect(actorItemsV1(req, {} as never)).resolves.toBeDefined();
  });

  it("actor.upsert without expectedActorId serves the original when Foundry recorded the copy's source", async () => {
    const original = bound();
    const copy = copyOf(original);
    stubFoundry([original, copy]);
    const result = (await actorUpsertV1(
      approved({ equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.resultDocId).toBe(ACTOR_ID);
    expect(result.outcome).toBe("updated");
    expect(copy.updates).toHaveLength(0);
  });

  it("actor.upsert without expectedActorId resolves a copy of a copy to the original", async () => {
    const original = bound();
    const copy = copyOf(original);
    const second = Object.assign(bound("actorCopy0000002"), {
      flags: structuredClone(original.flags),
      _stats: { duplicateSource: `Actor.${COPY_ID}` },
    });
    stubFoundry([second, copy, original]);
    const result = (await actorUpsertV1(
      approved({ equipment: undefined }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.resultDocId).toBe(ACTOR_ID);
  });

  it("actor.upsert without expectedActorId keeps the refusal when no source was recorded", async () => {
    const original = bound();
    stubFoundry([original, copyOf(original, false)]);
    expect(
      await code(
        actorUpsertV1(approved({ equipment: undefined }), {} as never),
      ),
    ).toBe("binding_collision");
  });

  it("actor.upsert never takes a source naming an Actor outside the collision as certain", async () => {
    const a = bound();
    const b = Object.assign(bound(COPY_ID), {
      _stats: { duplicateSource: "Actor.actorUnrelated01" },
    });
    stubFoundry([a, b]);
    expect(
      await code(
        actorUpsertV1(approved({ equipment: undefined }), {} as never),
      ),
    ).toBe("binding_collision");
  });

  it("actor.upsert with expectedActorId serves that Actor, even the copy", async () => {
    const original = bound();
    const copy = copyOf(original);
    stubFoundry([original, copy]);
    const result = (await actorUpsertV1(
      approved({ equipment: undefined, expectedActorId: COPY_ID }),
      {} as never,
    )) as ActorUpsertResultV1;
    expect(result.resultDocId).toBe(COPY_ID);
    expect(original.updates).toHaveLength(0);
  });
});

/** A pending Actor as Foundry hands it to `preCreateActor`: its source flags
 * and `updateSource`, which applies a deletion the way Foundry does (a
 * `ForcedDeletion` on 14, the `-=key` syntax before). */
function pending(flags: Record<string, unknown>) {
  const doc = {
    name: "Copy of Lancelot",
    type: "knight",
    flags: structuredClone(flags),
    updateSource: vi.fn((changes: { flags: Record<string, unknown> }) => {
      for (const [key, value] of Object.entries(changes.flags)) {
        if (value instanceof ForcedDeletion) delete doc.flags[key];
        else if (key.startsWith("-=")) delete doc.flags[key.slice(2)];
        else doc.flags[key] = value;
      }
    }),
  };
  return doc;
}

describe("the preCreateActor hook", () => {
  it.each([13, 14])(
    "strips this module's flags from a new Actor carrying a binding another Actor holds (Foundry %i)",
    (generation) => {
      if (generation === 14) stubOperators();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const original = bound();
      original.flags.other = { kept: true };
      stubFoundry([original]);
      const doc = pending(original.flags);
      stripDuplicatedBinding(doc as never, {}, {});
      expect(doc.flags).toEqual({ other: { kept: true } });
      expect(warn).toHaveBeenCalledTimes(1);
      // The original keeps its flags.
      expect(original.flags[MODULE_ID]).toBeDefined();
      expect(original.updates).toHaveLength(0);
    },
  );

  it("leaves the module's own creation alone, even when another Actor carries the binding", () => {
    const original = bound();
    stubFoundry([original]);
    const doc = pending(original.flags);
    stripDuplicatedBinding(
      doc as never,
      {},
      { renderSheet: false, [PROVISIONING_OPTION]: true },
    );
    expect(doc.updateSource).not.toHaveBeenCalled();
    expect(doc.flags[MODULE_ID]).toBeDefined();
  });

  it("leaves an Actor whose binding no other Actor carries, and an unbound one", () => {
    stubFoundry([bound()]);
    const other = bound(COPY_ID);
    (other.flags[MODULE_ID] as { binding: { characterId: string } })[
      "binding"
    ].characterId = "character-2";
    const unique = pending(other.flags);
    stripDuplicatedBinding(unique as never, {}, {});
    const plain = pending({ other: { kept: true } });
    stripDuplicatedBinding(plain as never, {}, {});
    expect(unique.updateSource).not.toHaveBeenCalled();
    expect(plain.updateSource).not.toHaveBeenCalled();
  });

  it("is what the module's creation passes: a draft it creates carries the marker", async () => {
    const create = vi.fn(async (_data: unknown, _options: unknown) => {
      const actor = fakeActor();
      return actor;
    });
    stubFoundry([], create);
    await actorUpsertV1(approved({ equipment: undefined }), {} as never);
    expect(create.mock.calls[0][1]).toMatchObject({
      [PROVISIONING_OPTION]: true,
    });
  });
});
