import { CHARACTERISTIC_KEYS } from "../../src/procedures/actorUpsert.types.js";
import { applyUpdate, type FakeActor } from "./actorUpsertHarness.js";

/**
 * A Knight player character that behaves like Foundry 14 running Knight
 * 3.58.38 for the sheet values: the stored data (`source`) and the prepared
 * `actor.system` are kept apart, and every accepted update re-prepares the
 * system with Knight's own formula, so a value read after a write is what
 * Foundry computes, never an echo of the request.
 *
 * - An aspect is `max(min(max(base + Σbonus − Σmalus, 0), max) + Σopti, 0)`,
 *   the largest `override` winning; a characteristic is
 *   `max(min(aspect, base + Σbonus − Σmalus) + Σopti, 0)`.
 * - Knight's in-memory terms are added as plain enumerable keys: each XP
 *   purchase line's `bonus` as `bonus.experience` on its characteristic, each
 *   wound as `malus.blessures` on its aspect.
 * - `progression.experience.actuel` is `total − Σ cout` of the purchase lines.
 * - Glory: `progression.gloire.depense.liste` lists the « other expense »
 *   lines of `depense.autre` (numeric order, the id, the cost) and, when
 *   `itemsSpent` is set, one entry standing for the Items Knight prices (at
 *   order `itemsOrder`, 1 by default); `depense.total` is the sum of
 *   `parseInt` of their costs (a cost Knight's own « + » stores as the string
 *   `'0'` included), `actuel = total − depense.total`. `ignoredLines` makes
 *   Knight skip those line ids (a Foundry that does not prepare the write).
 * - The prepared numbers are defined over the stored `value` (which stays 0),
 *   as Knight's `Object.defineProperty`.
 * - `refuse` makes Foundry drop the update: nothing changes, the promise
 *   resolves `undefined`. An applied update resolves the document.
 */
export interface KnightSheetState {
  source: Record<string, any>;
  /** Wounds per aspect (Knight derives them from wound Items). */
  wounds: Record<string, number>;
  refuse: boolean;
  /** Glory spent on Items (armour modules, weapons, cyberware). */
  itemsSpent?: number;
  itemsOrder?: number;
  ignoredLines?: string[];
  /** Runs after each preparation (to fake an odd prepared value). */
  after?: (system: Record<string, any>) => void;
}

const sum = (o: unknown): number =>
  Object.values((o ?? {}) as Record<string, unknown>).reduce<number>(
    (acc, v) => acc + (Number(v) || 0),
    0,
  );
const top = (o: unknown): number =>
  Object.values((o ?? {}) as Record<string, unknown>).reduce<number>(
    (acc, v) => Math.max(acc, Number(v) || 0),
    0,
  );
const define = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, { value, configurable: true });

export function prepareKnight(state: KnightSheetState): Record<string, any> {
  const system = structuredClone(state.source);
  const xp = system.progression.experience;
  const lines = Object.values(xp.depense.liste ?? {}) as Array<
    Record<string, any>
  >;
  for (const [a, characteristics] of Object.entries(CHARACTERISTIC_KEYS)) {
    const aspect = system.aspects[a];
    if (state.wounds[a]) aspect.malus.blessures = state.wounds[a];
    const value =
      top(aspect.override) ||
      Math.max(
        Math.min(
          Math.max(aspect.base + sum(aspect.bonus) - sum(aspect.malus), 0),
          aspect.max,
        ) +
          sum(aspect.optimisation.bonus) -
          sum(aspect.optimisation.malus),
        0,
      );
    define(aspect, "value", value);
    for (const c of characteristics) {
      const ch = aspect.caracteristiques[c];
      const bought = lines
        .filter((line) => line.caracteristique === c)
        .reduce((acc, line) => acc + Number(line.bonus), 0);
      if (bought) ch.bonus.experience = bought;
      define(
        ch,
        "value",
        top(ch.override) ||
          Math.max(
            Math.min(value, ch.base + sum(ch.bonus) - sum(ch.malus)) +
              sum(ch.optimisation.bonus) -
              sum(ch.optimisation.malus),
            0,
          ),
      );
    }
  }
  const spent = lines.reduce((acc, line) => acc + Number(line.cout), 0);
  define(xp.depense, "total", spent);
  define(xp, "actuel", xp.total - spent);
  const glory = system.progression.gloire;
  const liste: Array<Record<string, unknown>> = [];
  if (state.itemsSpent !== undefined)
    liste.push({ order: state.itemsOrder ?? 1, value: state.itemsSpent });
  for (const [id, line] of Object.entries(
    (glory.depense.autre ?? {}) as Record<string, Record<string, unknown>>,
  ))
    if (!state.ignoredLines?.includes(id))
      liste.push({
        order: Number(line.order),
        name: line.nom,
        id,
        gratuit: line.gratuit,
        value: line.cout ?? 0,
        isAutre: true,
      });
  define(glory.depense, "liste", liste);
  define(
    glory.depense,
    "total",
    liste.reduce((acc, e) => acc + parseInt(String(e.value)), 0),
  );
  define(glory, "actuel", glory.total - glory.depense.total);
  state.after?.(system);
  return system;
}

const node = (base: number) => ({
  base,
  bonus: {},
  malus: {},
  optimisation: { bonus: {}, malus: {} },
  override: {},
  value: 0,
});

/** The stored sheet data of a PC: aspects at `bases[a]` (else 2, Knight's
 * initial), characteristics at `bases[c]` (else 1), aspect max 9. */
export function knightSheetSource(
  bases: Record<string, number> = {},
): Record<string, any> {
  return {
    aspects: Object.fromEntries(
      Object.entries(CHARACTERISTIC_KEYS).map(([a, cs]) => [
        a,
        {
          ...node(bases[a] ?? 2),
          max: 9,
          caracteristiques: Object.fromEntries(
            cs.map((c) => [
              c,
              { ...node(bases[c] ?? 1), overdrive: { base: 0, value: 0 } },
            ]),
          ),
        },
      ]),
    ),
    progression: {
      experience: { total: 0, depense: { liste: {} } },
      gloire: { total: 0, depense: { autre: {} } },
    },
    age: "",
    surnom: "",
    motivations: { majeure: "" },
  };
}

/** Turn `actor` into a Knight PC whose stored data is its current `system`
 * plus `sheet`, prepared as Foundry does after every accepted update. */
export function withKnightSheet(
  actor: FakeActor,
  sheet: Record<string, any> = knightSheetSource(),
  wounds: Record<string, number> = {},
): KnightSheetState {
  const state: KnightSheetState = {
    source: { ...structuredClone(actor.system), ...sheet },
    wounds,
    refuse: false,
  };
  actor.system = prepareKnight(state);
  actor.update = async (changes) => {
    actor.events.push("update");
    actor.updates.push(changes);
    if (state.refuse) return undefined as never;
    const stored = {
      name: actor.name,
      flags: actor.flags,
      system: state.source,
    };
    applyUpdate(stored, changes);
    actor.name = stored.name;
    actor.flags = stored.flags;
    state.source = stored.system;
    actor.system = prepareKnight(state);
    return actor as never;
  };
  return state;
}

/** Re-prepare after a test changed `state` directly (a Foundry-side edit). */
export function reprepare(actor: FakeActor, state: KnightSheetState): void {
  actor.system = prepareKnight(state);
}
