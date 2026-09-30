import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";

// The system-agnostic floor: what EVERY world gets, whatever system it runs.
// These touch no system-specific schema (core Roll API, compendium passthrough,
// a projector popout), so there is nothing to verify per system.
const BASE_CAPABILITIES = [
  "compendium.get",
  "compendium.index",
  "display.clear",
  "display.show",
  "ping",
  "presence",
  "roll.execute",
];

// Never advertised on ANY system. The system-aware oracle procedures were
// removed in 0.11.0 (no agent or app ever called them), and `effect.setValue`
// never had an implementation. The apps feature-detect on the advertised set,
// so a name here reappearing would be a promise the module cannot keep.
const NEVER_ADVERTISED = [
  "effect.apply",
  "effect.remove",
  "effect.setValue",
  "roll.action",
  "sheet.derived",
];

const KNIGHT_CAPABILITIES = [
  "actor.upsert.v1",
  "npc.upsert.v1",
  ...BASE_CAPABILITIES,
].sort();

// Every procedure that writes a Foundry document. The agent mirrors this list
// and routes its fallback on it: a read that times out may fall back silently
// to the app's local engine, a mutation with an unknown outcome may NOT.
const MUTATION_PROCEDURES = ["actor.upsert.v1", "npc.upsert.v1"];

const READ = { kind: "read" } as const;

const RETIRED_PF2_PROCEDURES = [
  "pf2e.advancement.preview",
  "pf2e.advancement.apply",
  "pf2e.operation.status",
  ...NEVER_ADVERTISED,
];

afterEach(() => vi.unstubAllGlobals());

describe("ProcedureRegistry", () => {
  it("registers, gets, and reports has()", () => {
    const r = new ProcedureRegistry();
    const fn = () => 1;
    r.register("ping", fn, READ);
    expect(r.get("ping")).toBe(fn);
    expect(r.has("ping")).toBe(true);
    expect(r.has("missing")).toBe(false);
    expect(r.get("missing")).toBeUndefined();
  });

  it("returns a sorted, stable capability list", () => {
    const r = new ProcedureRegistry();
    r.register("presence", () => 1, READ);
    r.register("ping", () => 1, READ);
    r.register("roll.execute", () => 1, READ);
    expect(r.capabilities()).toEqual(["ping", "presence", "roll.execute"]);
  });

  it("reports signed-only only for procedures registered with the flag", () => {
    const r = new ProcedureRegistry();
    r.register("ping", () => 1, READ);
    r.register("write", () => 1, { kind: "mutation" });
    r.register("signed.write", () => 1, { kind: "mutation", signedOnly: true });
    expect(r.isSignedOnly("ping")).toBe(false);
    expect(r.isSignedOnly("write")).toBe(false);
    expect(r.isSignedOnly("signed.write")).toBe(true);
    expect(r.isSignedOnly("missing")).toBe(false);
  });

  it("warns when a procedure name is overwritten", () => {
    const r = new ProcedureRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    r.register("ping", () => 1, READ);
    r.register("ping", () => 2, READ);
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

    expect(registry.capabilities()).toEqual(BASE_CAPABILITIES);
    for (const procedure of RETIRED_PF2_PROCEDURES) {
      expect(registry.get(procedure), procedure).toBeUndefined();
    }
    expect(actorLookup).not.toHaveBeenCalled();
  });

  // Every system that is not the fixture-pinned Knight runtime gets exactly the
  // system-agnostic floor, and touches no actor to decide it.
  it.each(["dnd5e", "custom-system", "homebrew", "swade", ""])(
    "advertises exactly the floor on system %s",
    (systemId) => {
      const actorLookup = vi.fn();
      vi.stubGlobal("game", {
        system: { id: systemId },
        actors: { get: actorLookup },
      });
      const registry = new ProcedureRegistry();

      registerBuiltinProcedures(registry);

      expect(registry.capabilities()).toEqual(BASE_CAPABILITIES);
      expect(actorLookup).not.toHaveBeenCalled();
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

  // Totality, not a spot-check: a removed or unimplemented procedure must be
  // absent from EVERY roster, so this sweeps genuinely different capability
  // sets (the floor and Knight's superset) rather than trusting one fixture.
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

  // Derived from the registry, not restated beside it: the point is that NOTHING
  // can reach the advertised set without a classification, so asserting a second
  // hand-written roster here would only prove the two literals match.
  it.each([
    ["pf2e", { system: { id: "pf2e", version: "8.3.0" }, version: "14.364" }],
    ["dnd5e", { system: { id: "dnd5e" } }],
    [
      "knight",
      {
        system: { id: "knight", version: "3.58.33" },
        release: { generation: 14 },
      },
    ],
  ])("classifies every advertised procedure on %s", (_label, game) => {
    vi.stubGlobal("game", { actors: { get: vi.fn() }, ...game });
    const registry = new ProcedureRegistry();

    registerBuiltinProcedures(registry);

    const descriptors = registry.descriptors();
    for (const name of registry.capabilities()) {
      const d = descriptors[name];
      expect(d, name).toBeDefined();
      expect(["read", "mutation", "clientState"], name).toContain(d.kind);
    }
  });

  it("declares exactly the known mutations, and only on Knight", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.33" },
      release: { generation: 14 },
    });
    const knight = new ProcedureRegistry();
    registerBuiltinProcedures(knight);
    expect(knight.mutations()).toEqual([...MUTATION_PROCEDURES].sort());

    // Any other system exposes NO mutation at all — nothing it advertises can
    // write to the world.
    for (const id of ["dnd5e", "custom-system"]) {
      vi.stubGlobal("game", { system: { id } });
      const other = new ProcedureRegistry();
      registerBuiltinProcedures(other);
      expect(other.mutations(), id).toEqual([]);
    }
  });

  // The channel withholds a signed-only procedure from a responder that cannot
  // sign; the flag at registration is what puts the two upserts behind it.
  it("registers exactly the Knight upserts as signed-only", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.33" },
      release: { generation: 14 },
    });
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(
      registry.capabilities().filter((name) => registry.isSignedOnly(name)),
    ).toEqual([...MUTATION_PROCEDURES].sort());
  });

  it("advertises the Knight upserts on every Foundry generation from 13 up", () => {
    for (const generation of [13, 14, 15, 16, 20]) {
      vi.stubGlobal("game", {
        system: { id: "knight", version: "3.58.33" },
        release: { generation },
      });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities()).toContain("actor.upsert.v1");
      expect(registry.capabilities()).toContain("npc.upsert.v1");
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
        release: { generation: 12 },
      },
    ]) {
      vi.stubGlobal("game", game);
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities()).toEqual(BASE_CAPABILITIES);
    }
  });
});
