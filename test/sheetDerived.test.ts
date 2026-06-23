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
