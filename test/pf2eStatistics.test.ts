import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pf2eStatisticsV1,
  supportsPf2eStatisticsV1Runtime,
} from "../src/procedures/pf2eStatistics.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { RpcError } from "../src/rpc/errors.js";

// SYNTHETIC, shape-only: prepared pf2e Actors as the pf2e 8.6.1 sources
// describe them (source-derived, not a capture). A `Statistic` exposes `mod`
// and `dc.value` as getters, `rank`, `label`, `slug` and, for a skill, `lore`;
// a strike carries `totalModifier`, `variants[].penalty` (a getter on a
// character) and async `damage` / `critical` that answer a formula string
// with `{ getFormula: true }`.

const PC_ID = "pf2ePC0000000001";
const NPC_ID = "pf2eNPC000000001";
const ENTRY_ID = "spellEntry000001";

function statistic(
  slug: string,
  mod: number,
  rank: number | null = 1,
  extra: Record<string, unknown> = {},
) {
  return {
    slug,
    label: slug[0].toUpperCase() + slug.slice(1),
    rank,
    get mod() {
      return mod;
    },
    get dc() {
      return { value: 10 + mod };
    },
    ...extra,
  };
}

function strike(
  label: string,
  total: number,
  penalties: number[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: "strike",
    slug: label.toLowerCase().replace(/\s+/g, "-"),
    label,
    glyph: "A",
    totalModifier: total,
    traits: [{ name: "attack", label: "Attack" }],
    weaponTraits: [
      { name: "agile", label: "Agile" },
      { name: "finesse", label: "Finesse" },
    ],
    item: { id: "weapon0000000001" },
    variants: penalties.map((p) => ({
      get penalty() {
        return p;
      },
      label: String(total + p),
    })),
    damage: vi.fn(async ({ getFormula }: { getFormula?: boolean }) =>
      getFormula ? "{(1d6+4)[piercing]}" : null,
    ),
    critical: vi.fn(async ({ getFormula }: { getFormula?: boolean }) =>
      getFormula ? "{(2*(1d6+4))[piercing]}" : null,
    ),
    ...extra,
  };
}

function character(over: Record<string, unknown> = {}) {
  return {
    id: PC_ID,
    type: "character",
    armorClass: { value: 21 },
    perception: statistic("perception", 9, 2),
    saves: {
      fortitude: statistic("fortitude", 10, 2),
      reflex: statistic("reflex", 8, 1),
      will: statistic("will", 7, 2),
    },
    skills: {
      thievery: statistic("thievery", 8, 2),
      acrobatics: statistic("acrobatics", 7, 1),
      "warfare-lore": statistic("warfare-lore", 4, 1, {
        label: "<b>Warfare</b> Lore",
        lore: true,
      }),
    },
    classDC: statistic("rogue", 9, 1),
    system: {
      actions: [
        strike("Rapier", 9, [0, -4, -8]),
        // Area fire is not a strike; a hidden strike is not printed.
        { type: "area-fire", label: "Spray", variants: [] },
        strike("Fist", 9, [0, -4, -8], { visible: false }),
      ],
    },
    items: {
      contents: [
        {
          id: ENTRY_ID,
          type: "spellcastingEntry",
          statistic: statistic("arcane", 11, 2),
        },
        { id: "weapon0000000001", type: "weapon" },
      ],
    },
    update: vi.fn(),
    ...over,
  };
}

function npc(over: Record<string, unknown> = {}) {
  return {
    id: NPC_ID,
    type: "npc",
    armorClass: { value: 18 },
    perception: statistic("perception", 6, null),
    saves: {
      fortitude: statistic("fortitude", 9, null),
      reflex: statistic("reflex", 6, null),
      will: statistic("will", 4, null),
    },
    skills: { athletics: statistic("athletics", 8, null) },
    classDC: statistic("class", 99, null),
    system: {
      actions: [
        // NPC strikes print "1"; one not subject to MAP has a single variant.
        strike("Jaws", 10, [0, -5, -10], { glyph: "1", weaponTraits: [] }),
        strike("Tail", 8, [0], {
          glyph: "1",
          weaponTraits: undefined,
          traits: [{ name: "attack" }, { name: "reach-10" }],
        }),
      ],
    },
    items: { contents: [] },
    update: vi.fn(),
    ...over,
  };
}

type FakeActor = ReturnType<typeof character> | ReturnType<typeof npc>;

function stubWorld(
  actors: FakeActor[],
  { version = "8.5.1", generation = 14, isGM = true } = {},
) {
  vi.stubGlobal("game", {
    user: { id: "gm", isGM },
    actors: {
      contents: actors,
      get: (id: string) => actors.find((a) => a.id === id),
    },
    system: { id: "pf2e", version },
    release: { generation },
  });
}

function request(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    worldId: "world-1",
    expectedActorId: PC_ID,
    actorType: "character",
    ...over,
  };
}

async function read(actor: FakeActor, req: unknown = request()) {
  stubWorld([actor]);
  return (await pf2eStatisticsV1(req, {} as never)) as Record<string, any>;
}

async function rejects(pending: unknown, code: string) {
  const promise = Promise.resolve(pending);
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code });
}

afterEach(() => vi.unstubAllGlobals());

describe("pf2e.statistics.v1", () => {
  it("reads a character's prepared numbers, strikes with their MAP variants and formulas", async () => {
    const pc = character();
    const out = await read(pc);
    expect(out).toEqual({
      schemaVersion: 1,
      actorId: PC_ID,
      actorType: "character",
      ac: 21,
      perception: { mod: 9, dc: 19, rank: 2 },
      saves: {
        fortitude: { mod: 10, dc: 20, rank: 2 },
        reflex: { mod: 8, dc: 18, rank: 1 },
        will: { mod: 7, dc: 17, rank: 2 },
      },
      skills: [
        {
          slug: "acrobatics",
          label: "Acrobatics",
          lore: false,
          mod: 7,
          dc: 17,
          rank: 1,
        },
        {
          slug: "thievery",
          label: "Thievery",
          lore: false,
          mod: 8,
          dc: 18,
          rank: 2,
        },
        {
          slug: "warfare-lore",
          label: "Warfare Lore",
          lore: true,
          mod: 4,
          dc: 14,
          rank: 1,
        },
      ],
      classDC: { mod: 9, dc: 19, rank: 1 },
      spellcasting: [{ entryId: ENTRY_ID, attack: 11, dc: 21 }],
      strikes: [
        {
          label: "Rapier",
          itemId: "weapon0000000001",
          slug: "rapier",
          actionCost: 1,
          traits: ["attack", "agile", "finesse"],
          variants: [9, 5, 1],
          damage: "{(1d6+4)[piercing]}",
          critical: "{(2*(1d6+4))[piercing]}",
        },
      ],
    });
    // Formulas only: never a roll, never a write.
    const rapier = pc.system.actions[0] as ReturnType<typeof strike>;
    expect(rapier.damage).toHaveBeenCalledWith({ getFormula: true });
    expect(pc.update).not.toHaveBeenCalled();
  });

  it("reads an NPC: no class DC, single-variant strikes repeat their modifier", async () => {
    const out = await read(
      npc(),
      request({ expectedActorId: NPC_ID, actorType: "npc" }),
    );
    expect(out.classDC).toBeNull();
    expect(out.perception).toEqual({ mod: 6, dc: 16, rank: null });
    expect(
      out.strikes.map((s: any) => [s.label, s.variants, s.traits]),
    ).toEqual([
      ["Jaws", [10, 5, 0], ["attack"]],
      ["Tail", [8, 8, 8], ["attack", "reach-10"]],
    ]);
    expect(out.strikes[0].actionCost).toBe(1);
  });

  it("answers null for a formula that throws, a missing statistic or an out-of-range number, never failing the read", async () => {
    const throwing = strike("Bow", 7, [0, -5, -10], {
      damage: async () => {
        throw new Error("no target");
      },
      critical: async () => "x".repeat(201),
      item: { id: "not-a-doc-id" },
      glyph: "?",
    });
    const pc = character({
      armorClass: { value: 1000 },
      perception: {
        get mod() {
          throw new Error("unprepared");
        },
      },
      classDC: null,
      saves: { fortitude: statistic("fortitude", 3), reflex: 7 },
      system: { actions: [throwing, strike("Broken", Number.NaN, [0])] },
    });
    const out = await read(pc);
    expect(out.ac).toBeNull();
    expect(out.perception).toBeNull();
    expect(out.classDC).toBeNull();
    expect(out.saves).toEqual({
      fortitude: { mod: 3, dc: 13, rank: 1 },
      reflex: null,
      will: null,
    });
    expect(out.strikes).toEqual([
      {
        label: "Bow",
        itemId: null,
        slug: "bow",
        actionCost: null,
        traits: ["attack", "agile", "finesse"],
        variants: [7, 2, -3],
        damage: null,
        critical: null,
      },
    ]);
  });

  it("cuts a long label to 120 characters and drops a skill without a usable modifier", async () => {
    const pc = character({
      skills: {
        arcana: statistic("arcana", 5, 1, { label: "é".repeat(130) }),
        broken: { slug: "broken", label: "Broken", mod: "5" },
      },
    });
    const out = await read(pc);
    expect(out.skills).toHaveLength(1);
    expect(out.skills[0].label).toBe("é".repeat(120));
  });

  it("refuses an oversized list instead of truncating it", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `lore-${i}`,
        statistic(`lore-${i}`, 1),
      ]),
    );
    await rejects(read(character({ skills: many })), "payload_too_large");
    const strikes = Array.from({ length: 51 }, (_, i) =>
      strike(`S${i}`, 1, [0]),
    );
    await rejects(
      read(character({ system: { actions: strikes } })),
      "payload_too_large",
    );
    const traits = Array.from({ length: 31 }, (_, i) => ({ name: `t${i}` }));
    await rejects(
      read(
        character({
          system: { actions: [strike("Many", 1, [0], { traits })] },
        }),
      ),
      "payload_too_large",
    );
    const entries = Array.from({ length: 17 }, (_, i) => ({
      id: `spellEntry${String(i).padStart(6, "0")}`,
      type: "spellcastingEntry",
      statistic: statistic("arcane", 1),
    }));
    await rejects(
      read(character({ items: { contents: entries } })),
      "payload_too_large",
    );
  });

  it("validates the request strictly", async () => {
    const pc = character();
    for (const bad of [
      request({ schemaVersion: 2 }),
      request({ extra: true }),
      request({ expectedActorId: "short" }),
      request({ actorType: "hazard" }),
      request({ worldId: "" }),
      null,
    ])
      await rejects(read(pc, bad), "invalid_args");
    await rejects(read(pc, request({ actorType: "npc" })), "invalid_args");
    await rejects(
      read(pc, request({ expectedActorId: "missingActor0001" })),
      "actor_not_found",
    );
  });

  it("refuses a non-GM responder and a runtime outside the floor or without prepared statistics", async () => {
    const pc = character();
    stubWorld([pc], { isGM: false });
    await rejects(
      pf2eStatisticsV1(request(), {} as never),
      "permission_denied",
    );
    stubWorld([pc], { version: "8.4.0" });
    await rejects(
      pf2eStatisticsV1(request(), {} as never),
      "unsupported_runtime",
    );
    const bare = character({ skills: undefined });
    stubWorld([npc(), bare]);
    expect(supportsPf2eStatisticsV1Runtime()).toBe(true); // the NPC answers
    await rejects(
      pf2eStatisticsV1(request(), {} as never),
      "unsupported_runtime",
    );
  });

  it("is advertised as a signed-only read on the pf2e floor, withheld with a reason otherwise", () => {
    const registered = () => {
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      return registry;
    };
    stubWorld([character()]);
    let registry = registered();
    expect(registry.capabilities()).toContain("pf2e.statistics.v1");
    expect(registry.isSignedOnly("pf2e.statistics.v1")).toBe(true);
    expect(registry.mutations()).not.toContain("pf2e.statistics.v1");
    stubWorld([character({ system: {} })]);
    registry = registered();
    expect(registry.capabilities()).not.toContain("pf2e.statistics.v1");
    expect(registry.unsupported()["pf2e.statistics.v1"]).toMatch(
      /prepared statistics/,
    );
  });
});
