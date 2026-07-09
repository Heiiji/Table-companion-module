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

  /** A fake evaluated d6 pool from an array of face results. */
  const d6pool = (results: number[]) => ({
    formula: `${results.length}d6`,
    total: results.reduce((a, b) => a + b, 0),
    dice: [{ faces: 6, results: results.map((result) => ({ result })) }],
  });

  it("knight aspect pool is min(aspect, caracteristique) and counts EVEN successes (no exploit)", async () => {
    // aspect chair 5 caps caracteristique puissance 3 → pool = min(5,3) = 3d6.
    const evaluate = vi.fn(async () => d6pool([4, 6, 1])); // evens 4,6 → 2 successes; the 1 blocks exploit
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
      successes?: number;
      dice: Array<{ faces: number; results: number[] }>;
      system?: { pool?: number; successes?: number; exploited?: boolean; aspect?: string; type?: string };
    };

    expect(builtFormula).toBe("3d6"); // min(5,3), NOT 5+3
    expect(res.system?.pool).toBe(3);
    expect(res.successes).toBe(2); // 4 and 6 are even; 1 is not
    expect(res.system?.successes).toBe(2);
    expect(res.system?.exploited).toBe(false);
    expect(res.dice[0].results).toHaveLength(3);
    expect(res.system?.type).toBe("aspect");
    expect(res.system?.aspect).toBe("chair");
  });

  it("knight rerolls once and adds successes when the whole pool succeeds (exploit)", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(d6pool([2, 4, 6])) // all even → 3 successes === pool → exploit
      .mockResolvedValueOnce(d6pool([4, 2, 1])); // reroll: evens 4,2 → +2 successes
    vi.stubGlobal("Roll", class {
      constructor(public formula: string) {}
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
      successes?: number;
      dice: Array<{ results: number[] }>;
      system?: { exploited?: boolean; successes?: number };
    };

    expect(evaluate).toHaveBeenCalledTimes(2); // exactly one reroll, not a loop
    expect(res.successes).toBe(5); // 3 + 2
    expect(res.system?.exploited).toBe(true);
    expect(res.dice).toHaveLength(2); // both rolls' dice carried through
  });

  it("knight adds bonus dice on top of the capped pool", async () => {
    const evaluate = vi.fn(async () => d6pool([1, 3, 5, 1, 3])); // no successes → no exploit
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

    await rollAction(
      { actorId: "vex", type: "aspect", options: { aspect: "chair", characteristic: "puissance", bonus: 2 } },
      {} as never,
    );

    expect(builtFormula).toBe("5d6"); // min(5,3)=3, +2 bonus
  });

  it("knight aspect roll accepts the singular 'caracteristique' spelling defensively", async () => {
    const evaluate = vi.fn(async () => d6pool([4, 6, 1])); // evens 4,6 → no all-success, no exploit
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

    expect(res.system?.pool).toBe(3); // min(4,3), NOT 4+3
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
