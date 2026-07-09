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

    // App-initiated rolls skip the GM dialog and never post to table chat.
    expect(roll).toHaveBeenCalledWith({ dc: 25, skipDialog: true, createMessage: false });
    expect(res.total).toBe(31);
    expect(res.system?.degreeOfSuccess).toBe(3);
    expect(res.system?.statistic).toBe("fortitude");
  });

  it("dnd5e save uses modern rollSavingThrow, skips the dialog and suppresses chat", async () => {
    const rollSavingThrow = vi.fn(async () => d20(15, 20));
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      actors: { get: () => ({ rollSavingThrow }) },
    });

    const res = (await rollAction(
      { actorId: "a1", type: "save", options: { ability: "dex", advantage: true } },
      {} as never,
    )) as { total: number; system?: { ability?: string } };

    // (config, dialog, message): config carries ability + advantage; dialog skips the
    // configuration prompt; message suppresses the chat card.
    expect(rollSavingThrow).toHaveBeenCalledWith(
      expect.objectContaining({ ability: "dex", advantage: true }),
      { configure: false },
      { create: false },
    );
    expect(res.total).toBe(20);
    expect(res.system?.ability).toBe("dex");
  });

  it("dnd5e skill uses the modern object-config rollSkill (no dialog, no chat)", async () => {
    const rollSkill = vi.fn(async () => d20(12, 17));
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      actors: { get: () => ({ rollSkill }) },
    });

    await rollAction(
      { actorId: "a1", type: "skill", options: { skill: "ath" } },
      {} as never,
    );

    expect(rollSkill).toHaveBeenCalledWith(
      expect.objectContaining({ skill: "ath" }),
      { configure: false },
      { create: false },
    );
  });

  it("dnd5e save falls back to the legacy positional API with fast-forward + no chat", async () => {
    const rollAbilitySave = vi.fn(async () => d20(9, 14));
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      actors: { get: () => ({ rollAbilitySave }) }, // no modern rollSavingThrow
    });

    await rollAction(
      { actorId: "a1", type: "save", options: { ability: "con" } },
      {} as never,
    );

    expect(rollAbilitySave).toHaveBeenCalledWith(
      "con",
      expect.objectContaining({ fastForward: true, chatMessage: false }),
    );
  });

  it("knight aspect+characteristic rolls an Nd6 pool sized from aspect.value + caracteristique.value", async () => {
    const evaluate = vi.fn(async () => ({
      formula: "8d6",
      total: 30,
      dice: [
        {
          faces: 6,
          results: [
            { result: 4 },
            { result: 6 },
            { result: 2 },
            { result: 5 },
            { result: 5 },
            { result: 1 },
            { result: 4 },
            { result: 3 },
          ],
        },
      ],
    }));
    let builtFormula = "";
    vi.stubGlobal("Roll", class {
      constructor(public formula: string) {
        builtFormula = formula;
      }
      evaluate = evaluate;
    });
    vi.stubGlobal("game", {
      system: { id: "knight" },
      actors: {
        get: () => ({
          system: { aspects: { chair: { value: 5, caracteristiques: { puissance: { value: 3 } } } } },
        }),
      },
    });

    const res = (await rollAction(
      { actorId: "vex", type: "aspect", options: { aspect: "chair", characteristic: "puissance" } },
      {} as never,
    )) as {
      dice: Array<{ faces: number; results: number[] }>;
      system?: { pool?: number; aspect?: string; characteristic?: string; type?: string };
    };

    // pool = aspect 5 + caracteristique 3 = 8d6
    expect(builtFormula).toBe("8d6");
    expect(res.dice[0].faces).toBe(6);
    expect(res.dice[0].results).toHaveLength(8);
    expect(res.system?.type).toBe("aspect");
    expect(res.system?.pool).toBe(8);
    expect(res.system?.aspect).toBe("chair");
    expect(res.system?.characteristic).toBe("puissance");
  });

  it("knight aspect roll accepts the singular 'caracteristique' spelling defensively", async () => {
    const evaluate = vi.fn(async () => ({
      formula: "7d6",
      total: 20,
      dice: [{ faces: 6, results: [{ result: 4 }, { result: 6 }, { result: 2 }, { result: 5 }, { result: 1 }, { result: 1 }, { result: 1 }] }],
    }));
    vi.stubGlobal("Roll", class {
      constructor(public formula: string) {}
      evaluate = evaluate;
    });
    vi.stubGlobal("game", {
      system: { id: "knight" },
      actors: {
        get: () => ({
          system: { aspects: { bete: { value: 4, caracteristique: { instinct: { value: 3 } } } } },
        }),
      },
    });

    const res = (await rollAction(
      { actorId: "vex", type: "aspect", options: { aspect: "bete", characteristic: "instinct" } },
      {} as never,
    )) as { system?: { pool?: number } };

    expect(res.system?.pool).toBe(7);
  });

  it("knight aspect roll throws when the characteristic is missing so the app rolls locally", async () => {
    vi.stubGlobal("Roll", class {
      constructor(public formula: string) {}
      evaluate = vi.fn();
    });
    vi.stubGlobal("game", {
      system: { id: "knight" },
      actors: {
        get: () => ({ system: { aspects: { chair: { value: 5, caracteristiques: { puissance: { value: 3 } } } } } }),
      },
    });

    await expect(
      rollAction({ actorId: "vex", type: "aspect", options: { aspect: "chair" } }, {} as never),
    ).rejects.toThrow(/characteristic/);
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
