import { MAX_ROLL_DICE, MAX_ROLL_FORMULA_LEN } from "../constants.js";
import type { Procedure } from "../rpc/registry.js";

/**
 * Run a formula through Foundry core's dice evaluator and return its faces, total, and formula.
 * This is dice evaluation only: it carries no Actor/check context, target, DC, visibility, modifier
 * provenance, or PF2e degree of success. Callers must never present it as a PF2e check outcome.
 * The app falls back to its local formula engine when the procedure is absent or fails, preserving
 * standalone-first behavior.
 *
 * Payload: `{ formula: string }`. Response: `{ formula, total, dice: [{ faces, results }] }` — the same
 * pre-evaluated shape the app already maps into a DiceRoll.
 */
export const rollExecute: Procedure = async (payload) => {
  const formula =
    payload &&
    typeof payload === "object" &&
    "formula" in payload &&
    typeof (payload as { formula: unknown }).formula === "string"
      ? (payload as { formula: string }).formula
      : "";
  if (!formula.trim()) {
    throw new Error("roll.execute requires a non-empty 'formula' string");
  }
  if (formula.length > MAX_ROLL_FORMULA_LEN) {
    throw new Error("roll.execute formula is too long");
  }

  // Construct (parses the formula; no RNG yet) so we can bound the dice budget
  // BEFORE evaluating — an unbounded "999999d6" would otherwise block the
  // responder GM's browser inside evaluate().
  const roll = new Roll(formula);
  if (totalDice(roll) > MAX_ROLL_DICE) {
    throw new Error("roll.execute formula exceeds the dice budget");
  }

  await roll.evaluate();
  const dice = roll.dice.map((term) => ({
    faces: Number(term.faces ?? 0),
    results: term.results.map((r) => r.result),
  }));
  return { formula: roll.formula, total: roll.total ?? 0, dice };
};

/** Sum the dice count across a constructed (not-yet-evaluated) Roll. `roll.dice`
 * flattens pool terms, so this catches dice nested in pools too. Static counts
 * (e.g. the 999999 in "999999d6") are known pre-evaluate; dynamic counts that
 * resolve only during evaluation read as 0 here — the formula-length cap bounds
 * those. */
function totalDice(roll: Roll): number {
  let n = 0;
  for (const die of roll.dice) {
    const count = (die as { number?: number | null }).number ?? 0;
    if (count > 0) n += count;
  }
  return n;
}
