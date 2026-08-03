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

// The system-aware oracles. Added on top of the floor ONLY for a system with a
// verified contract (ADMITTED_ORACLE_SYSTEMS in src/procedures/foundry.ts).
// An unadmitted system — PF2e, a homebrew system, anything unproven — gets the
// floor and nothing more. FAIL CLOSED.
const ORACLE_CAPABILITIES = [
  "effect.apply",
  "effect.remove",
  "roll.action",
  "sheet.derived",
];

// Never advertised on ANY system — no implementation exists. Registering it
// would be a promise the module cannot keep, and the apps feature-detect on the
// advertised set. See the tombstone in src/procedures/effects.ts.
const NEVER_ADVERTISED = ["effect.setValue"];

const ADMITTED_CAPABILITIES = [
  ...BASE_CAPABILITIES,
  ...ORACLE_CAPABILITIES,
].sort();

const KNIGHT_CAPABILITIES = [
  "actor.upsert.v1",
  ...ADMITTED_CAPABILITIES,
].sort();

// Every procedure that writes a Foundry document. The agent mirrors this in Go
// and routes its fallback on it: a read that times out may fall back silently to
// the app's local engine, a mutation with an unknown outcome may NOT. Keep in
// step with docs/CONTRACTS.md.
const MUTATION_PROCEDURES = ["actor.upsert.v1", "effect.apply", "effect.remove"];

const READ = { kind: "read" } as const;

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
    for (const procedure of RETIRED_OR_UNSAFE_PF2_PROCEDURES) {
      expect(registry.get(procedure), procedure).toBeUndefined();
    }
    expect(actorLookup).not.toHaveBeenCalled();
  });

  // The heart of the fail-closed rule: an unproven system is treated exactly
  // like PF2e. PF2e used to be carved out BY NAME while every other unknown
  // system silently kept the whole oracle surface — which had it backwards,
  // since the systems we have never looked at are the ones we can vouch for
  // least. "custom-system" here stands for every system nobody has verified.
  it.each(["custom-system", "homebrew", "swade", ""])(
    "withholds the system-aware oracles from unadmitted system %s",
    (systemId) => {
      const actorLookup = vi.fn();
      vi.stubGlobal("game", {
        system: { id: systemId },
        actors: { get: actorLookup },
      });
      const registry = new ProcedureRegistry();

      registerBuiltinProcedures(registry);

      expect(registry.capabilities()).toEqual(BASE_CAPABILITIES);
      for (const procedure of ORACLE_CAPABILITIES) {
        expect(registry.get(procedure), procedure).toBeUndefined();
      }
      expect(actorLookup).not.toHaveBeenCalled();
    },
  );

  it("adds the system-aware oracles for an admitted system", () => {
    vi.stubGlobal("game", { system: { id: "dnd5e" } });
    const registry = new ProcedureRegistry();

    registerBuiltinProcedures(registry);

    expect(registry.capabilities()).toEqual(ADMITTED_CAPABILITIES);
  });

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
  // EVERY roster, so this sweeps genuinely different capability sets (the bare
  // floor an unadmitted system gets, the admitted-oracle set, and Knight's
  // superset) rather than trusting one fixture to stand in for the rest.
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
      // A procedure that touches an Actor must say which permission it enforces,
      // so the declared contract can be checked against the handler.
      if (d.systems) expect(d.minPermission, name).toBeDefined();
    }
  });

  it("declares exactly the known mutations, and only where admitted", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.33" },
      release: { generation: 14 },
    });
    const knight = new ProcedureRegistry();
    registerBuiltinProcedures(knight);
    expect(knight.mutations()).toEqual([...MUTATION_PROCEDURES].sort());

    // An unadmitted system exposes NO mutation at all — nothing it advertises
    // can write to the world.
    vi.stubGlobal("game", { system: { id: "custom-system" } });
    const unadmitted = new ProcedureRegistry();
    registerBuiltinProcedures(unadmitted);
    expect(unadmitted.mutations()).toEqual([]);
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
      expect(registry.capabilities()).toEqual(ADMITTED_CAPABILITIES);
    }
  });
});
