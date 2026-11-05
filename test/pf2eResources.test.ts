import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pf2eResourcesV1,
  validatePf2eActorResourcesV1,
  type Pf2eActorResourcesV1,
} from "../src/procedures/pf2eResources.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";

// SYNTHETIC, shape-only: a prepared pf2e `character`, its condition items and
// physical items as the pf2e 8.5.1 and 8.6.1 sources describe them (source-derived, not a
// capture). ConditionManager, increaseCondition, createEmbeddedDocuments and
// deleteEmbeddedDocuments follow the source's observable behaviour: dying /
// wounded / doomed capped at their prepared max, an immune condition silently
// dropped, a deleted container's contents ejected.

const ACTOR_ID = "pf2eActor0000001";
const KEY_A = "0b6f4a0e-3c1d-4f6e-9a7b-2c8d1e5f6a01";
const KEY_B = "0b6f4a0e-3c1d-4f6e-9a7b-2c8d1e5f6a02";

interface FakeItem {
  _id: string;
  type: string;
  system: Record<string, unknown>;
  flags: Record<string, unknown>;
  isLocked?: boolean;
  update: ReturnType<typeof vi.fn>;
}

let nextId = 0;
const newId = () => `item${String(++nextId).padStart(12, "0")}`;

function item(
  type: string,
  system: Record<string, unknown>,
  extra: Partial<FakeItem> = {},
): FakeItem {
  const it: FakeItem = {
    _id: extra._id ?? newId(),
    type,
    system,
    flags: extra.flags ?? {},
    ...(extra.isLocked === undefined ? {} : { isLocked: extra.isLocked }),
    update: vi.fn(async (changes: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(changes))
        setPath(it as unknown as Record<string, unknown>, k, v);
    }),
  };
  return it;
}

const VALUED = new Set(["frightened", "dying", "wounded", "doomed", "clumsy"]);

function condition(
  slug: string,
  value: number | null = VALUED.has(slug) ? 1 : null,
  extra: Partial<FakeItem> = {},
): FakeItem {
  return item(
    "condition",
    { slug, value: { isValued: value !== null, value }, references: {} },
    extra,
  );
}

function setPath(root: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let at = root;
  for (const key of keys.slice(0, -1))
    at = (at[key] ??= {}) as Record<string, unknown>;
  at[keys[keys.length - 1]] = value;
}

function fakeCharacter(
  items: FakeItem[] = [],
  { immune = [] as string[], heroMax = 3 } = {},
) {
  const actor = {
    id: ACTOR_ID,
    name: "Fixture Fighter",
    type: "character",
    flags: {
      [MODULE_ID]: {
        binding: {
          schemaVersion: 1,
          worldId: "world-1",
          tableId: "table-1",
          characterId: "character-1",
        },
      },
    } as Record<string, unknown>,
    system: {
      attributes: {
        hp: { value: 20, max: 30, temp: 0, unrecoverable: 0 },
        dying: { value: 0, max: 4 },
        wounded: { value: 0, max: 3 },
        doomed: { value: 0, max: 3 },
      },
      resources: { heroPoints: { value: 1, max: heroMax } },
      abilities: null,
      details: { level: { value: 3 } },
    } as Record<string, unknown>,
    items: { contents: items },
    updates: [] as Record<string, unknown>[],
    update: vi.fn(async (changes: Record<string, unknown>) => {
      actor.updates.push(changes);
      for (const [key, value] of Object.entries(changes))
        setPath(actor as unknown as Record<string, unknown>, key, value);
    }),
    increaseCondition: vi.fn(
      async (slug: string, { value }: { value: number }) => {
        if (immune.includes(slug)) return null;
        const made = condition(slug, VALUED.has(slug) ? value : null);
        actor.items.contents.push(made);
        return made;
      },
    ),
    decreaseCondition: vi.fn(),
    createEmbeddedDocuments: vi.fn(
      async (_type: string, sources: Record<string, unknown>[]) => {
        const made = sources.map((s) =>
          item(String(s.type), s.system as Record<string, unknown>, {
            flags: (s.flags ?? {}) as Record<string, unknown>,
          }),
        );
        actor.items.contents.push(...made);
        return made;
      },
    ),
    deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
      const list = actor.items.contents;
      for (const id of ids) {
        const at = list.findIndex((i) => i._id === id);
        if (at < 0) continue;
        if (list[at].type === "backpack")
          for (const i of list)
            if (i.system.containerId === id) i.system.containerId = null;
        list.splice(at, 1);
      }
    }),
    // pf2e's stacking path: merges into an existing Item of the same slug.
    inventory: {
      add: vi.fn(async (sources: Record<string, unknown>[]) => {
        for (const s of sources) {
          const slug = (s.system as Record<string, unknown>).slug;
          const same = actor.items.contents.find((i) => i.system.slug === slug);
          if (same)
            same.system.quantity =
              Number(same.system.quantity) +
              Number((s.system as Record<string, unknown>).quantity);
          else await actor.createEmbeddedDocuments("Item", [s]);
        }
      }),
    },
  };
  return actor;
}
type FakeCharacter = ReturnType<typeof fakeCharacter>;

function equipment(slug: string, extra: Record<string, unknown> = {}) {
  return {
    _id: `pack${slug.replace(/-/g, "").padEnd(12, "0").slice(0, 12)}`,
    type: "weapon",
    system: { slug, quantity: 1, ...extra },
  };
}

const PACK = [
  equipment("longsword"),
  equipment("rope"),
  equipment("gloves-of-choice", {
    rules: [{ key: "ChoiceSet", choices: [{ value: "a" }] }],
  }),
];

function updateConditionValue(
  itemId: string,
  actor: FakeCharacter,
  value: number,
) {
  const list = actor.items.contents;
  const at = list.findIndex((i) => i._id === itemId);
  if (at < 0 || list[at].type !== "condition") return Promise.resolve();
  if (value === 0) {
    list.splice(at, 1);
    return Promise.resolve();
  }
  const slug = String(list[at].system.slug);
  const attrs = actor.system.attributes as Record<string, { max: number }>;
  if (["dying", "wounded", "doomed"].includes(slug))
    value = Math.min(value, attrs[slug].max);
  (list[at].system.value as Record<string, unknown>).value = value;
  return Promise.resolve();
}

const conditionManager = { updateConditionValue: vi.fn(updateConditionValue) };

function stubWorld(
  actors: FakeCharacter[],
  {
    id = "pf2e",
    version = "8.5.1",
    generation = 14,
    isGM = true,
    manager = conditionManager as unknown,
    fromCompendium = true,
  } = {},
) {
  vi.stubGlobal("game", {
    user: { id: "gm", isGM },
    actors: {
      contents: actors,
      get: (actorId: string) => actors.find((a) => a.id === actorId),
    },
    system: { id, version },
    release: { generation },
    pf2e: { ConditionManager: manager },
    items: fromCompendium
      ? { fromCompendium: (doc: unknown) => structuredClone(doc) }
      : {},
    packs: {
      get: (packId: string) =>
        packId === "pf2e.equipment-srd"
          ? {
              getIndex: async () =>
                PACK.map((e) => ({
                  _id: e._id,
                  system: { slug: e.system.slug },
                })),
              getDocuments: async ({ _id__in }: { _id__in: string[] }) =>
                PACK.filter((e) => _id__in.includes(e._id)),
            }
          : undefined,
    },
  });
}

function request(
  overrides: Partial<Pf2eActorResourcesV1> & Record<string, unknown> = {},
): Pf2eActorResourcesV1 {
  return {
    schemaVersion: 1,
    actorType: "character",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    expectedActorId: ACTOR_ID,
    sequence: 3,
    ...overrides,
  } as Pf2eActorResourcesV1;
}

type Result = { warnings: string[]; created: Record<string, string> };

async function run(actor: FakeCharacter, req: unknown) {
  stubWorld([actor]);
  return (await pf2eResourcesV1(req, {} as never)) as Result;
}

async function rejects(pending: unknown, code: string) {
  const promise = Promise.resolve(pending);
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code });
}

const held = (actor: FakeCharacter) =>
  actor.items.contents
    .filter((i) => i.type === "condition")
    .map(
      (i) => `${i.system.slug}:${(i.system.value as { value: unknown }).value}`,
    )
    .sort();

afterEach(() => {
  vi.unstubAllGlobals();
  conditionManager.updateConditionValue.mockClear();
});

describe("pf2e.resources.v1 validation", () => {
  const items500 = Object.fromEntries(
    Array.from({ length: 501 }, (_, i) => [
      `itm${String(i).padStart(13, "0")}`,
      1,
    ]),
  );
  const add = { key: KEY_A, slug: "longsword", quantity: 1 };
  it.each([
    ["an unknown key", { extra: 1, hp: 1 }],
    ["another actor type", { actorType: "npc", hp: 1 }],
    ["another schema version", { schemaVersion: 2, hp: 1 }],
    ["no group at all", {}],
    ["a malformed actor id", { expectedActorId: "short", hp: 1 }],
    ["sequence 0", { sequence: 0, hp: 1 }],
    ["a sequence above 2^53-1", { sequence: 2 ** 53, hp: 1 }],
    ["hp above 9999", { hp: 10000 }],
    ["a negative hp", { hp: -1 }],
    ["a fractional hp", { hp: 1.5 }],
    ["hpTemp above 999", { hpTemp: 1000 }],
    ["a string hpTemp", { hpTemp: "3" }],
    ["heroPoints above 3", { heroPoints: 4 }],
    ["conditions as an array", { conditions: ["prone"] }],
    ["an unknown condition slug", { conditions: { bleeding: 1 } }],
    ["persistent-damage", { conditions: { "persistent-damage": 1 } }],
    ["a condition value above 99", { conditions: { frightened: 100 } }],
    ["a negative condition value", { conditions: { frightened: -1 } }],
    ["items as an array", { items: [] }],
    ["a malformed item id", { items: { short: 1 } }],
    ["a quantity above 999999", { items: { abcdefghijklmnop: 1_000_000 } }],
    ["more than 500 items", { items: items500 }],
    ["adds that are not an array", { adds: add }],
    ["more than 50 adds", { adds: Array(51).fill(add) }],
    ["an add with an extra key", { adds: [{ ...add, extra: 1 }] }],
    [
      "an add key that is not a lowercase uuid",
      { adds: [{ ...add, key: KEY_A.toUpperCase() }] },
    ],
    [
      "an add slug that is not a slug",
      { adds: [{ ...add, slug: "Long Sword" }] },
    ],
    ["an add quantity 0", { adds: [{ ...add, quantity: 0 }] }],
    ["a duplicate add key", { adds: [add, add] }],
  ])("refuses %s", (_label, overrides) => {
    expect(() =>
      validatePf2eActorResourcesV1(request(overrides as never)),
    ).toThrow(RpcError);
  });

  it("accepts every group at its bounds, and empty maps", () => {
    const req = validatePf2eActorResourcesV1(
      request({
        sequence: Number.MAX_SAFE_INTEGER,
        hp: 9999,
        hpTemp: 999,
        heroPoints: 3,
        conditions: { dying: 99, prone: 0 },
        items: { abcdefghijklmnop: 999_999 },
        adds: [{ key: KEY_A, slug: "longsword", quantity: 999_999 }],
      }),
    );
    expect(req.conditions).toEqual({ dying: 99, prone: 0 });
    expect(
      validatePf2eActorResourcesV1(request({ conditions: {} })).conditions,
    ).toEqual({});
    expect(validatePf2eActorResourcesV1(request({ adds: [] })).adds).toEqual(
      [],
    );
  });
});

describe("pf2e.resources.v1 runtime gate", () => {
  it.each(["8.5.1", "8.5.9", "8.6.0", "8.6.1", "8.7.0"])(
    "writes counters and conditions on pf2e %s",
    async (version) => {
      const actor = fakeCharacter();
      stubWorld([actor], { version });
      await pf2eResourcesV1(
        request({
          hp: 12,
          hpTemp: 3,
          heroPoints: 2,
          conditions: { frightened: 2 },
        }),
        {} as never,
      );
      expect(actor.updates[0]).toMatchObject({
        "system.attributes.hp.value": 12,
        "system.attributes.hp.temp": 3,
        "system.resources.heroPoints.value": 2,
      });
      expect(actor.increaseCondition).toHaveBeenCalledWith("frightened", {
        value: 2,
      });
    },
  );

  it.each([
    ["pf2e below the floor", { version: "8.5.0" }],
    ["a non-strict version", { version: "8.5.1-beta" }],
    ["a truncated version", { version: "8.5" }],
    ["an unknown version", { version: "" }],
    ["Foundry 13", { generation: 13 }],
    ["a sibling system", { id: "sf2e" }],
    ["no ConditionManager", { manager: null }],
    ["no fromCompendium", { fromCompendium: false }],
  ])("refuses %s as unsupported_runtime", async (_label, world) => {
    const actor = fakeCharacter();
    stubWorld([actor], world);
    await rejects(
      pf2eResourcesV1(request({ hp: 5 }), {} as never),
      "unsupported_runtime",
    );
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("refuses an Actor without increaseCondition", async () => {
    const actor = fakeCharacter();
    (actor as Partial<FakeCharacter>).increaseCondition = undefined;
    await rejects(run(actor, request({ hp: 5 })), "unsupported_runtime");
  });

  it("refuses a non-GM responder", async () => {
    const actor = fakeCharacter();
    stubWorld([actor], { isGM: false });
    await rejects(
      pf2eResourcesV1(request({ hp: 5 }), {} as never),
      "permission_denied",
    );
  });
});

describe("pf2e.resources.v1 actor resolution", () => {
  it("writes the bound Actor", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ hp: 5 }));
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(5);
  });

  it("writes the unbound Actor the app names", async () => {
    const actor = fakeCharacter();
    actor.flags = {};
    await run(actor, request({ hp: 5 }));
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(5);
  });

  it("refuses a missing Actor, another binding, or a non-character", async () => {
    stubWorld([]);
    await rejects(
      pf2eResourcesV1(request({ hp: 5 }), {} as never),
      "deleted_link",
    );

    const other = fakeCharacter();
    (other.flags[MODULE_ID] as Record<string, Record<string, unknown>>)[
      "binding"
    ].characterId = "someone-else";
    await rejects(run(other, request({ hp: 5 })), "binding_conflict");

    const npc = fakeCharacter();
    npc.type = "npc";
    await rejects(run(npc, request({ hp: 5 })), "binding_conflict");
  });
});

describe("pf2e.resources.v1 counters", () => {
  it("clamps hit points to max minus unrecoverable, with a warning", async () => {
    const actor = fakeCharacter();
    (
      actor.system.attributes as { hp: Record<string, number> }
    ).hp.unrecoverable = 4;
    const result = await run(actor, request({ hp: 99 }));
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(26);
    expect(result.warnings).toEqual(["resource_clamped:hp"]);
  });

  it("writes temporary hit points as an absolute value", async () => {
    const actor = fakeCharacter();
    (actor.system.attributes as { hp: Record<string, number> }).hp.temp = 8;
    await run(actor, request({ hpTemp: 3 }));
    expect(actor.updates[0]["system.attributes.hp.temp"]).toBe(3);
  });

  it("clamps hero points to the prepared max, and to 0 for a mythic character", async () => {
    const actor = fakeCharacter([], { heroMax: 3 });
    let result = await run(actor, request({ heroPoints: 3 }));
    expect(actor.updates[0]["system.resources.heroPoints.value"]).toBe(3);
    expect(result.warnings).toEqual([]);

    const mythic = fakeCharacter([], { heroMax: 0 });
    result = await run(mythic, request({ heroPoints: 2 }));
    expect(mythic.updates[0]["system.resources.heroPoints.value"]).toBe(0);
    expect(result.warnings).toEqual(["hero_points_max"]);
  });

  it("writes only the values that differ, in one update, and never prepared values", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ hp: 20, hpTemp: 2, heroPoints: 1 }));
    expect(actor.update).toHaveBeenCalledTimes(1);
    const keys = Object.keys(actor.updates[0]);
    expect(keys.filter((k) => !k.startsWith("flags."))).toEqual([
      "system.attributes.hp.temp",
    ]);
    expect(keys.some((k) => /abilities|level|\.max$/.test(k))).toBe(false);
  });
});

describe("pf2e.resources.v1 conditions", () => {
  it("creates an absent condition at its value", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ conditions: { frightened: 2, prone: 1 } }));
    expect(actor.increaseCondition.mock.calls).toEqual([
      ["frightened", { value: 2 }],
      ["prone", { value: 1 }],
    ]);
    expect(held(actor)).toEqual(["frightened:2", "prone:null"]);
  });

  it("raises and lowers a held condition by item id, never by slug", async () => {
    const f = condition("frightened", 1);
    const c = condition("clumsy", 3);
    const actor = fakeCharacter([f, c]);
    await run(actor, request({ conditions: { frightened: 3, clumsy: 1 } }));
    expect(conditionManager.updateConditionValue.mock.calls).toEqual([
      [c._id, actor, 1],
      [f._id, actor, 3],
    ]);
    expect(actor.increaseCondition).not.toHaveBeenCalled();
    expect(actor.decreaseCondition).not.toHaveBeenCalled();
    expect(held(actor)).toEqual(["clumsy:1", "frightened:3"]);
  });

  it("removes a condition set to 0 and leaves an unvalued held one alone", async () => {
    const actor = fakeCharacter([
      condition("frightened", 2),
      condition("prone"),
    ]);
    await run(actor, request({ conditions: { frightened: 0, prone: 1 } }));
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(conditionManager.updateConditionValue).not.toHaveBeenCalled();
    expect(held(actor)).toEqual(["prone:null"]);
  });

  it("leaves a slug the map does not name alone", async () => {
    const actor = fakeCharacter([condition("sickened", 1)]);
    await run(actor, request({ conditions: {}, hp: 5 }));
    expect(held(actor)).toEqual(["sickened:1"]);
  });

  it("never touches a locked or granted condition, and warns", async () => {
    const granted = condition("frightened", 1, {
      flags: { pf2e: { grantedBy: { id: "featAAAAAAAAAAAA" } } },
    });
    const child = condition("off-guard", null);
    child.system.references = { parent: { id: "condBBBBBBBBBBBB" } };
    const locked = condition("prone", null, { isLocked: true });
    const actor = fakeCharacter([granted, child, locked]);
    const result = await run(
      actor,
      request({ conditions: { frightened: 3, "off-guard": 0, prone: 0 } }),
    );
    expect(actor.increaseCondition).not.toHaveBeenCalled();
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    expect(conditionManager.updateConditionValue).not.toHaveBeenCalled();
    expect(actor.items.contents).toEqual([granted, child, locked]);
    expect(result.warnings).toEqual([
      "condition_locked:frightened",
      "condition_locked:off-guard",
      "condition_locked:prone",
    ]);
  });

  it("warns when pf2e refuses a condition (immunity), and does not re-send it", async () => {
    const actor = fakeCharacter([], { immune: ["frightened"] });
    const first = await run(
      actor,
      request({ sequence: 1, conditions: { frightened: 1 } }),
    );
    expect(first.warnings).toEqual(["condition_refused:frightened"]);
    const second = await run(
      actor,
      request({ sequence: 2, conditions: { frightened: 1 } }),
    );
    expect(second.warnings).toEqual(["condition_refused:frightened"]);
    expect(actor.increaseCondition).toHaveBeenCalledTimes(1);
    expect(actor.update).toHaveBeenCalledTimes(1);
  });

  it("caps dying, wounded and doomed at their prepared max", async () => {
    const dying = condition("dying", 1);
    const actor = fakeCharacter([dying]);
    await run(actor, request({ conditions: { dying: 9, wounded: 7 } }));
    expect(held(actor)).toEqual(["dying:4", "wounded:3"]);
    expect(actor.increaseCondition).toHaveBeenCalledWith("wounded", {
      value: 3,
    });
  });

  it("a retry after a failed condition write finishes the write", async () => {
    const actor = fakeCharacter();
    const impl = actor.increaseCondition.getMockImplementation()!;
    actor.increaseCondition.mockImplementationOnce(impl);
    actor.increaseCondition.mockImplementationOnce(async () => {
      throw new Error("socket lost");
    });
    const req = request({ hp: 4, conditions: { frightened: 2, prone: 1 } });
    await expect(run(actor, req)).rejects.toThrow("socket lost");
    expect(actor.update).not.toHaveBeenCalled();
    await run(actor, req);
    expect(held(actor)).toEqual(["frightened:2", "prone:null"]);
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(4);
  });
});

describe("pf2e.resources.v1 items", () => {
  it("sets a mirrored item's quantity and deletes one set to 0", async () => {
    const arrows = item("ammo", { slug: "arrows", quantity: 20 });
    const rope = item("equipment", { slug: "rope", quantity: 1 });
    const actor = fakeCharacter([arrows, rope]);
    const result = await run(
      actor,
      request({ items: { [arrows._id]: 12, [rope._id]: 0 } }),
    );
    expect(arrows.update).toHaveBeenCalledWith({ "system.quantity": 12 });
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", [
      rope._id,
    ]);
    expect(actor.items.contents).toEqual([arrows]);
    expect(result.warnings).toEqual([]);
  });

  it("deleting a container is not fatal: its contents are ejected, with a warning", async () => {
    const pack = item("backpack", { slug: "backpack", quantity: 1 });
    const torch = item("equipment", {
      slug: "torch",
      quantity: 2,
      containerId: pack._id,
    });
    const actor = fakeCharacter([pack, torch]);
    const result = await run(actor, request({ items: { [pack._id]: 0 } }));
    expect(actor.items.contents).toEqual([torch]);
    expect(torch.system.containerId).toBeNull();
    expect(result.warnings).toEqual([`container_ejected:${pack._id}`]);
  });

  it("never touches a missing, non-physical or coin item", async () => {
    const feat = item("feat", { slug: "power-attack" });
    const coins = item("treasure", {
      slug: "gold-pieces",
      category: "coin",
      quantity: 5,
    });
    const actor = fakeCharacter([feat, coins]);
    const result = await run(
      actor,
      request({
        items: { [feat._id]: 0, [coins._id]: 0, missing000000001: 0 },
      }),
    );
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    expect(coins.update).not.toHaveBeenCalled();
    expect(result.warnings.sort()).toEqual(
      [
        `item_unavailable:${feat._id}`,
        `item_unavailable:${coins._id}`,
        "item_unavailable:missing000000001",
      ].sort(),
    );
  });

  it("adds a catalog item by slug, flagged with its key, without stacking", async () => {
    const owned = item("weapon", { slug: "longsword", quantity: 1 });
    const actor = fakeCharacter([owned]);
    const result = await run(
      actor,
      request({ adds: [{ key: KEY_A, slug: "longsword", quantity: 2 }] }),
    );
    expect(actor.inventory.add).not.toHaveBeenCalled();
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(actor.items.contents).toHaveLength(2);
    expect(owned.system.quantity).toBe(1);
    const made = actor.items.contents[1];
    expect(made.system).toMatchObject({ slug: "longsword", quantity: 2 });
    expect(made.flags[MODULE_ID]).toEqual({ appInstanceId: KEY_A });
    expect(result.created).toEqual({ [KEY_A]: made._id });
  });

  it("an add is idempotent by its key", async () => {
    const mine = item(
      "weapon",
      { slug: "longsword", quantity: 1 },
      {
        flags: { [MODULE_ID]: { appInstanceId: KEY_A } },
      },
    );
    const actor = fakeCharacter([mine]);
    const result = await run(
      actor,
      request({ adds: [{ key: KEY_A, slug: "longsword", quantity: 1 }] }),
    );
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(result.created).toEqual({ [KEY_A]: mine._id });
  });

  it("skips a ChoiceSet item and an unknown slug, with warnings", async () => {
    const actor = fakeCharacter();
    const result = await run(
      actor,
      request({
        adds: [
          { key: KEY_A, slug: "gloves-of-choice", quantity: 1 },
          { key: KEY_B, slug: "no-such-thing", quantity: 1 },
        ],
      }),
    );
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(result.created).toEqual({});
    expect(result.warnings).toEqual([
      "item_skipped_choiceset:gloves-of-choice",
      "item_not_found:no-such-thing",
    ]);
  });
});

describe("pf2e.resources.v1 convergence", () => {
  it("replays the same sequence without writing, created map included", async () => {
    const actor = fakeCharacter();
    const req = request({
      hp: 5,
      conditions: { prone: 1 },
      adds: [{ key: KEY_A, slug: "rope", quantity: 1 }],
    });
    const first = await run(actor, req);
    const second = await run(actor, req);
    expect(second).toEqual(first);
    expect(Object.keys(second.created)).toEqual([KEY_A]);
    expect(actor.update).toHaveBeenCalledTimes(1);
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
  });

  it("refuses an older sequence and a same-sequence edit", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ sequence: 5, hp: 5 }));
    await rejects(
      run(actor, request({ sequence: 4, hp: 6 })),
      "stale_revision",
    );
    await rejects(
      run(actor, request({ sequence: 5, hp: 6 })),
      "revision_conflict",
    );
  });

  it("a new sequence re-sending recorded values writes nothing", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ sequence: 1, hp: 5, conditions: { prone: 1 } }));
    await run(actor, request({ sequence: 2, hp: 5, conditions: { prone: 1 } }));
    expect(actor.update).toHaveBeenCalledTimes(1);
    expect(actor.increaseCondition).toHaveBeenCalledTimes(1);
  });

  it("writes the result flag last, in the counters update", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ hp: 5, conditions: { prone: 1 } }));
    const flag = actor.updates[0][`flags.${MODULE_ID}.pf2eResourcesV1`];
    expect(flag).toMatchObject({
      schemaVersion: 1,
      outcome: "updated",
      appliedRevision: 3,
      created: {},
      warnings: [],
    });
    expect(actor.increaseCondition.mock.invocationCallOrder[0]).toBeLessThan(
      actor.update.mock.invocationCallOrder[0],
    );
  });
});

describe("pf2e.resources.v1 base (compare-and-set)", () => {
  it("validates base with the counters' keys and bounds, never adds", () => {
    expect(
      validatePf2eActorResourcesV1(
        request({ hp: 5, base: { hp: 20, conditions: { prone: 1 } } }),
      ).base,
    ).toEqual({ hp: 20, conditions: { prone: 1 } });
    for (const [base, path] of [
      [{ adds: [] }, "base.adds"],
      [{ heroPoints: 4 }, "base.heroPoints"],
      [{ conditions: { dazed: 1 } }, "base.conditions.dazed"],
      [{ items: { short: 1 } }, "base.items.short"],
    ] as const)
      expect(() =>
        validatePf2eActorResourcesV1(request({ hp: 5, base: base as never })),
      ).toThrow(path);
  });

  it("writes when Foundry still holds the base", async () => {
    const potion = item("consumable", { slug: "potion", quantity: 1 });
    const actor = fakeCharacter([potion, condition("prone")]);
    await run(
      actor,
      request({
        hp: 15,
        items: { [potion._id]: 0 },
        conditions: { prone: 0 },
        base: { hp: 20, items: { [potion._id]: 1 }, conditions: { prone: 1 } },
      }),
    );
    expect(actor.items.contents).toEqual([]);
    expect(actor.updates[0]).toMatchObject({
      "system.attributes.hp.value": 15,
    });
  });

  it("refuses everything with base_conflict when the GM refilled an item the app deletes", async () => {
    const potion = item("consumable", { slug: "potion", quantity: 3 });
    const actor = fakeCharacter([potion]);
    const pending = run(
      actor,
      request({
        hp: 15,
        items: { [potion._id]: 0 },
        base: { hp: 20, items: { [potion._id]: 1 } },
      }),
    );
    await rejects(pending, "base_conflict");
    await expect(pending).rejects.toThrow(`items.${potion._id}`);
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    expect(actor.updates).toHaveLength(0);
    expect(actor.items.contents).toEqual([potion]);
  });

  it("refuses when a condition value moved in Foundry, reading an absent one as 0", async () => {
    const actor = fakeCharacter([condition("frightened", 2)]);
    await rejects(
      run(
        actor,
        request({
          conditions: { frightened: 0 },
          base: { conditions: { frightened: 1 } },
        }),
      ),
      "base_conflict",
    );
    expect(held(actor)).toEqual(["frightened:2"]);
    // The GM removed sickened in Foundry: the app re-adding it is refused.
    await rejects(
      run(
        fakeCharacter(),
        request({
          conditions: { sickened: 2 },
          base: { conditions: { sickened: 1 } },
        }),
      ),
      "base_conflict",
    );
  });

  it("ignores a base for a value the request does not write", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ hp: 15, base: { hp: 20, heroPoints: 3 } }));
    expect(actor.updates[0]).toMatchObject({
      "system.attributes.hp.value": 15,
    });
  });

  it("without a base writes over a Foundry edit, as before", async () => {
    const potion = item("consumable", { slug: "potion", quantity: 3 });
    const actor = fakeCharacter([potion]);
    await run(actor, request({ items: { [potion._id]: 0 } }));
    expect(actor.items.contents).toEqual([]);
  });

  it("accepts a base read before the app's own previous write landed, not a later Foundry edit", async () => {
    const potion = item("consumable", { slug: "potion", quantity: 3 });
    const actor = fakeCharacter([potion]);
    const base = { items: { [potion._id]: 3 } };
    await run(
      actor,
      request({ sequence: 3, items: { [potion._id]: 2 }, base }),
    );
    await run(
      actor,
      request({ sequence: 4, items: { [potion._id]: 1 }, base }),
    );
    expect(potion.system.quantity).toBe(1);
    potion.system.quantity = 5;
    await rejects(
      run(actor, request({ sequence: 5, items: { [potion._id]: 0 }, base })),
      "base_conflict",
    );
    expect(potion.system.quantity).toBe(5);
  });
});
