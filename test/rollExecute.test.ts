import { afterEach, describe, expect, it, vi } from "vitest";
import { rollExecute } from "../src/procedures/rollExecute.js";
import { MAX_ROLL_DICE, MAX_ROLL_FORMULA_LEN } from "../src/constants.js";

afterEach(() => vi.unstubAllGlobals());

describe("roll.execute DoS caps", () => {
  it("rejects a formula longer than MAX_ROLL_FORMULA_LEN before constructing a Roll", async () => {
    const ctor = vi.fn();
    vi.stubGlobal("Roll", class {
      constructor(f: string) {
        ctor(f);
      }
    });
    const long = "1d6+".repeat(Math.ceil(MAX_ROLL_FORMULA_LEN / 4) + 5); // well over the cap
    await expect(rollExecute({ formula: long }, {} as never)).rejects.toThrow(/too long/);
    // The guard fires before we ever build a Roll.
    expect(ctor).not.toHaveBeenCalled();
  });

  it("rejects a formula whose dice budget exceeds MAX_ROLL_DICE before evaluating", async () => {
    const evaluate = vi.fn(async () => {});
    vi.stubGlobal("Roll", class {
      formula: string;
      dice = [{ number: MAX_ROLL_DICE + 1, faces: 6, results: [] as Array<{ result: number }> }];
      total = 0;
      evaluate = evaluate;
      constructor(f: string) {
        this.formula = f;
      }
    });
    await expect(rollExecute({ formula: `${MAX_ROLL_DICE + 1}d6` }, {} as never)).rejects.toThrow(/dice budget/);
    // Never rolled — the cap is enforced on the constructed (unevaluated) Roll.
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("evaluates and returns the pre-evaluated shape for an in-budget formula", async () => {
    const evaluate = vi.fn(async () => {});
    vi.stubGlobal("Roll", class {
      formula: string;
      dice = [{ number: 2, faces: 6, results: [{ result: 3 }, { result: 5 }] }];
      total = 8;
      evaluate = evaluate;
      constructor(f: string) {
        this.formula = f;
      }
    });
    const res = (await rollExecute({ formula: "2d6" }, {} as never)) as {
      formula: string;
      total: number;
      dice: Array<{ faces: number; results: number[] }>;
    };
    expect(evaluate).toHaveBeenCalledOnce();
    expect(res).toEqual({ formula: "2d6", total: 8, dice: [{ faces: 6, results: [3, 5] }] });
  });

  it("requires a non-empty formula", async () => {
    vi.stubGlobal("Roll", class {});
    await expect(rollExecute({ formula: "  " }, {} as never)).rejects.toThrow(/formula/);
    await expect(rollExecute({}, {} as never)).rejects.toThrow(/formula/);
  });
});
