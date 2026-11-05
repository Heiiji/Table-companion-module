import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ROLL_DICE,
  MAX_ROLL_FORMULA_LEN,
  rollExecute,
} from "../src/procedures/rollExecute.js";

afterEach(() => vi.unstubAllGlobals());

describe("roll.execute DoS caps", () => {
  it("rejects a formula longer than MAX_ROLL_FORMULA_LEN before constructing a Roll", async () => {
    const ctor = vi.fn();
    vi.stubGlobal(
      "Roll",
      class {
        constructor(f: string) {
          ctor(f);
        }
      },
    );
    const long = "1d6+".repeat(Math.ceil(MAX_ROLL_FORMULA_LEN / 4) + 5); // well over the cap
    await expect(rollExecute({ formula: long }, {} as never)).rejects.toThrow(
      /too long/,
    );
    // The guard fires before we ever build a Roll.
    expect(ctor).not.toHaveBeenCalled();
  });

  it("rejects a formula whose dice budget exceeds MAX_ROLL_DICE before evaluating", async () => {
    const evaluate = vi.fn(async () => {});
    vi.stubGlobal(
      "Roll",
      class {
        formula: string;
        dice = [
          {
            number: MAX_ROLL_DICE + 1,
            faces: 6,
            results: [] as Array<{ result: number }>,
          },
        ];
        terms = this.dice;
        total = 0;
        evaluate = evaluate;
        constructor(f: string) {
          this.formula = f;
        }
      },
    );
    await expect(
      rollExecute({ formula: `${MAX_ROLL_DICE + 1}d6` }, {} as never),
    ).rejects.toThrow(/dice budget/);
    // Never rolled — the cap is enforced on the constructed (unevaluated) Roll.
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("evaluates and returns the pre-evaluated shape for an in-budget formula", async () => {
    const evaluate = vi.fn(async () => {});
    vi.stubGlobal(
      "Roll",
      class {
        formula: string;
        dice = [
          { number: 2, faces: 6, results: [{ result: 3 }, { result: 5 }] },
        ];
        terms = this.dice;
        total = 8;
        evaluate = evaluate;
        constructor(f: string) {
          this.formula = f;
        }
      },
    );
    const res = (await rollExecute({ formula: "2d6" }, {} as never)) as {
      formula: string;
      total: number;
      dice: Array<{ faces: number; results: number[] }>;
    };
    expect(evaluate).toHaveBeenCalledOnce();
    expect(res).toEqual({
      formula: "2d6",
      total: 8,
      dice: [{ faces: 6, results: [3, 5] }],
    });
  });

  it("refuses dynamic and nested dice counts the budget cannot see before evaluating", async () => {
    // Parsed shapes as Foundry builds them, before evaluation: a dynamic count
    // or faces is a Roll; a parenthetical, function or pool holds formulas.
    const die = (number: unknown, faces: unknown = 6) => ({
      _number: number,
      _faces: faces,
      get number() {
        return typeof number === "number" ? number : undefined;
      },
    });
    const parsed: Record<string, Array<Record<string, unknown>>> = {
      "(99999999)d6": [die({ terms: [{ number: 99999999 }] })],
      "1d(99999999)": [die(1, { terms: [{ number: 99999999 }] })],
      "(99999999d6)": [{ term: "99999999d6" }],
      "99999999d6": [die(99999999)],
      "floor(600d6/2)+(600d6)": [
        { fn: "floor", terms: ["600d6/2"] },
        { operator: "+" },
        { term: "600d6" },
      ],
      "600d6/2": [die(600), { operator: "/" }, { number: 2 }],
      "600d6": [die(600)],
      "{2d6, 3d8}kh": [{ terms: ["2d6", "3d8"] }],
      "2d6": [die(2)],
      "3d8": [die(3, 8)],
      "0d6": [die(0)],
      "((((((((((1d6))))))))))": [{ term: "(((((((((1d6)))))))))" }],
    };
    for (let depth = 9; depth >= 0; depth -= 1)
      parsed[`${"(".repeat(depth)}1d6${")".repeat(depth)}`] =
        depth === 0
          ? [die(1)]
          : [{ term: `${"(".repeat(depth - 1)}1d6${")".repeat(depth - 1)}` }];
    const evaluate = vi.fn(async () => {});
    vi.stubGlobal(
      "Roll",
      class {
        formula: string;
        terms: Array<Record<string, unknown>>;
        dice = [];
        total = 0;
        evaluate = evaluate;
        constructor(f: string) {
          this.formula = f;
          this.terms = parsed[f] ?? [];
        }
      },
    );
    const run = (formula: string) => rollExecute({ formula }, {} as never);
    for (const formula of [
      "(99999999)d6",
      "1d(99999999)",
      "(99999999d6)",
      "floor(600d6/2)+(600d6)",
      "0d6",
      "((((((((((1d6))))))))))",
    ])
      await expect(run(formula), formula).rejects.toMatchObject({
        code: "invalid_args",
      });
    expect(evaluate).not.toHaveBeenCalled();
    await expect(run("{2d6, 3d8}kh")).resolves.toBeDefined();
    await expect(run("((1d6))")).resolves.toBeDefined();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("reports validation failures as invalid_args", async () => {
    vi.stubGlobal("Roll", class {});
    await expect(
      rollExecute({ formula: "" }, {} as never),
    ).rejects.toMatchObject({
      code: "invalid_args",
    });
  });

  it("requires a non-empty formula", async () => {
    vi.stubGlobal("Roll", class {});
    await expect(rollExecute({ formula: "  " }, {} as never)).rejects.toThrow(
      /formula/,
    );
    await expect(rollExecute({}, {} as never)).rejects.toThrow(/formula/);
  });
});
