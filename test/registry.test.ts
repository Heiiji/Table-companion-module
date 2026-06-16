import { describe, expect, it, vi } from "vitest";
import { ProcedureRegistry } from "../src/rpc/registry.js";

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
});
