import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";

/** roll.execute guard: reject formulas longer than this many characters, a cheap
 * first bound on complexity before we even construct a Roll. */
export const MAX_ROLL_FORMULA_LEN = 500;

/** roll.execute guard: reject a formula whose total dice count exceeds this, so a
 * request like "999999d6" (from a buggy/compromised agent, or a replay) can't
 * freeze the responder GM's browser inside `Roll#evaluate`. Every count must be
 * a static number, nested formulas included, so the budget is complete. */
export const MAX_ROLL_DICE = 1000;

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
    throw new RpcError(
      "invalid_args",
      "roll.execute requires a non-empty 'formula' string",
    );
  }
  if (formula.length > MAX_ROLL_FORMULA_LEN) {
    throw new RpcError("invalid_args", "roll.execute formula is too long");
  }

  // Construct (parses the formula; no RNG yet) so we can bound the dice budget
  // BEFORE evaluating — an unbounded "999999d6" would otherwise block the
  // responder GM's browser inside evaluate().
  const roll = new Roll(formula);
  if (diceBudget(roll, 0) > MAX_ROLL_DICE) {
    throw new RpcError(
      "invalid_args",
      "roll.execute formula exceeds the dice budget",
    );
  }

  await roll.evaluate();
  const dice = roll.dice.map((term) => ({
    faces: Number(term.faces ?? 0),
    results: term.results.map((r) => r.result),
  }));
  return { formula: roll.formula, total: roll.total ?? 0, dice };
};

/** How deep parenthetical / function / pool formulas may nest before the
 * budget refuses them. */
const MAX_ROLL_NESTING = 8;

type Term = Record<string, unknown>;

/** A die's count or faces, only when it is a static positive integer: a
 * dynamic one (`(99999999)d6`, `(1d6)d6`, `1d(@x)`) is a Roll that resolves
 * only during evaluation, so it cannot be budgeted beforehand. */
function staticPositive(term: Term, key: "number" | "faces"): number {
  const raw = `_${key}` in term ? term[`_${key}`] : term[key];
  if (!Number.isSafeInteger(raw) || (raw as number) < 1)
    throw new RpcError(
      "invalid_args",
      `roll.execute dice ${key === "number" ? "counts" : "faces"} must be static positive numbers`,
    );
  return raw as number;
}

/** Sum the dice count of a constructed (not-yet-evaluated) Roll by walking its
 * terms. A parenthetical, function or pool term builds its inner Rolls only
 * when evaluated (its `dice` are empty until then), so their formulas are
 * parsed here — constructing a Roll draws no dice — and budgeted too. */
function diceBudget(roll: Roll, depth: number): number {
  if (depth > MAX_ROLL_NESTING)
    throw new RpcError("invalid_args", "roll.execute formula nests too deep");
  let n = 0;
  for (const term of roll.terms as unknown as Term[]) {
    if ("_number" in term || ("number" in term && "faces" in term)) {
      staticPositive(term, "faces");
      n += staticPositive(term, "number");
      continue;
    }
    const formulas = [
      ...(typeof term.term === "string" ? [term.term] : []),
      ...(Array.isArray(term.terms) ? term.terms : []),
    ].filter((f): f is string => typeof f === "string");
    const inner = formulas.length
      ? formulas.map((f) => new Roll(f))
      : [term.roll, ...(Array.isArray(term.rolls) ? term.rolls : [])].filter(
          (r): r is Roll => typeof r === "object" && r !== null && "terms" in r,
        );
    for (const r of inner) n += diceBudget(r, depth + 1);
  }
  return n;
}
