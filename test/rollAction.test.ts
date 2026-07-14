import { afterEach, describe, expect, it, vi } from "vitest";
import { rollAction } from "../src/procedures/rollAction.js";
import { RpcError } from "../src/rpc/errors.js";

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
  it("rejects PF2e before reading the actor or executing a lossy roll", async () => {
    const roll = vi.fn(async () => d20(18, 31, 3));
    const getActor = vi.fn(() => ({ saves: { fortitude: { roll } } }));
    vi.stubGlobal("game", {
      system: { id: "pf2e" },
      actors: { get: getActor },
    });

    await expect(
      rollAction(
        { actorId: "a1", type: "save", options: { statistic: "fortitude", dc: 25 } },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "unsupported_runtime" });
    expect(getActor).not.toHaveBeenCalled();
    expect(roll).not.toHaveBeenCalled();
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

  /** A knight actor whose scores exercise the KNT-R-006 per-characteristic aspect caps:
   *  chair 3 caps force 4 → effective 3; bete 5 leaves instinct 2 → effective 2. */
  const knightSystem = {
    aspects: {
      chair: { value: 3, caracteristiques: { force: { value: 4 }, deplacement: { value: 1 } } },
      bete: { value: 5, caracteristiques: { instinct: { value: 2 }, combat: { value: 6 } } },
    },
  };

  function stubKnight(evaluate: ReturnType<typeof vi.fn>, system: unknown = knightSystem): { formulas: string[] } {
    const formulas: string[] = [];
    vi.stubGlobal("Roll", class {
      constructor(public formula: string) {
        formulas.push(formula);
      }
      evaluate = evaluate;
    });
    vi.stubGlobal("game", {
      system: { id: "knight" },
      actors: { get: () => ({ system }) },
    });
    return { formulas };
  }

  it("knight combo pool sums the two characteristics, each capped by its own aspect (KNT-R-001/006)", async () => {
    // effective(force)=min(4, chair 3)=3, effective(instinct)=min(2, bete 5)=2 → pool 5.
    const evaluate = vi.fn(async () => d6pool([4, 6, 1, 3, 5])); // evens 4,6 → 2 successes
    const { formulas } = stubKnight(evaluate);

    const res = (await rollAction(
      { actorId: "vex", type: "aspect", options: { base: "force", combo: "instinct" } },
      {} as never,
    )) as {
      successes?: number;
      criticalFailure?: boolean;
      dice: Array<{ faces: number; results: number[] }>;
      system?: {
        pool?: number;
        successes?: number;
        exploited?: boolean;
        criticalFailure?: boolean;
        base?: string;
        combo?: string;
        baseAspect?: string;
        comboAspect?: string;
        type?: string;
      };
    };

    expect(formulas).toEqual(["5d6"]); // 3 + 2; aspect values are caps, never addends
    expect(res.system?.pool).toBe(5);
    expect(res.successes).toBe(2); // KNT-R-002: 4 and 6 are even
    expect(res.criticalFailure).toBe(false);
    expect(res.system?.exploited).toBe(false);
    expect(res.system?.base).toBe("force");
    expect(res.system?.combo).toBe("instinct");
    expect(res.system?.baseAspect).toBe("chair");
    expect(res.system?.comboAspect).toBe("bete");
    expect(res.system?.type).toBe("aspect");
  });

  it("knight clamps each effective characteristic to zero before summing the combo pool", async () => {
    const evaluate = vi.fn(async () => d6pool([4, 3]));
    const { formulas } = stubKnight(evaluate, {
      aspects: {
        chair: { value: -2, caracteristiques: { force: { value: -1 } } },
        bete: { value: 5, caracteristiques: { instinct: { value: 2 } } },
      },
    });

    await rollAction(
      { actorId: "vex", type: "aspect", options: { base: "force", combo: "instinct" } },
      {} as never,
    );

    expect(formulas).toEqual(["2d6"]); // max(0, min(-1, -2)) + min(2, 5)
  });

  it("knight rejects the same characteristic in base and combo with invalid_args (KNT-R-001)", async () => {
    stubKnight(vi.fn());
    try {
      await rollAction(
        { actorId: "vex", type: "aspect", options: { base: "force", combo: "force" } },
        {} as never,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe("invalid_args");
    }
    // Missing either side is also invalid_args.
    await expect(
      rollAction({ actorId: "vex", type: "aspect", options: { base: "force" } }, {} as never),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("knight rejects a characteristic outside the KNT-R-006 graph with invalid_args", async () => {
    stubKnight(vi.fn());
    try {
      await rollAction(
        { actorId: "vex", type: "aspect", options: { base: "force", combo: "jetpack" } },
        {} as never,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe("invalid_args");
    }
  });

  it("knight flags criticalFailure when the first pool has no even die (KNT-R-003)", async () => {
    const evaluate = vi.fn(async () => d6pool([1, 3, 5, 1, 3])); // all odd
    stubKnight(evaluate);

    const res = (await rollAction(
      { actorId: "vex", type: "aspect", options: { base: "force", combo: "instinct" } },
      {} as never,
    )) as { successes?: number; criticalFailure?: boolean; system?: { exploited?: boolean; criticalFailure?: boolean } };

    expect(res.successes).toBe(0);
    expect(res.criticalFailure).toBe(true);
    expect(res.system?.criticalFailure).toBe(true);
    expect(res.system?.exploited).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(1); // no reroll on a critical failure
  });

  it("knight exploit: all-even first pool rerolls the same-size pool ONCE and adds successes (KNT-R-003)", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(d6pool([2, 4, 6, 2, 4])) // 5/5 even → exploit
      .mockResolvedValueOnce(d6pool([4, 2, 1, 3, 5])); // reroll: +2 successes
    const { formulas } = stubKnight(evaluate);

    const res = (await rollAction(
      { actorId: "vex", type: "aspect", options: { base: "force", combo: "instinct" } },
      {} as never,
    )) as {
      successes?: number;
      criticalFailure?: boolean;
      dice: Array<{ results: number[] }>;
      system?: { exploited?: boolean };
    };

    expect(evaluate).toHaveBeenCalledTimes(2); // exactly one reroll — never chained
    expect(formulas).toEqual(["5d6", "5d6"]); // same-size reroll
    expect(res.successes).toBe(7); // 5 + 2 — not an auto-pass, the app still compares to target
    expect(res.system?.exploited).toBe(true);
    expect(res.criticalFailure).toBe(false);
    expect(res.dice).toHaveLength(2);
  });

  it("knight adds bonus dice on top of the combo pool", async () => {
    const evaluate = vi.fn(async () => d6pool([1, 3, 5, 1, 3, 1, 3])); // no exploit
    const { formulas } = stubKnight(evaluate);

    await rollAction(
      { actorId: "vex", type: "aspect", options: { base: "force", combo: "instinct", bonus: 2 } },
      {} as never,
    );

    expect(formulas).toEqual(["7d6"]); // 3 + 2 + 2 bonus
  });

  it("knight accepts the singular 'caracteristique' spelling defensively", async () => {
    const evaluate = vi.fn(async () => d6pool([4, 6, 1, 1, 1, 1])); // no exploit
    const { formulas } = stubKnight(evaluate, {
      aspects: {
        chair: { value: 3, caracteristique: { force: { value: 4 } } }, // singular bag
        bete: { value: 5, caracteristique: { instinct: { value: 3 } } },
      },
    });

    await rollAction(
      { actorId: "vex", type: "aspect", options: { base: "force", combo: "instinct" } },
      {} as never,
    );

    expect(formulas).toEqual(["6d6"]); // min(4,3)=3 + min(3,5)=3
  });

  it("knight throws a plain error when a characteristic value is missing so the app rolls locally", async () => {
    stubKnight(vi.fn());
    // 'endurance' is in the KNT-R-006 graph (chair) but absent from this actor's data.
    await expect(
      rollAction(
        { actorId: "vex", type: "aspect", options: { base: "force", combo: "endurance" } },
        {} as never,
      ),
    ).rejects.toThrow(/has no value/);
  });

  it("throws for an unsupported type so the app falls back locally", async () => {
    vi.stubGlobal("game", { system: { id: "dnd5e" }, actors: { get: () => ({}) } });
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
