import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dnd5eResourcesV1,
  validateDnd5eActorResourcesV1,
  type Dnd5eActorResourcesV1,
} from "../src/procedures/dnd5eResources.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";

// SYNTHETIC, shape-only: a prepared dnd5e `character` and its condition
// effects as the dnd5e 6.1.0 source describes them (source-derived, not a
// capture). Status effects carry dnd5e's static ids; a condition effect has
// `type: "condition"`, its primary id in `system.type`, and its implied ids
// in `statuses`.

const ACTOR_ID = "dnd5eActor000001";

interface FakeEffect {
  _id: string;
  type: string;
  system: { type?: string; level?: number | null };
  statuses: string[];
}

/** dnd5e pads `"dnd5e" + id` to 16 characters for its static ids. */
const staticId = (id: string) => ("dnd5e" + id).padEnd(16, "0").slice(0, 16);

const IMPLIED: Record<string, string[]> = {
  paralyzed: ["incapacitated"],
  petrified: ["incapacitated"],
  stunned: ["incapacitated"],
  unconscious: ["incapacitated"],
};

function conditionEffect(id: string, level: number | null = null): FakeEffect {
  return {
    _id: staticId(id),
    type: "condition",
    system: { type: id, level },
    statuses: [id, ...(IMPLIED[id] ?? [])],
  };
}

function setPath(root: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let at = root;
  for (const key of keys.slice(0, -1))
    at = (at[key] ??= {}) as Record<string, unknown>;
  at[keys[keys.length - 1]] = value;
}

function fakeCharacter(effects: FakeEffect[] = []) {
  const actor = {
    id: ACTOR_ID,
    name: "Fixture Warlock",
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
        hp: { value: 12, max: 20, temp: 0, tempmax: 0, effectiveMax: 20 },
        exhaustion: 0,
      },
      spells: {
        spell1: { value: 4, max: 4 },
        spell2: { value: 2, max: 3 },
        spell3: { value: 0, max: 0 },
        pact: { value: 1, max: 2 },
      },
    } as Record<string, unknown>,
    effects: { contents: effects },
    updates: [] as Record<string, unknown>[],
    toggles: [] as Array<[string, boolean]>,
    /** Core-derived: every effect's statuses, implied ids included. */
    get statuses(): Set<string> {
      return new Set(actor.effects.contents.flatMap((e) => e.statuses));
    },
    update: vi.fn(async (changes: Record<string, unknown>) => {
      actor.updates.push(changes);
      for (const [key, value] of Object.entries(changes))
        setPath(actor as unknown as Record<string, unknown>, key, value);
    }),
    // Core toggleStatusEffect over static ids, with dnd5e's override for a
    // levelled condition (exhaustion): it ignores `active` and adds a level.
    toggleStatusEffect: vi.fn(
      async (id: string, { active }: { active: boolean }) => {
        actor.toggles.push([id, active]);
        const list = actor.effects.contents;
        const at = list.findIndex((e) => e._id === staticId(id));
        if (id === "exhaustion") {
          if (at >= 0) list[at].system.level = (list[at].system.level ?? 0) + 1;
          else list.push(conditionEffect(id, 1));
          return;
        }
        if (at >= 0) {
          if (active) return true;
          list.splice(at, 1);
          return false;
        }
        if (!active) return;
        list.push(conditionEffect(id));
        return;
      },
    ),
  };
  return actor;
}
type FakeCharacter = ReturnType<typeof fakeCharacter>;

function stubWorld(
  actors: FakeCharacter[],
  { id = "dnd5e", version = "6.1.0", generation = 14, isGM = true } = {},
) {
  vi.stubGlobal("game", {
    user: { id: "gm", isGM },
    actors: {
      contents: actors,
      get: (actorId: string) => actors.find((a) => a.id === actorId),
    },
    system: { id, version },
    release: { generation },
  });
}

function request(
  overrides: Partial<Dnd5eActorResourcesV1> & Record<string, unknown> = {},
): Dnd5eActorResourcesV1 {
  return {
    schemaVersion: 1,
    actorType: "character",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    expectedActorId: ACTOR_ID,
    sequence: 3,
    ...overrides,
  } as Dnd5eActorResourcesV1;
}

const ALL_SLOTS = {
  spell1: 4,
  spell2: 2,
  spell3: 0,
  spell4: 0,
  spell5: 0,
  spell6: 0,
  spell7: 0,
  spell8: 0,
  spell9: 0,
  pact: 1,
};

async function run(actor: FakeCharacter, req: unknown) {
  stubWorld([actor]);
  return dnd5eResourcesV1(req, {} as never);
}

async function rejects(pending: unknown, code: string) {
  const promise = Promise.resolve(pending);
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code });
}

const held = (actor: FakeCharacter) =>
  actor.effects.contents.map((e) => e.system.type).sort();

afterEach(() => vi.unstubAllGlobals());

describe("dnd5e.resources.v1 validation", () => {
  it.each([
    ["an unknown key", { extra: 1, hp: 1 }],
    ["another actor type", { actorType: "npc", hp: 1 }],
    ["another schema version", { schemaVersion: 2, hp: 1 }],
    ["no group at all", {}],
    ["a negative hp", { hp: -1 }],
    ["a fractional hp", { hp: 1.5 }],
    ["a string hp", { hpTemp: "3" }],
    ["exhaustion above 6", { exhaustion: 7 }],
    ["a slot map missing a key", { slots: { ...ALL_SLOTS, pact: undefined } }],
    ["a slot map with an extra key", { slots: { ...ALL_SLOTS, spell10: 0 } }],
    ["a negative slot", { slots: { ...ALL_SLOTS, spell1: -1 } }],
    ["conditions that are not an array", { conditions: "prone" }],
    ["an unknown condition id", { conditions: ["prone", "bleeding"] }],
    ["exhaustion as a condition", { conditions: ["exhaustion"] }],
    ["concentrating as a condition", { conditions: ["concentrating"] }],
    ["a duplicate condition id", { conditions: ["prone", "prone"] }],
    ["a malformed actor id", { expectedActorId: "short", hp: 1 }],
    ["sequence 0", { sequence: 0, hp: 1 }],
  ])("refuses %s", (_label, overrides) => {
    expect(() =>
      validateDnd5eActorResourcesV1(request(overrides as never)),
    ).toThrow(RpcError);
  });

  it("accepts an empty condition set and every group", () => {
    const req = validateDnd5eActorResourcesV1(
      request({
        hp: 0,
        hpTemp: 0,
        slots: ALL_SLOTS,
        exhaustion: 6,
        conditions: [],
      }),
    );
    expect(req.conditions).toEqual([]);
    expect(req.slots).toEqual(ALL_SLOTS);
  });
});

describe("dnd5e.resources.v1 runtime gate", () => {
  it.each([
    ["dnd5e below the floor", { version: "6.0.9" }],
    ["a non-strict version", { version: "6.1.0-beta" }],
    ["Foundry 13", { generation: 13 }],
    ["another system", { id: "knight" }],
  ])("refuses %s as unsupported_runtime", async (_label, world) => {
    const actor = fakeCharacter();
    stubWorld([actor], world);
    await rejects(
      dnd5eResourcesV1(request({ hp: 5 }), {} as never),
      "unsupported_runtime",
    );
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("refuses a non-GM responder", async () => {
    const actor = fakeCharacter();
    stubWorld([actor], { isGM: false });
    await rejects(
      dnd5eResourcesV1(request({ hp: 5 }), {} as never),
      "permission_denied",
    );
  });
});

describe("dnd5e.resources.v1 actor resolution", () => {
  it("writes the unbound Actor the app names", async () => {
    const actor = fakeCharacter();
    actor.flags = {};
    await run(actor, request({ hp: 5 }));
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(5);
  });

  it("refuses a missing Actor, another binding, or a non-character", async () => {
    const gone = fakeCharacter();
    gone.flags = {};
    stubWorld([]);
    await rejects(
      dnd5eResourcesV1(request({ hp: 5 }), {} as never),
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

describe("dnd5e.resources.v1 counters", () => {
  it("clamps hit points to the prepared effective maximum", async () => {
    const actor = fakeCharacter();
    const result = await run(actor, request({ hp: 99 }));
    expect(actor.updates).toHaveLength(1);
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(20);
    expect(result).toMatchObject({
      outcome: "updated",
      appliedRevision: 3,
      warnings: ["resource_clamped:hp"],
    });
  });

  it("has no upper clamp without a prepared effective maximum", async () => {
    const actor = fakeCharacter();
    (
      actor.system.attributes as { hp: Record<string, unknown> }
    ).hp.effectiveMax = undefined;
    await run(actor, request({ hp: 99 }));
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(99);
  });

  it("writes temporary hit points as an absolute value", async () => {
    const actor = fakeCharacter();
    (actor.system.attributes as { hp: Record<string, unknown> }).hp.temp = 8;
    await run(actor, request({ hpTemp: 3 }));
    expect(actor.updates[0]["system.attributes.hp.temp"]).toBe(3);
  });

  it("writes only the values that differ, in one update", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ hp: 12, hpTemp: 2, exhaustion: 0 }));
    expect(actor.update).toHaveBeenCalledTimes(1);
    const keys = Object.keys(actor.updates[0]).filter(
      (k) => !k.startsWith("flags."),
    );
    expect(keys).toEqual(["system.attributes.hp.temp"]);
  });

  it("clamps a slot to its prepared max and skips a slot level the character lacks", async () => {
    const actor = fakeCharacter();
    const result = await run(
      actor,
      request({
        slots: {
          ...ALL_SLOTS,
          spell1: 1,
          spell2: 9,
          spell3: 2,
          spell9: 4,
          pact: 0,
        },
      }),
    );
    const update = actor.updates[0];
    expect(update["system.spells.spell1.value"]).toBe(1);
    expect(update["system.spells.spell2.value"]).toBe(3);
    expect(update["system.spells.pact.value"]).toBe(0);
    // spell3 has a prepared max of 0, spell9 none: never written.
    expect(update).not.toHaveProperty("system.spells.spell3.value");
    expect(update).not.toHaveProperty("system.spells.spell9.value");
    expect((result as { warnings: string[] }).warnings).toEqual([
      "resource_clamped:spell2",
    ]);
  });

  it("never toggles the exhaustion status: exhaustion is written as the number", async () => {
    const actor = fakeCharacter([conditionEffect("exhaustion", 2)]);
    (actor.system.attributes as Record<string, unknown>).exhaustion = 2;
    await run(actor, request({ exhaustion: 1, conditions: [] }));
    expect(actor.updates[0]["system.attributes.exhaustion"]).toBe(1);
    expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
    // The exhaustion effect is dnd5e's to move, from its own update hook.
    expect(held(actor)).toEqual(["exhaustion"]);
  });
});

describe("dnd5e.resources.v1 conditions", () => {
  it("turns a condition on", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ conditions: ["prone"] }));
    expect(actor.toggles).toEqual([["prone", true]]);
    expect(held(actor)).toEqual(["prone"]);
  });

  it("turns a condition off", async () => {
    const actor = fakeCharacter([
      conditionEffect("prone"),
      conditionEffect("blinded"),
    ]);
    await run(actor, request({ conditions: ["blinded"] }));
    expect(actor.toggles).toEqual([["prone", false]]);
    expect(held(actor)).toEqual(["blinded"]);
  });

  it("leaves an already-present condition alone", async () => {
    const actor = fakeCharacter([conditionEffect("blinded")]);
    await run(actor, request({ conditions: ["blinded"] }));
    expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
  });

  it("stunned keeps its implied incapacitated", async () => {
    // actor.statuses holds {stunned, incapacitated}; the app's set holds only
    // the primary id. Nothing may be toggled.
    const actor = fakeCharacter([conditionEffect("stunned")]);
    expect(actor.statuses.has("incapacitated")).toBe(true);
    await run(actor, request({ conditions: ["stunned"] }));
    expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
    expect(held(actor)).toEqual(["stunned"]);
  });

  it("leaves concentrating, bloodied and non-condition effects untouched", async () => {
    const concentrating: FakeEffect = {
      _id: staticId("concentrating"),
      type: "base",
      system: {},
      statuses: ["concentrating"],
    };
    const bloodied: FakeEffect = {
      _id: staticId("bloodied"),
      type: "base",
      system: {},
      statuses: ["bloodied"],
    };
    const actor = fakeCharacter([
      concentrating,
      bloodied,
      conditionEffect("poisoned"),
    ]);
    await run(actor, request({ conditions: [] }));
    expect(actor.toggles).toEqual([["poisoned", false]]);
    expect(actor.effects.contents).toEqual([concentrating, bloodied]);
  });

  it("treats the set as the full set, and an absent set as hands-off", async () => {
    const actor = fakeCharacter([
      conditionEffect("blinded"),
      conditionEffect("charmed"),
    ]);
    await run(actor, request({ sequence: 1, hp: 5 }));
    expect(actor.toggleStatusEffect).not.toHaveBeenCalled();
    await run(
      actor,
      request({ sequence: 2, conditions: ["charmed", "restrained"] }),
    );
    expect(actor.toggles).toEqual([
      ["blinded", false],
      ["restrained", true],
    ]);
    expect(held(actor)).toEqual(["charmed", "restrained"]);
  });

  it("a retry after a failed toggle finishes the write", async () => {
    const actor = fakeCharacter();
    const toggle = actor.toggleStatusEffect.getMockImplementation()!;
    actor.toggleStatusEffect.mockImplementationOnce(toggle);
    actor.toggleStatusEffect.mockImplementationOnce(async () => {
      throw new Error("socket lost");
    });
    const req = request({ hp: 4, conditions: ["blinded", "prone"] });
    await expect(run(actor, req)).rejects.toThrow("socket lost");
    expect(actor.update).not.toHaveBeenCalled();
    await run(actor, req);
    expect(held(actor)).toEqual(["blinded", "prone"]);
    expect(actor.updates[0]["system.attributes.hp.value"]).toBe(4);
  });
});

describe("dnd5e.resources.v1 convergence", () => {
  it("replays the same sequence without writing", async () => {
    const actor = fakeCharacter();
    const req = request({ hp: 5, conditions: ["prone"] });
    const first = await run(actor, req);
    const second = await run(actor, req);
    expect(second).toEqual(first);
    expect(actor.update).toHaveBeenCalledTimes(1);
    expect(actor.toggleStatusEffect).toHaveBeenCalledTimes(1);
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
    await run(actor, request({ sequence: 1, hp: 5 }));
    await run(actor, request({ sequence: 2, hp: 5 }));
    expect(actor.update).toHaveBeenCalledTimes(1);
  });
});
