import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";

const PF2_CAPABILITIES = [
  "compendium.get",
  "compendium.index",
  "display.clear",
  "display.show",
  "ping",
  "presence",
  "roll.execute",
];

const NON_PF2_CAPABILITIES = [
  "compendium.get",
  "compendium.index",
  "display.clear",
  "display.show",
  "effect.apply",
  "effect.remove",
  "ping",
  "presence",
  "roll.action",
  "roll.execute",
  "sheet.derived",
];

// Never advertised on ANY system — no implementation exists. Registering it
// would be a promise the module cannot keep, and the apps feature-detect on the
// advertised set. See the tombstone in src/procedures/effects.ts.
const NEVER_ADVERTISED = ["effect.setValue"];

const KNIGHT_CAPABILITIES = ["actor.upsert.v1", ...NON_PF2_CAPABILITIES].sort();

const RETIRED_OR_UNSAFE_PF2_PROCEDURES = [
  "pf2e.advancement.preview",
  "pf2e.advancement.apply",
  "pf2e.operation.status",
  "sheet.derived",
  "roll.action",
  "effect.apply",
  "effect.remove",
  "effect.setValue",
];

afterEach(() => vi.unstubAllGlobals());

describe("ProcedureRegistry", () => {
  it("registers, gets, and reports has()", () => {
    const r = new ProcedureRegistry();
    const fn = () => 1;
    r.register("ping", fn);
    expect(r.get("ping")).toBe(fn);
    expect(r.has("ping")).toBe(true);
    expect(r.has("missing")).toBe(false);
    expect(r.get("missing")).toBeUndefined();
  });

  it("returns a sorted, stable capability list", () => {
    const r = new ProcedureRegistry();
    r.register("presence", () => 1);
    r.register("ping", () => 1);
    r.register("roll.execute", () => 1);
    expect(r.capabilities()).toEqual(["ping", "presence", "roll.execute"]);
  });

  it("warns when a procedure name is overwritten", () => {
    const r = new ProcedureRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    r.register("ping", () => 1);
    r.register("ping", () => 2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("advertises only class-neutral and transient procedures for PF2e", () => {
    const actorLookup = vi.fn();
    vi.stubGlobal("game", {
      system: { id: "pf2e", version: "8.3.0" },
      actors: { get: actorLookup },
      version: "14.364",
    });

    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);

    expect(registry.capabilities()).toEqual(PF2_CAPABILITIES);
    for (const procedure of RETIRED_OR_UNSAFE_PF2_PROCEDURES) {
      expect(registry.get(procedure), procedure).toBeUndefined();
    }
    expect(actorLookup).not.toHaveBeenCalled();
  });

  it.each(["dnd5e", "custom-system"])(
    "keeps the complete non-PF2 capability set for %s",
    (systemId) => {
      vi.stubGlobal("game", { system: { id: systemId } });
      const registry = new ProcedureRegistry();

      registerBuiltinProcedures(registry);

      expect(registry.capabilities()).toEqual(NON_PF2_CAPABILITIES);
    },
  );

  it("registers actor.upsert.v1 only for Knight", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.33" },
      release: { generation: 14 },
    });
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).toEqual(KNIGHT_CAPABILITIES);
  });

  // Totality, not a spot-check: an unimplemented procedure must be absent from
  // EVERY roster, so this sweeps genuinely different capability sets (PF2e's
  // clean-cut set, the generic non-PF2 set, and Knight's superset) rather than
  // trusting one fixture to stand in for the rest.
  it.each([
    ["pf2e", { system: { id: "pf2e", version: "8.3.0" }, version: "14.364" }],
    ["dnd5e", { system: { id: "dnd5e" } }],
    ["custom-system", { system: { id: "custom-system" } }],
    [
      "knight",
      {
        system: { id: "knight", version: "3.58.33" },
        release: { generation: 14 },
      },
    ],
  ])("never advertises an unimplemented procedure on %s", (_label, game) => {
    vi.stubGlobal("game", { actors: { get: vi.fn() }, ...game });
    const registry = new ProcedureRegistry();

    registerBuiltinProcedures(registry);

    const advertised = registry.capabilities();
    for (const procedure of NEVER_ADVERTISED) {
      expect(advertised, procedure).not.toContain(procedure);
      expect(registry.get(procedure), procedure).toBeUndefined();
    }
  });

  it("does not advertise actor.upsert.v1 outside the exact fixture-pinned Knight runtime", () => {
    for (const game of [
      {
        system: { id: "knight", version: "3.58.34" },
        release: { generation: 14 },
      },
      {
        system: { id: "knight", version: "3.58.33" },
        release: { generation: 15 },
      },
    ]) {
      vi.stubGlobal("game", game);
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities()).toEqual(NON_PF2_CAPABILITIES);
    }
  });
});
