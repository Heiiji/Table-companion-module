import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dnd5eResourcesV1,
  validateDnd5eActorResourcesV1,
  type Dnd5eActorResourcesV1,
} from "../src/procedures/dnd5eResources.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import { hasFixturePath } from "./support/actorUpsertHarness.js";
import FIXTURE from "./fixtures/dnd5e-6.1.0-character.json";

// SYNTHETIC, shape-only: a prepared dnd5e `character` (the fixture) and its
// condition effects as the dnd5e 6.1.0 source describes them (source-derived,
// not a capture). Status effects carry dnd5e's static ids; a condition effect has
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
    system: structuredClone(FIXTURE.actor.system) as Record<string, unknown>,
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
  {
    id = "dnd5e",
    version = "6.1.0",
    generation = 14,
    isGM = true,
    rulesVersion = "modern",
  } = {},
) {
  vi.stubGlobal("game", {
    user: { id: "gm", isGM },
    settings: {
      get: (ns: string, key: string) =>
        ns === "dnd5e" && key === "rulesVersion" ? rulesVersion : undefined,
    },
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

async function run(
  actor: FakeCharacter,
  req: unknown,
  world: Parameters<typeof stubWorld>[1] = {},
) {
  stubWorld([actor], world);
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
    ["death saves that are not an object", { deathSaves: 1 }],
    ["death saves missing failure", { deathSaves: { success: 1 } }],
    ["death saves missing success", { deathSaves: { failure: 1 } }],
    [
      "death saves with an extra key",
      { deathSaves: { success: 0, failure: 0, stable: true } },
    ],
    ["death successes above 3", { deathSaves: { success: 4, failure: 0 } }],
    ["negative death failures", { deathSaves: { success: 0, failure: -1 } }],
    ["fractional death failures", { deathSaves: { success: 0, failure: 1.5 } }],
    ["a fractional hpTempMax", { hpTempMax: 1.5 }],
    ["a string hpTempMax", { hpTempMax: "-2" }],
    ["an hpTempMax below -9999", { hpTempMax: -10000 }],
    ["a numeric inspiration", { inspiration: 1 }],
    ["a string inspiration", { inspiration: "true" }],
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
        deathSaves: { success: 3, failure: 0 },
        inspiration: false,
      }),
    );
    expect(req.conditions).toEqual([]);
    expect(req.deathSaves).toEqual({ success: 3, failure: 0 });
    expect(req.inspiration).toBe(false);
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
    expect(actor.updates).toHaveLength(2);
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

  it("resets the temporary maximum and clamps hit points to the new maximum, in one update", async () => {
    const actor = fakeCharacter();
    const hp = (actor.system.attributes as { hp: Record<string, unknown> }).hp;
    Object.assign(hp, { value: 25, tempmax: 5, effectiveMax: 25 });
    const result = await run(actor, request({ hp: 25, hpTempMax: 0 }));
    expect(actor.updates[0]).toEqual({
      "system.attributes.hp.tempmax": 0,
      "system.attributes.hp.value": 20,
    });
    expect((result as { warnings: string[] }).warnings).toEqual([
      "resource_clamped:hp",
    ]);
  });

  it("raises the ceiling with a positive temporary maximum, and accepts a negative one", async () => {
    const raised = fakeCharacter();
    await run(raised, request({ hp: 24, hpTempMax: 4 }));
    expect(raised.updates[0]).toEqual({
      "system.attributes.hp.tempmax": 4,
      "system.attributes.hp.value": 24,
    });
    const lowered = fakeCharacter();
    await run(lowered, request({ hp: 12, hpTempMax: -10 }));
    expect(lowered.updates[0]).toEqual({
      "system.attributes.hp.tempmax": -10,
      "system.attributes.hp.value": 10,
    });
  });

  it("refuses a fractional hpTempMax with invalid_args", async () => {
    await rejects(
      run(fakeCharacter(), request({ hpTempMax: 0.5 })),
      "invalid_args",
    );
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
    // The counters, then the result flag.
    expect(actor.update).toHaveBeenCalledTimes(2);
    expect(Object.keys(actor.updates[0])).toEqual([
      "system.attributes.hp.temp",
    ]);
    expect(Object.keys(actor.updates[1])).toEqual([
      `flags.${MODULE_ID}.dnd5eResourcesV1`,
    ]);
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

describe("dnd5e.resources.v1 rules version", () => {
  it("leaves exhaustion to Foundry on a 2014-rules world, and writes the rest", async () => {
    const actor = fakeCharacter();
    const result = await run(actor, request({ exhaustion: 3, hpTemp: 4 }), {
      rulesVersion: "legacy",
    });
    expect(actor.updates[0]).toEqual({ "system.attributes.hp.temp": 4 });
    expect(
      (actor.system.attributes as Record<string, unknown>).exhaustion,
    ).toBe(0);
    expect((result as { warnings: string[] }).warnings).toEqual([
      "exhaustion_unavailable:legacy_rules",
    ]);
  });

  it("writes exhaustion on a 2024-rules world", async () => {
    const actor = fakeCharacter();
    const result = await run(actor, request({ exhaustion: 3 }), {
      rulesVersion: "modern",
    });
    expect(actor.updates[0]).toEqual({ "system.attributes.exhaustion": 3 });
    expect((result as { warnings: string[] }).warnings).toEqual([]);
  });
});

describe("dnd5e.resources.v1 death saves and inspiration", () => {
  it("accepts either group alone", () => {
    expect(
      validateDnd5eActorResourcesV1(
        request({ deathSaves: { success: 0, failure: 3 } }),
      ).deathSaves,
    ).toEqual({ success: 0, failure: 3 });
    expect(
      validateDnd5eActorResourcesV1(request({ inspiration: true })).inspiration,
    ).toBe(true);
  });

  it("writes both counters and inspiration with the other counters in one update", async () => {
    const actor = fakeCharacter();
    await run(
      actor,
      request({
        hp: 0,
        deathSaves: { success: 2, failure: 1 },
        inspiration: true,
      }),
    );
    expect(actor.update).toHaveBeenCalledTimes(2);
    expect(actor.updates[0]).toEqual({
      "system.attributes.hp.value": 0,
      "system.attributes.death.success": 2,
      "system.attributes.death.failure": 1,
      "system.attributes.inspiration": true,
    });
  });

  it("writes only the death counter and inspiration that differ", async () => {
    const actor = fakeCharacter();
    const attributes = actor.system.attributes as Record<string, unknown>;
    attributes.death = { success: 1, failure: 2 };
    attributes.inspiration = true;
    await run(
      actor,
      request({ deathSaves: { success: 1, failure: 0 }, inspiration: false }),
    );
    const keys = Object.keys(actor.updates[0]).filter(
      (k) => !k.startsWith("flags."),
    );
    expect(keys).toEqual([
      "system.attributes.death.failure",
      "system.attributes.inspiration",
    ]);
  });

  it("warns instead of writing when the Actor has no death save field", async () => {
    const actor = fakeCharacter();
    delete (actor.system.attributes as Record<string, unknown>).death;
    const result = await run(
      actor,
      request({ deathSaves: { success: 1, failure: 1 }, inspiration: true }),
    );
    expect((result as { warnings: string[] }).warnings).toEqual([
      "resource_unavailable:deathSaves",
    ]);
    expect(actor.updates[0]).not.toHaveProperty(
      "system.attributes.death.success",
    );
    expect(actor.updates[0]["system.attributes.inspiration"]).toBe(true);
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
    expect(actor.update).toHaveBeenCalledTimes(2);
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
    expect(actor.update).toHaveBeenCalledTimes(2);
  });
});

describe("dnd5e.resources.v1 hpEffectiveMax", () => {
  const flagOf = (actor: FakeCharacter) =>
    (actor.flags[MODULE_ID] as Record<string, Record<string, unknown>>)
      .dnd5eResourcesV1;

  it("reads the prepared effective maximum after the update, into the result and the flag", async () => {
    const actor = fakeCharacter();
    const write = actor.update.getMockImplementation()!;
    // Foundry prepares the Actor again after an update: here the exhaustion
    // write halves the maximum (exhaustion 4, legacy rules).
    actor.update.mockImplementation(async (changes) => {
      await write(changes);
      if ("system.attributes.exhaustion" in changes)
        (
          actor.system.attributes as { hp: Record<string, unknown> }
        ).hp.effectiveMax = 10;
    });
    const result = await run(actor, request({ exhaustion: 4 }));
    expect(result).toMatchObject({ hpEffectiveMax: 10 });
    expect(flagOf(actor)).toMatchObject({
      schemaVersion: 1,
      outcome: "updated",
      appliedRevision: 3,
      warnings: [],
      hpEffectiveMax: 10,
    });
    expect(flagOf(actor).contentDigest).toEqual(expect.any(String));
  });

  it("replays the stored value, and reports the current one when nothing is written", async () => {
    const actor = fakeCharacter();
    const req = request({ sequence: 1, hp: 5 });
    expect(await run(actor, req)).toMatchObject({ hpEffectiveMax: 20 });
    const hp = (actor.system.attributes as { hp: Record<string, unknown> }).hp;
    hp.effectiveMax = 18;
    expect(await run(actor, req)).toMatchObject({ hpEffectiveMax: 20 });
    expect(await run(actor, request({ sequence: 2, hp: 5 }))).toMatchObject({
      hpEffectiveMax: 18,
    });
  });

  it("floors at 0 and is absent without a finite prepared maximum", async () => {
    const actor = fakeCharacter();
    const hp = (actor.system.attributes as { hp: Record<string, unknown> }).hp;
    hp.effectiveMax = -3.5;
    expect(await run(actor, request({ sequence: 1, hp: 0 }))).toMatchObject({
      hpEffectiveMax: 0,
    });
    hp.effectiveMax = undefined;
    const result = await run(actor, request({ sequence: 2, hpTemp: 4 }));
    expect(result).not.toHaveProperty("hpEffectiveMax");
    expect(flagOf(actor)).not.toHaveProperty("hpEffectiveMax");
  });
});

describe("dnd5e.resources.v1 base (compare-and-set)", () => {
  it("validates base with the counters' keys and bounds", () => {
    expect(
      validateDnd5eActorResourcesV1(
        request({ hp: 10, base: { hp: 12, conditions: ["prone"] } }),
      ).base,
    ).toEqual({ hp: 12, conditions: ["prone"] });
    for (const [base, path] of [
      [{ sequence: 1 }, "base.sequence"],
      [{ exhaustion: 9 }, "base.exhaustion"],
      [{ slots: { spell1: 1 } }, "base.slots.spell2"],
      [{ conditions: ["dazed"] }, "base.conditions"],
    ] as const)
      expect(() =>
        validateDnd5eActorResourcesV1(request({ hp: 10, base: base as never })),
      ).toThrow(path);
  });

  it("writes when Foundry still holds the base", async () => {
    const actor = fakeCharacter();
    await run(
      actor,
      request({
        hp: 10,
        slots: { ...ALL_SLOTS, spell1: 3 },
        base: { hp: 12, slots: ALL_SLOTS, conditions: [] },
      }),
    );
    expect(actor.updates[0]).toMatchObject({
      "system.attributes.hp.value": 10,
      "system.spells.spell1.value": 3,
    });
  });

  it("refuses everything with base_conflict when hit points moved in Foundry", async () => {
    const actor = fakeCharacter();
    actor.system.attributes = {
      ...(actor.system.attributes as object),
      hp: { value: 7, max: 20, temp: 0, tempmax: 0, effectiveMax: 20 },
    };
    const pending = run(
      actor,
      request({
        hp: 10,
        conditions: ["blinded"],
        base: { hp: 12, conditions: [] },
      }),
    );
    await rejects(pending, "base_conflict");
    await expect(pending).rejects.toThrow(/Foundry changed hp first/);
    expect(actor.updates).toHaveLength(0);
    expect(actor.toggles).toHaveLength(0);
  });

  it("refuses when the GM added a condition in Foundry, keeping it", async () => {
    const actor = fakeCharacter([conditionEffect("prone")]);
    await rejects(
      run(
        actor,
        request({ conditions: ["blinded"], base: { conditions: [] } }),
      ),
      "base_conflict",
    );
    expect(held(actor)).toEqual(["prone"]);
    expect(actor.updates).toHaveLength(0);
  });

  it("compares a condition set regardless of order, and a slot by key", async () => {
    const actor = fakeCharacter([
      conditionEffect("prone"),
      conditionEffect("blinded"),
    ]);
    await run(
      actor,
      request({
        conditions: ["blinded"],
        base: { conditions: ["prone", "blinded"] },
      }),
    );
    expect(held(actor)).toEqual(["blinded"]);
    await rejects(
      run(
        fakeCharacter(),
        request({
          slots: { ...ALL_SLOTS, spell1: 2 },
          base: { slots: { ...ALL_SLOTS, spell1: 3 } },
        }),
      ),
      "base_conflict",
    );
  });

  it("ignores a base for a counter the request does not write", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ hp: 10, base: { hp: 12, hpTemp: 5 } }));
    expect(actor.updates[0]).toMatchObject({
      "system.attributes.hp.value": 10,
    });
  });

  it("without a base writes over a Foundry edit, as before", async () => {
    const actor = fakeCharacter([conditionEffect("prone")]);
    await run(actor, request({ conditions: ["blinded"] }));
    expect(held(actor)).toEqual(["blinded"]);
  });

  it("accepts a base read before the app's own previous write landed, not a later Foundry edit", async () => {
    const actor = fakeCharacter();
    await run(actor, request({ sequence: 3, hp: 10, base: { hp: 12 } }));
    await run(actor, request({ sequence: 4, hp: 8, base: { hp: 12 } }));
    expect(actor.updates.at(-2)).toMatchObject({
      "system.attributes.hp.value": 8,
    });
    (actor.system.attributes as { hp: { value: number } }).hp.value = 15;
    await rejects(
      run(actor, request({ sequence: 5, hp: 6, base: { hp: 12 } })),
      "base_conflict",
    );
  });
});

describe("dnd5e.resources.v1 on the sanitized dnd5e 6.1.0 character", () => {
  it("writes only paths the character's data model has", async () => {
    const actor = fakeCharacter(
      structuredClone(FIXTURE.actor.effects) as FakeEffect[],
    );
    stubWorld([actor], {
      id: FIXTURE.systemId,
      version: FIXTURE.systemVersion,
      generation: FIXTURE.foundryGeneration,
    });
    const result = (await dnd5eResourcesV1(
      request({
        hp: 9,
        hpTemp: 3,
        hpTempMax: 2,
        slots: { ...ALL_SLOTS, spell1: 1, pact: 0 },
        exhaustion: 1,
        conditions: ["blinded"],
        deathSaves: { success: 1, failure: 2 },
        inspiration: true,
      }),
      {} as never,
    )) as { warnings: string[] };

    const written = actor.updates.flatMap((u) => Object.keys(u));
    expect(written.length).toBeGreaterThanOrEqual(9);
    for (const key of written.filter((k) => k.startsWith("system.")))
      expect(hasFixturePath(FIXTURE.actor, key), key).toBe(true);
    // The fixture's prone condition goes; blinded comes.
    expect(actor.toggles).toEqual(
      expect.arrayContaining([
        ["blinded", true],
        ["prone", false],
      ]),
    );
    expect(result.warnings).toEqual([]);
  });
});
