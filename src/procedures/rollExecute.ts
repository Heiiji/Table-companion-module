import type { Procedure } from "../rpc/registry.js";

/**
 * M4: run a real roll through Foundry's own dice pipeline and return the evaluated result, so the app
 * can get system-exact rolls (e.g. pf2e degree-of-success) when this capability is advertised. The app
 * falls back to its local engine when the procedure is absent or fails — standalone-first is preserved,
 * so this is strictly additive enrichment.
 *
 * Payload: `{ formula: string }`. Response: `{ formula, total, dice: [{ faces, results }] }` — the same
 * pre-evaluated shape the app already maps into a DiceRoll.
 */
export const rollExecute: Procedure = async (payload) => {
  const formula =
    payload && typeof payload === "object" && "formula" in payload &&
    typeof (payload as { formula: unknown }).formula === "string"
      ? (payload as { formula: string }).formula
      : "";
  if (!formula.trim()) {
    throw new Error("roll.execute requires a non-empty 'formula' string");
  }

  const roll = await new Roll(formula).evaluate();
  const dice = roll.dice.map((term) => ({
    faces: Number(term.faces ?? 0),
    results: term.results.map((r) => r.result),
  }));
  return { formula: roll.formula, total: roll.total ?? 0, dice };
};
