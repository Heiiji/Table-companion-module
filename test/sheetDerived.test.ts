import { afterEach, describe, expect, it, vi } from "vitest";
import { sheetDerived } from "../src/procedures/sheetDerived.js";

interface FakeActor {
  id: string;
  name: string;
  type: string;
  img?: string;
  system: Record<string, unknown>;
  items?: Array<{ id: string; name: string; type: string; system: Record<string, unknown> }>;
  effects?: Array<{ id: string; name: string; disabled: boolean; statuses: string[] }>;
}

function setGame(systemId: string, actor: FakeActor | undefined): void {
  const actors = { get: (id: string) => (actor && actor.id === id ? actor : undefined) };
  vi.stubGlobal("game", { actors, system: { id: systemId } });
}

afterEach(() => vi.unstubAllGlobals());

describe("sheet.derived", () => {
  it("returns prepared system data + pf2e derived saves/AC", async () => {
    setGame("pf2e", {
      id: "a1",
      name: "Brakka",
      type: "character",
      system: {
        attributes: { ac: { value: 24 } },
        saves: {
          fortitude: { value: 13, rank: 3 },
          reflex: { value: 11, rank: 2 },
          will: { value: 9, rank: 2 },
        },
      },
      items: [{ id: "i1", name: "Longsword", type: "weapon", system: { equipped: true } }],
      effects: [{ id: "e1", name: "Frightened", disabled: false, statuses: ["frightened"] }],
    });

    const res = (await sheetDerived({ actorId: "a1" }, {} as never)) as {
      name: string;
      system: Record<string, unknown>;
      derived: { ac?: number; saves?: { fortitude?: { total?: number; rank?: number } } };
      items: unknown[];
      effects: Array<{ name: string; statuses: string[] }>;
    };

    expect(res.name).toBe("Brakka");
    expect(res.derived.ac).toBe(24);
    expect(res.derived.saves?.fortitude).toEqual({ total: 13, rank: 3 });
    expect(res.items).toHaveLength(1);
    expect(res.effects[0]).toMatchObject({ name: "Frightened", statuses: ["frightened"] });
    // Raw prepared system block is always passed through.
    expect(res.system).toHaveProperty("saves");
  });

  it("returns dnd5e spell DC + AC + proficiency", async () => {
    setGame("dnd5e", {
      id: "lyra",
      name: "Lyra",
      type: "character",
      system: { attributes: { ac: { value: 16 }, prof: 3, spelldc: 14, spell: { attack: 6 } } },
    });
    const res = (await sheetDerived({ actorId: "lyra" }, {} as never)) as {
      derived: { ac?: number; proficiency?: number; spellcasting?: { dc?: number; attack?: number } };
    };
    expect(res.derived.ac).toBe(16);
    expect(res.derived.proficiency).toBe(3);
    expect(res.derived.spellcasting).toEqual({ dc: 14, attack: 6 });
  });

  it("normalizes dnd5e spell slots (per level + pact) and drops empty levels", async () => {
    setGame("dnd5e", {
      id: "wiz",
      name: "Wiz",
      type: "character",
      system: {
        spells: {
          spell1: { value: 3, max: 4 },
          spell2: { value: 0, max: 3 },
          spell9: { value: 0, max: 0 }, // both zero -> kept (defined), distinct from absent
          pact: { value: 1, max: 2 },
        },
      },
    });
    const res = (await sheetDerived({ actorId: "wiz" }, {} as never)) as {
      derived: { spellSlots?: Record<string, { value?: number; max?: number }> };
    };
    const slots = res.derived.spellSlots ?? {};
    expect(slots.level1).toEqual({ value: 3, max: 4 });
    expect(slots.level2).toEqual({ value: 0, max: 3 });
    expect(slots.pact).toEqual({ value: 1, max: 2 });
    // level3..8 absent entirely -> not emitted
    expect(slots.level3).toBeUndefined();
  });

  it("coerces dnd5e hit dice: v4 object and v3 bare integer", async () => {
    setGame("dnd5e", {
      id: "v4",
      name: "V4",
      type: "character",
      system: { attributes: { hd: { value: 3, max: 5 } } },
    });
    const r4 = (await sheetDerived({ actorId: "v4" }, {} as never)) as {
      derived: { hitDice?: { value?: number; max?: number } };
    };
    expect(r4.derived.hitDice).toEqual({ value: 3, max: 5 });

    setGame("dnd5e", {
      id: "v3",
      name: "V3",
      type: "character",
      system: { attributes: { hd: 2 } }, // v3: bare remaining integer
    });
    const r3 = (await sheetDerived({ actorId: "v3" }, {} as never)) as {
      derived: { hitDice?: { value?: number; max?: number } };
    };
    expect(r3.derived.hitDice).toEqual({ value: 2 });
  });

  it("returns dnd5e death saves", async () => {
    setGame("dnd5e", {
      id: "downed",
      name: "Downed",
      type: "character",
      system: { attributes: { death: { success: 2, failure: 1 } } },
    });
    const res = (await sheetDerived({ actorId: "downed" }, {} as never)) as {
      derived: { deathSaves?: { success?: number; failure?: number } };
    };
    expect(res.derived.deathSaves).toEqual({ success: 2, failure: 1 });
  });

  it("detects dnd5e concentration from the 'concentrating' status effect", async () => {
    setGame("dnd5e", {
      id: "conc",
      name: "Conc",
      type: "character",
      system: {},
      effects: [
        { id: "e9", name: "Haste", disabled: false, statuses: ["concentrating"] },
        { id: "e1", name: "Bless", disabled: true, statuses: ["concentrating"] }, // disabled ignored
      ],
    });
    const res = (await sheetDerived({ actorId: "conc" }, {} as never)) as {
      derived: { concentration?: { active?: boolean; spellName?: string; effectId?: string } };
    };
    expect(res.derived.concentration).toEqual({ active: true, spellName: "Haste", effectId: "e9" });
  });

  it("reports concentration inactive when no 'concentrating' status is present", async () => {
    setGame("dnd5e", {
      id: "calm",
      name: "Calm",
      type: "character",
      system: {},
      effects: [{ id: "e2", name: "Prone", disabled: false, statuses: ["prone"] }],
    });
    const res = (await sheetDerived({ actorId: "calm" }, {} as never)) as {
      derived: { concentration?: { active?: boolean } };
    };
    expect(res.derived.concentration).toEqual({ active: false });
  });

  it("returns an empty derived block for unknown systems but still the raw system", async () => {
    setGame("homebrew", { id: "x", name: "X", type: "npc", system: { foo: 1 } });
    const res = (await sheetDerived({ actorId: "x" }, {} as never)) as {
      derived: Record<string, unknown>;
      system: Record<string, unknown>;
    };
    expect(res.derived).toEqual({});
    expect(res.system).toEqual({ foo: 1 });
  });

  it("throws on a missing actor", async () => {
    setGame("pf2e", undefined);
    await expect(sheetDerived({ actorId: "ghost" }, {} as never)).rejects.toThrow(/unknown actor/);
  });

  it("requires actorId", async () => {
    setGame("pf2e", undefined);
    await expect(sheetDerived({}, {} as never)).rejects.toThrow(/actorId/);
  });
});
