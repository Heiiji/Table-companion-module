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
  "effect.setValue",
  "ping",
  "presence",
  "roll.action",
  "roll.execute",
  "sheet.derived",
];

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

  it.each(["dnd5e", "knight", "custom-system"])(
    "keeps the complete non-PF2 capability set for %s",
    (systemId) => {
      vi.stubGlobal("game", { system: { id: systemId } });
      const registry = new ProcedureRegistry();

      registerBuiltinProcedures(registry);

      expect(registry.capabilities()).toEqual(NON_PF2_CAPABILITIES);
    },
  );
});
