import { afterEach, describe, expect, it, vi } from "vitest";
import {
  customAddSource,
  pf2eResourcesV1,
  validatePf2eActorResourcesV1,
  type Pf2eActorResourcesV1,
} from "../src/procedures/pf2eResources.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import { hasFixturePath } from "./support/actorUpsertHarness.js";
import FIXTURE from "./fixtures/pf2e-8.6.1-character.json";
import PLAN from "./fixtures/pf2e-sheet-writes-plan.json";

// SYNTHETIC, shape-only: a prepared pf2e `character` (the fixture's actor
// system), its condition items and
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
      ...structuredClone(FIXTURE.actor.system),
      resources: { heroPoints: { value: 1, max: heroMax } },
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
      // pf2e's currency APIs on a plain purse (source-derived, pf2e 8.5.1 and
      // 8.6.1 actor/inventory/index.ts): add to the first stack of the
      // denomination or create one; remove exactly that denomination, or
      // answer false and write nothing.
      addCurrency: vi.fn(async (coins: Record<string, number>) => {
        for (const [d, q] of Object.entries(coins)) {
          const stack = coinStacks(actor.items.contents, d)[0];
          if (stack) stack.system.quantity = Number(stack.system.quantity) + q;
          else actor.items.contents.push(coin(d, q));
        }
      }),
      removeCurrency: vi.fn(
        async (coins: Record<string, number>, _o: { byValue: boolean }) => {
          for (const [d, q] of Object.entries(coins)) {
            const held = coinStacks(actor.items.contents, d).reduce(
              (n, i) => n + Number(i.system.quantity),
              0,
            );
            if (held < q) return false;
          }
          for (const [d, q] of Object.entries(coins)) {
            let left = q;
            for (const stack of coinStacks(actor.items.contents, d)) {
              const take = Math.min(left, Number(stack.system.quantity));
              stack.system.quantity = Number(stack.system.quantity) - take;
              left -= take;
              if (stack.system.quantity === 0)
                actor.items.contents.splice(
                  actor.items.contents.indexOf(stack),
                  1,
                );
            }
          }
          return true;
        },
      ),
    },
  };
  return actor;
}
type FakeCharacter = ReturnType<typeof fakeCharacter>;

function coin(
  denomination: string,
  quantity: number,
  extra: Record<string, unknown> = {},
): FakeItem {
  return item("treasure", {
    category: "coin",
    quantity,
    price: { value: { [denomination]: 1 } },
    containerId: null,
    ...extra,
  });
}

const coinStacks = (items: FakeItem[], d: string) =>
  items.filter(
    (i) =>
      i.type === "treasure" &&
      i.system.category === "coin" &&
      (i.system.price as { value: Record<string, number> }).value[d] === 1,
  );

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

describe("pf2e.resources.v1 on the sanitized pf2e 8.6.1 character", () => {
  it("writes only paths the character's data model has", async () => {
    const items = FIXTURE.actor.items.map((i) =>
      item(i.type, structuredClone(i.system) as Record<string, unknown>, {
        _id: i._id,
      }),
    );
    const mirrored = items[1];
    const actor = fakeCharacter(items);
    stubWorld([actor], {
      version: FIXTURE.systemVersion,
      generation: FIXTURE.foundryGeneration,
    });
    const result = (await pf2eResourcesV1(
      request({
        hp: 25,
        hpTemp: 2,
        heroPoints: 2,
        conditions: { frightened: 0 },
        items: { pf2eequipment001: 3 },
      }),
      {} as never,
    )) as Result;

    const written = actor.updates.flatMap((u) => Object.keys(u));
    expect(written.length).toBeGreaterThanOrEqual(3);
    for (const key of written.filter((k) => k.startsWith("system.")))
      expect(hasFixturePath(FIXTURE.actor, key), key).toBe(true);
    const [, equipment] = FIXTURE.actor.items;
    expect(mirrored.update).toHaveBeenCalledWith({ "system.quantity": 3 });
    expect(hasFixturePath(equipment, "system.quantity")).toBe(true);
    expect(held(actor)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

// The sheet groups (`pf2eSheetWritesV1`): purse, custom adds, spellcasting.

const KEY_C = "0b6f4a0e-3c1d-4f6e-9a7b-2c8d1e5f6a03";
const ENTRY = "entryPrepared001";
const INNATE = "entryInnate00001";
const SPELL = "spellPrepared001";
const OTHER_SPELL = "spellPrepared002";
const INNATE_SPELL = "spellInnate00001";

const customAdd = (overrides: Record<string, unknown> = {}) => ({
  key: KEY_C,
  name: "Lucky <coin> & charm",
  itemType: "equipment",
  quantity: 2,
  level: 3,
  priceCopper: 1234,
  bulkTenths: 1,
  rarity: "uncommon",
  notes: "Found in a well.\n\nIt hums at night.",
  ...overrides,
});

function spellcaster(extra: FakeItem[] = []) {
  const entry = item(
    "spellcastingEntry",
    {
      prepared: { value: "prepared", flexible: false },
      slots: {
        slot0: { max: 5, value: 0, prepared: [] },
        slot1: {
          max: 2,
          value: 0,
          prepared: [
            { id: SPELL, expended: false },
            { id: null, expended: false },
          ],
        },
        slot2: { max: 1, value: 0, prepared: [] },
      },
    },
    { _id: ENTRY },
  );
  const innate = item(
    "spellcastingEntry",
    { prepared: { value: "innate" }, slots: {} },
    { _id: INNATE },
  );
  const spells = [
    item("spell", { location: { value: ENTRY } }, { _id: SPELL }),
    item("spell", { location: { value: ENTRY } }, { _id: OTHER_SPELL }),
    item(
      "spell",
      { location: { value: INNATE, uses: { value: 1, max: 3 } } },
      { _id: INNATE_SPELL },
    ),
  ];
  const actor = fakeCharacter([entry, innate, ...spells, ...extra]);
  (actor.system.resources as Record<string, unknown>).focus = {
    value: 1,
    max: 2,
    cap: 3,
  };
  return { actor, entry, innate, spells };
}

const purse = (actor: FakeCharacter) =>
  Object.fromEntries(
    ["pp", "gp", "sp", "cp"].map((d) => [
      d,
      coinStacks(actor.items.contents, d).reduce(
        (n, i) => n + Number(i.system.quantity),
        0,
      ),
    ]),
  );

describe("pf2e.resources.v1 sheet groups validation", () => {
  const prepared = (n: number) =>
    Array.from({ length: n }, () => ({ id: null, expended: false }));
  const entries17 = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [
      `entry${String(i).padStart(11, "0")}`,
      {},
    ]),
  );
  const innate101 = Object.fromEntries(
    Array.from({ length: 101 }, (_, i) => [
      `spell${String(i).padStart(11, "0")}`,
      1,
    ]),
  );
  it.each([
    ["an empty purse", { coins: {} }],
    ["a credits denomination", { coins: { credits: 1 } }],
    ["a purse total above 999999", { coins: { gp: 1_000_000 } }],
    ["a negative purse total", { coins: { cp: -1 } }],
    ["a fractional purse total", { coins: { sp: 1.5 } }],
    ["customAdds that are not an array", { customAdds: customAdd() }],
    ["more than 50 customAdds", { customAdds: Array(51).fill(customAdd()) }],
    [
      "a customAdd with an extra key",
      { customAdds: [customAdd({ slug: "x" })] },
    ],
    [
      "a customAdd without a key",
      { customAdds: [customAdd({ key: undefined })] },
    ],
    [
      "an uppercase customAdd key",
      { customAdds: [customAdd({ key: KEY_C.toUpperCase() })] },
    ],
    ["a blank name", { customAdds: [customAdd({ name: "  " })] }],
    [
      "a name above 120 characters",
      { customAdds: [customAdd({ name: "é".repeat(121) })] },
    ],
    [
      "a name with a control character",
      { customAdds: [customAdd({ name: "a\u0007b" })] },
    ],
    ["a name with a line feed", { customAdds: [customAdd({ name: "a\nb" })] }],
    [
      "a name with a C1 control",
      { customAdds: [customAdd({ name: "a\u0085b" })] },
    ],
    ["a weapon itemType", { customAdds: [customAdd({ itemType: "weapon" })] }],
    ["a quantity 0", { customAdds: [customAdd({ quantity: 0 })] }],
    [
      "a quantity above 999999",
      { customAdds: [customAdd({ quantity: 1_000_000 })] },
    ],
    ["a level above 30", { customAdds: [customAdd({ level: 31 })] }],
    [
      "a price above 10^9 copper",
      { customAdds: [customAdd({ priceCopper: 1_000_000_001 })] },
    ],
    [
      "a bulk above 10^6 tenths",
      { customAdds: [customAdd({ bulkTenths: 1_000_001 })] },
    ],
    ["an unknown rarity", { customAdds: [customAdd({ rarity: "mythic" })] }],
    [
      "notes above 4000 characters",
      { customAdds: [customAdd({ notes: "x".repeat(4001) })] },
    ],
    [
      "notes with a control character",
      { customAdds: [customAdd({ notes: "a\u0000b" })] },
    ],
    ["notes with a bell", { customAdds: [customAdd({ notes: "a\u0007b" })] }],
    [
      "a key shared by an add and a customAdd",
      {
        adds: [{ key: KEY_C, slug: "rope", quantity: 1 }],
        customAdds: [customAdd()],
      },
    ],
    ["a duplicate customAdd key", { customAdds: [customAdd(), customAdd()] }],
    ["an empty spellcasting", { spellcasting: {} }],
    ["an unknown spellcasting member", { spellcasting: { slots: {} } }],
    ["entries as an array", { spellcasting: { entries: [] } }],
    ["more than 16 entries", { spellcasting: { entries: entries17 } }],
    ["a malformed entry id", { spellcasting: { entries: { short: {} } } }],
    [
      "rank 11",
      { spellcasting: { entries: { [ENTRY]: { "11": { value: 1 } } } } },
    ],
    [
      "a rank with an extra key",
      { spellcasting: { entries: { [ENTRY]: { "1": { max: 1 } } } } },
    ],
    [
      "a slot value above 99",
      { spellcasting: { entries: { [ENTRY]: { "1": { value: 100 } } } } },
    ],
    [
      "more than 30 prepared slots",
      {
        spellcasting: {
          entries: { [ENTRY]: { "1": { prepared: prepared(31) } } },
        },
      },
    ],
    [
      "a malformed prepared spell id",
      {
        spellcasting: {
          entries: {
            [ENTRY]: { "1": { prepared: [{ id: "short", expended: false }] } },
          },
        },
      },
    ],
    [
      "a prepared slot without expended",
      {
        spellcasting: {
          entries: { [ENTRY]: { "1": { prepared: [{ id: null }] } } },
        },
      },
    ],
    [
      "a prepared slot with an extra key",
      {
        spellcasting: {
          entries: {
            [ENTRY]: {
              "1": { prepared: [{ id: null, expended: false, x: 1 }] },
            },
          },
        },
      },
    ],
    ["focus above 3", { spellcasting: { focus: 4 } }],
    [
      "more than 100 innate spells",
      { spellcasting: { innateUses: innate101 } },
    ],
    [
      "innate uses above 99",
      { spellcasting: { innateUses: { [INNATE_SPELL]: 100 } } },
    ],
    [
      "a malformed innate spell id",
      { spellcasting: { innateUses: { short: 1 } } },
    ],
  ])("refuses %s", (_label, overrides) => {
    expect(() =>
      validatePf2eActorResourcesV1(request(overrides as never)),
    ).toThrow(RpcError);
  });

  it("accepts every sheet group at its bounds, each alone as the one value", () => {
    const req = validatePf2eActorResourcesV1(
      request({
        coins: { pp: 999_999, gp: 0, sp: 0, cp: 999_999 },
        customAdds: [
          customAdd({
            name: "😀".repeat(120),
            itemType: "treasure",
            quantity: 999_999,
            level: 30,
            priceCopper: 1_000_000_000,
            bulkTenths: 1_000_000,
            rarity: "unique",
            notes: "\t".repeat(4000),
          }),
          customAdd({
            key: KEY_A,
            itemType: "backpack",
            notes: undefined,
            level: 0,
            priceCopper: 0,
            bulkTenths: 0,
          }),
        ],
        spellcasting: {
          entries: {
            [ENTRY]: {
              "0": { prepared: prepared(30) },
              "10": { value: 99, prepared: [{ id: SPELL, expended: true }] },
            },
          },
          focus: 3,
          innateUses: { [INNATE_SPELL]: 99 },
        },
      } as never),
    );
    expect(req.customAdds).toHaveLength(2);
    expect(req.customAdds![1].notes).toBeUndefined();
    for (const one of [
      { coins: { gp: 1 } },
      { customAdds: [customAdd()] },
      { spellcasting: { focus: 0 } },
      { spellcasting: { innateUses: {} } },
      { spellcasting: { entries: {} } },
    ])
      expect(() =>
        validatePf2eActorResourcesV1(request(one as never)),
      ).not.toThrow();
  });

  it("takes coins and spellcasting in base, never customAdds", () => {
    expect(
      validatePf2eActorResourcesV1(
        request({
          coins: { gp: 5 },
          base: { coins: { gp: 4 }, spellcasting: { focus: 1 } },
        } as never),
      ).base,
    ).toEqual({ coins: { gp: 4 }, spellcasting: { focus: 1 } });
    for (const [base, path] of [
      [{ customAdds: [] }, "base.customAdds"],
      [{ coins: {} }, "base.coins"],
      [{ coins: { gp: 1_000_000 } }, "base.coins.gp"],
      [{ spellcasting: { focus: 4 } }, "base.spellcasting.focus"],
      [{ spellcasting: {} }, "base.spellcasting"],
    ] as const)
      expect(() =>
        validatePf2eActorResourcesV1(
          request({ coins: { gp: 5 }, base: base as never } as never),
        ),
      ).toThrow(path);
  });
});

describe("pf2e.resources.v1 purse", () => {
  it("moves each named denomination to its target, pp to cp, by add or exact remove", async () => {
    const actor = fakeCharacter([coin("gp", 10), coin("sp", 3), coin("cp", 9)]);
    const result = await run(
      actor,
      request({ coins: { pp: 2, gp: 4, sp: 3, cp: 0 } } as never),
    );
    expect(purse(actor)).toEqual({ pp: 2, gp: 4, sp: 3, cp: 0 });
    expect(actor.inventory.addCurrency.mock.calls).toEqual([[{ pp: 2 }]]);
    expect(actor.inventory.removeCurrency.mock.calls).toEqual([
      [{ gp: 6 }, { byValue: false }],
      [{ cp: 9 }, { byValue: false }],
    ]);
    expect(result.warnings).toEqual([]);
    expect(
      actor.inventory.removeCurrency.mock.invocationCallOrder[1],
    ).toBeLessThan(actor.update.mock.invocationCallOrder[0]);
  });

  it("counts a legacy coin stack in the total, as a coin pf2e cannot address", async () => {
    const legacy = item("treasure", {
      stackGroup: "coins",
      quantity: 4,
      price: { value: { gp: 1 } },
    });
    const actor = fakeCharacter([legacy, coin("gp", 1)]);
    const result = await run(actor, request({ coins: { gp: 9 } } as never));
    expect(result.warnings).toEqual(["coins_unaddressable"]);
    expect(actor.inventory.addCurrency).not.toHaveBeenCalled();
    // Still a coin: never a quantity write through items, and in the base
    // compare's total (5 gp) — where its purse reads as unwritable.
    const viaItems = await run(
      actor,
      request({ sequence: 4, items: { [legacy._id]: 1 } }),
    );
    expect(viaItems.warnings).toEqual([`item_unavailable:${legacy._id}`]);
  });

  it("reads a stale container id as no container, as pf2e does", async () => {
    const actor = fakeCharacter([
      coin("gp", 4, { containerId: "goneBag000000001" }),
    ]);
    const result = await run(actor, request({ coins: { gp: 5 } } as never));
    expect(result.warnings).toEqual([]);
    expect(actor.inventory.addCurrency).toHaveBeenCalledWith({ gp: 1 });
  });

  it("warns coins_refused when pf2e cannot remove the denomination", async () => {
    const actor = fakeCharacter([coin("gp", 5)]);
    actor.inventory.removeCurrency.mockResolvedValueOnce(false);
    const result = await run(actor, request({ coins: { gp: 1 } } as never));
    expect(result.warnings).toEqual(["coins_refused:gp"]);
    expect(purse(actor).gp).toBe(5);
  });

  it.each([
    [
      "a stack priced in two denominations",
      coin("gp", 4, { price: { value: { gp: 1, sp: 5 } } }),
    ],
    [
      "a stack sold per 10",
      coin("gp", 4, { price: { value: { gp: 1 }, per: 10 } }),
    ],
    [
      "a stack worth 2 gp a coin",
      coin("gp", 4, { price: { value: { gp: 2 } } }),
    ],
    ["a stack with no denomination", coin("gp", 4, { price: { value: {} } })],
    [
      "a stack in a container",
      coin("gp", 4, { containerId: "bag0000000000001" }),
    ],
  ])("skips the whole purse as unaddressable with %s", async (_label, odd) => {
    const bag = item("backpack", { quantity: 1 }, { _id: "bag0000000000001" });
    const actor = fakeCharacter([coin("sp", 1), odd, bag]);
    const result = await run(
      actor,
      request({ coins: { sp: 9 }, hp: 5 } as never),
    );
    expect(result.warnings).toEqual(["coins_unaddressable"]);
    expect(actor.inventory.addCurrency).not.toHaveBeenCalled();
    expect(actor.inventory.removeCurrency).not.toHaveBeenCalled();
    expect(actor.updates[0]).toMatchObject({ "system.attributes.hp.value": 5 });
  });

  it("reads the stored price, not the one pf2e prepared", async () => {
    // pf2e prepares every coin to one unit of one denomination; the source
    // keeps the mixed price the app imported.
    const mixed = coin("gp", 4);
    Object.assign(mixed, {
      _source: {
        system: { ...mixed.system, price: { value: { gp: 1, sp: 5 } } },
      },
    });
    const actor = fakeCharacter([mixed]);
    const result = await run(actor, request({ coins: { gp: 1 } } as never));
    expect(result.warnings).toEqual(["coins_unaddressable"]);
  });

  it("refuses a purse write as unsupported_runtime without pf2e's currency APIs", async () => {
    const actor = fakeCharacter([coin("gp", 1)]);
    (actor.inventory as Record<string, unknown>).addCurrency = undefined;
    await rejects(
      run(actor, request({ coins: { gp: 2 } } as never)),
      "unsupported_runtime",
    );
    expect(actor.update).not.toHaveBeenCalled();
    // A request without coins does not need them.
    await run(actor, request({ hp: 5 }));
    expect(actor.update).toHaveBeenCalled();
  });

  it("still refuses coins through items", async () => {
    const gp = coin("gp", 3);
    const actor = fakeCharacter([gp]);
    const result = await run(actor, request({ items: { [gp._id]: 1 } }));
    expect(result.warnings).toEqual([`item_unavailable:${gp._id}`]);
  });

  it("compares base.coins per denomination, and passes the lane's own last write", async () => {
    const actor = fakeCharacter([coin("gp", 10)]);
    await run(
      actor,
      request({
        sequence: 3,
        coins: { gp: 8 },
        base: { coins: { gp: 10 } },
      } as never),
    );
    expect(purse(actor).gp).toBe(8);
    // Same stale base after the app's own write: not a conflict.
    await run(
      actor,
      request({
        sequence: 4,
        coins: { gp: 7 },
        base: { coins: { gp: 10 } },
      } as never),
    );
    expect(purse(actor).gp).toBe(7);
    // The GM spent coins in Foundry: refused, nothing written.
    coinStacks(actor.items.contents, "gp")[0].system.quantity = 2;
    await rejects(
      run(
        actor,
        request({
          sequence: 5,
          coins: { gp: 6 },
          hp: 5,
          base: { coins: { gp: 7, sp: 0 } },
        } as never),
      ),
      "base_conflict",
    );
    expect(purse(actor).gp).toBe(2);
    // A base for a denomination the request does not write is ignored.
    await run(
      actor,
      request({
        sequence: 6,
        coins: { gp: 2 },
        base: { coins: { sp: 9 } },
      } as never),
    );
  });
});

describe("pf2e.resources.v1 custom adds", () => {
  it("creates the item from its fields, flagged with its key, never stacked", async () => {
    const actor = fakeCharacter();
    const result = await run(
      actor,
      request({ customAdds: [customAdd()] } as never),
    );
    expect(actor.inventory.add).not.toHaveBeenCalled();
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledWith("Item", [
      {
        name: "Lucky <coin> & charm",
        type: "equipment",
        system: {
          quantity: 2,
          level: { value: 3 },
          price: { value: { gp: 12, sp: 3, cp: 4 } },
          bulk: { value: 0.1 },
          traits: { rarity: "uncommon" },
          description: {
            value: "<p>Found in a well.</p><p>It hums at night.</p>",
          },
        },
        flags: { [MODULE_ID]: { appInstanceId: KEY_C } },
      },
    ]);
    expect(result.created).toEqual({ [KEY_C]: actor.items.contents[0]._id });
  });

  it.each([
    [0, {}],
    [7, { cp: 7 }],
    [50, { sp: 5 }],
    [100_000, { gp: 1000 }],
    [1_000_000_000, { gp: 10_000_000 }],
  ])("maps %i copper to %j", (copper, value) => {
    expect(
      customAddSource(customAdd({ priceCopper: copper }) as never).system,
    ).toMatchObject({ price: { value } });
  });

  it.each([
    ["<b>x</b> & 'y'", "<p>&lt;b&gt;x&lt;/b&gt; &amp; &#39;y&#39;</p>"],
    ["a\r\n\r\nb\nc\n\n\n", "<p>a</p><p>b<br>c</p>"],
    ["  \n\n  ", ""],
    [undefined, ""],
  ])("writes the notes %j as the description %j", (notes, value) => {
    expect(
      (
        customAddSource(customAdd({ notes }) as never).system as Record<
          string,
          unknown
        >
      ).description,
    ).toEqual({ value });
  });

  it("is idempotent by its key, beside a catalog add in the same create", async () => {
    const mine = item(
      "equipment",
      { quantity: 1 },
      { flags: { [MODULE_ID]: { appInstanceId: KEY_C } } },
    );
    const actor = fakeCharacter([mine]);
    const result = await run(
      actor,
      request({
        adds: [{ key: KEY_A, slug: "rope", quantity: 1 }],
        customAdds: [customAdd(), customAdd({ key: KEY_B, name: "Twine" })],
      } as never),
    );
    expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    const sources = actor.createEmbeddedDocuments.mock.calls[0][1];
    expect(
      sources.map(
        (s: Record<string, unknown>) =>
          (s.flags as Record<string, { appInstanceId: string }>)[MODULE_ID]
            .appInstanceId,
      ),
    ).toEqual([KEY_A, KEY_B]);
    expect(Object.keys(result.created).sort()).toEqual(
      [KEY_A, KEY_B, KEY_C].sort(),
    );
    expect(result.created[KEY_C]).toBe(mine._id);
  });

  it("warns item_refused by key when Foundry drops the item", async () => {
    const actor = fakeCharacter();
    actor.createEmbeddedDocuments.mockResolvedValueOnce([]);
    const result = await run(
      actor,
      request({ customAdds: [customAdd()] } as never),
    );
    expect(result.warnings).toEqual([`item_refused:${KEY_C}`]);
    expect(result.created).toEqual({});
  });
});

describe("pf2e.resources.v1 spellcasting", () => {
  it("writes every rank of an entry in ONE update, only what moved, clamping to the slot max", async () => {
    const { actor, entry } = spellcaster();
    const result = await run(
      actor,
      request({
        spellcasting: {
          entries: {
            [ENTRY]: {
              "1": {
                value: 5,
                prepared: [
                  { id: SPELL, expended: true },
                  { id: OTHER_SPELL, expended: false },
                ],
              },
              "2": { value: 0, prepared: [] },
            },
          },
        },
      } as never),
    );
    expect(entry.update).toHaveBeenCalledTimes(1);
    expect(entry.update).toHaveBeenCalledWith({
      "system.slots.slot1.value": 2,
      "system.slots.slot1.prepared": [
        { id: SPELL, expended: true },
        { id: OTHER_SPELL, expended: false },
      ],
    });
    expect(result.warnings).toEqual([`spell_slot_clamped:${ENTRY}:1`]);
  });

  it("leaves a rank's prepared array alone when it names a spell of another entry", async () => {
    const stray = item(
      "spell",
      { location: { value: INNATE } },
      { _id: "spellStray000001" },
    );
    const { actor, entry } = spellcaster([stray]);
    const result = await run(
      actor,
      request({
        spellcasting: {
          entries: {
            [ENTRY]: {
              "1": {
                value: 1,
                prepared: [
                  { id: "spellStray000001", expended: false },
                  { id: "spellMissing0001", expended: false },
                  { id: "spellStray000001", expended: true },
                ],
              },
            },
          },
        },
      } as never),
    );
    expect(entry.update).toHaveBeenCalledWith({
      "system.slots.slot1.value": 1,
    });
    expect(result.warnings).toEqual([
      "spell_unavailable:spellStray000001",
      "spell_unavailable:spellMissing0001",
    ]);
  });

  it("warns spell_entry_unavailable for a missing entry or another item type", async () => {
    const { actor, spells } = spellcaster();
    const result = await run(
      actor,
      request({
        spellcasting: {
          entries: {
            missingEntry0001: { "1": { value: 1 } },
            [SPELL]: { "1": { value: 1 } },
          },
        },
      } as never),
    );
    expect(spells[0].update).not.toHaveBeenCalled();
    expect(result.warnings.sort()).toEqual(
      [
        "spell_entry_unavailable:missingEntry0001",
        `spell_entry_unavailable:${SPELL}`,
      ].sort(),
    );
  });

  it("folds focus into the one counters update, clamped to the prepared max", async () => {
    const { actor } = spellcaster();
    const result = await run(
      actor,
      request({ hp: 4, spellcasting: { focus: 3 } } as never),
    );
    expect(actor.update).toHaveBeenCalledTimes(1);
    expect(actor.updates[0]).toMatchObject({
      "system.attributes.hp.value": 4,
      "system.resources.focus.value": 2,
    });
    expect(result.warnings).toEqual(["focus_clamped"]);
  });

  it("writes innate uses on an innate spell, clamped to its max, and refuses any other spell", async () => {
    const { actor, spells } = spellcaster();
    const result = await run(
      actor,
      request({
        spellcasting: {
          innateUses: { [INNATE_SPELL]: 9, [SPELL]: 1, missingSpell0001: 1 },
        },
      } as never),
    );
    expect(spells[2].update).toHaveBeenCalledWith({
      "system.location.uses.value": 3,
    });
    expect(spells[0].update).not.toHaveBeenCalled();
    expect(result.warnings.sort()).toEqual(
      [
        `spell_uses_clamped:${INNATE_SPELL}`,
        `spell_unavailable:${SPELL}`,
        "spell_unavailable:missingSpell0001",
      ].sort(),
    );
  });

  it("compares base.spellcasting: a moved slot refuses, the stored prepared array passes", async () => {
    const { actor, entry } = spellcaster();
    const slots = entry.system.slots as Record<string, Record<string, unknown>>;
    const preparedNow = structuredClone(slots.slot1.prepared);
    await run(
      actor,
      request({
        spellcasting: {
          entries: {
            [ENTRY]: {
              "1": {
                prepared: [
                  { id: SPELL, expended: true },
                  { id: null, expended: false },
                ],
              },
            },
          },
        },
        base: {
          spellcasting: {
            entries: { [ENTRY]: { "1": { prepared: preparedNow } } },
          },
        },
      } as never),
    );
    expect(entry.update).toHaveBeenCalledTimes(1);
    slots.slot1.value = 1; // the GM spent a slot in Foundry
    await rejects(
      run(
        actor,
        request({
          sequence: 4,
          spellcasting: {
            entries: { [ENTRY]: { "1": { value: 2 } } },
            focus: 0,
          },
          base: {
            spellcasting: {
              entries: { [ENTRY]: { "1": { value: 0 } } },
              focus: 1,
            },
          },
        } as never),
      ),
      "base_conflict",
    );
    expect(slots.slot1.value).toBe(1);
    expect(
      (actor.system.resources as Record<string, { value: number }>).focus.value,
    ).toBe(1);
  });
});

describe("pf2e.resources.v1 focus base", () => {
  it("refuses a focus write when the GM moved focus in Foundry, and passes its own last write", async () => {
    const { actor } = spellcaster();
    const focus = () =>
      (actor.system.resources as Record<string, { value: number }>).focus;
    await run(
      actor,
      request({
        spellcasting: { focus: 0 },
        base: { spellcasting: { focus: 1 } },
      } as never),
    );
    expect(focus().value).toBe(0);
    await run(
      actor,
      request({
        sequence: 4,
        spellcasting: { focus: 2 },
        base: { spellcasting: { focus: 1 } },
      } as never),
    );
    expect(focus().value).toBe(2);
    focus().value = 1;
    await rejects(
      run(
        actor,
        request({
          sequence: 5,
          spellcasting: { focus: 0 },
          base: { spellcasting: { focus: 2 } },
        } as never),
      ),
      "base_conflict",
    );
    expect(focus().value).toBe(1);
  });
});

describe("pf2e.resources.v1 sheet groups order and convergence", () => {
  it("writes conditions, items, purse, spells, adds, then the one counters update", async () => {
    const potion = item("consumable", { slug: "potion", quantity: 3 });
    const { actor, entry } = spellcaster([potion, coin("gp", 1)]);
    await run(
      actor,
      request({
        hp: 3,
        conditions: { frightened: 1 },
        items: { [potion._id]: 1 },
        coins: { gp: 5 },
        spellcasting: { entries: { [ENTRY]: { "1": { value: 1 } } }, focus: 0 },
        customAdds: [customAdd()],
      } as never),
    );
    const order = [
      actor.increaseCondition,
      potion.update,
      actor.inventory.addCurrency,
      entry.update,
      actor.createEmbeddedDocuments,
      actor.update,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(actor.update).toHaveBeenCalledTimes(1);
  });

  it("a new sequence re-sending what Foundry holds writes nothing", async () => {
    const { actor, entry } = spellcaster([coin("gp", 1)]);
    const groups = {
      coins: { gp: 5 },
      spellcasting: {
        entries: { [ENTRY]: { "1": { value: 1 } } },
        innateUses: { [INNATE_SPELL]: 0 },
      },
      customAdds: [customAdd()],
    };
    await run(actor, request({ sequence: 3, ...groups } as never));
    actor.update.mockClear();
    entry.update.mockClear();
    actor.inventory.addCurrency.mockClear();
    actor.createEmbeddedDocuments.mockClear();
    const result = await run(
      actor,
      request({ sequence: 4, ...groups } as never),
    );
    expect(actor.update).not.toHaveBeenCalled();
    expect(entry.update).not.toHaveBeenCalled();
    expect(actor.inventory.addCurrency).not.toHaveBeenCalled();
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(Object.keys(result.created)).toEqual([KEY_C]);
  });
});

describe("pf2e.resources.v1 replays the shared sheet-writes plan vectors", () => {
  const SHEET_GROUPS = ["coins", "customAdds", "spellcasting"];
  const cases = PLAN.cases.filter((c) => c.request !== null);

  it("holds every plan case the apps send", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((c) => [c.id, c] as const))(
    "accepts the %s request",
    (_id, c) => {
      const body = request({ ...(c.request as object) } as never);
      const req = validatePf2eActorResourcesV1(body);
      const sent = Object.keys(c.request as object);
      // A sheet group, or its base, only with the module token.
      const tokened = c.capabilities.includes("pf2eSheetWritesV1");
      const base = Object.keys(
        ((c.request as Record<string, unknown>).base ?? {}) as object,
      );
      for (const g of SHEET_GROUPS) {
        if (!tokened) {
          expect(sent, g).not.toContain(g);
          expect(base, g).not.toContain(g);
        }
      }
      if (!c.capabilities.includes("writeBaseV1"))
        expect(sent).not.toContain("base");
      // The custom-add Foundry source mapping, exactly.
      const sources = c.foundrySource as Record<string, unknown>;
      expect(Object.keys(sources).sort()).toEqual(
        (req.customAdds ?? []).map((a) => a.key).sort(),
      );
      for (const add of req.customAdds ?? [])
        expect(customAddSource(add)).toEqual(sources[add.key]);
    },
  );
});
