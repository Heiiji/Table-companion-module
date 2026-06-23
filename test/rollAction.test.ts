import { afterEach, describe, expect, it, vi } from "vitest";
import { rollAction } from "../src/procedures/rollAction.js";

interface FakeRoll {
  formula: string;
  total: number;
  dice: Array<{ faces: number; results: Array<{ result: number }> }>;
  degreeOfSuccess?: number;
}

const d20 = (result: number, total: number, degree?: number): FakeRoll => ({
  formula: "1d20",
  total,
  dice: [{ faces: 20, results: [{ result }] }],
  degreeOfSuccess: degree,
});

afterEach(() => vi.unstubAllGlobals());

describe("roll.action", () => {
  it("pf2e save calls the statistic's roll and carries degreeOfSuccess", async () => {
    const roll = vi.fn(async () => d20(18, 31, 3));
    vi.stubGlobal("game", {
      system: { id: "pf2e" },
      actors: { get: () => ({ saves: { fortitude: { roll } } }) },
    });

    const res = (await rollAction(
      { actorId: "a1", type: "save", options: { statistic: "fortitude", dc: 25 } },
      {} as never,
    )) as { total: number; dice: unknown[]; system?: { degreeOfSuccess?: number; statistic?: string } };

    expect(roll).toHaveBeenCalledWith({ dc: 25 });
    expect(res.total).toBe(31);
    expect(res.system?.degreeOfSuccess).toBe(3);
    expect(res.system?.statistic).toBe("fortitude");
  });

  it("dnd5e save uses modern rollSavingThrow with advantage", async () => {
    const rollSavingThrow = vi.fn(async () => d20(15, 20));
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      actors: { get: () => ({ rollSavingThrow }) },
    });

    const res = (await rollAction(
      { actorId: "a1", type: "save", options: { ability: "dex", advantage: true } },
      {} as never,
    )) as { total: number; system?: { ability?: string } };

    expect(rollSavingThrow).toHaveBeenCalled();
    expect(res.total).toBe(20);
    expect(res.system?.ability).toBe("dex");
  });

  it("knight aspect rolls an Nd6 pool sized from the actor's aspect value", async () => {
    const evaluate = vi.fn(async () => ({
      formula: "5d6",
      total: 22,
      dice: [{ faces: 6, results: [{ result: 4 }, { result: 6 }, { result: 2 }, { result: 5 }, { result: 5 }] }],
    }));
    vi.stubGlobal("Roll", class {
      constructor(public formula: string) {}
      evaluate = evaluate;
    });
    vi.stubGlobal("game", {
      system: { id: "knight" },
      actors: { get: () => ({ system: { aspects: { chair: { value: 5 } } } }) },
    });

    const res = (await rollAction(
      { actorId: "vex", type: "aspect", options: { aspect: "chair" } },
      {} as never,
    )) as { dice: Array<{ faces: number; results: number[] }>; system?: { pool?: number; aspect?: string } };

    expect(res.dice[0].faces).toBe(6);
    expect(res.dice[0].results).toHaveLength(5);
    expect(res.system?.pool).toBe(5);
    expect(res.system?.aspect).toBe("chair");
  });

  it("throws for an unsupported type so the app falls back locally", async () => {
    vi.stubGlobal("game", { system: { id: "pf2e" }, actors: { get: () => ({}) } });
    await expect(
      rollAction({ actorId: "a1", type: "strike", options: {} }, {} as never),
    ).rejects.toThrow(/not supported/);
  });

  it("requires actorId and type", async () => {
    vi.stubGlobal("game", { system: { id: "pf2e" }, actors: { get: () => ({}) } });
    await expect(rollAction({ type: "save" }, {} as never)).rejects.toThrow(/actorId/);
    await expect(rollAction({ actorId: "a1" }, {} as never)).rejects.toThrow(/type/);
  });
});
