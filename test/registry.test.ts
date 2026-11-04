import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import {
  isAdmittedKnightSystemVersion,
  MINIMUM_KNIGHT_UPSERT_SYSTEM_VERSION,
} from "../src/procedures/upsertShared.js";

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

// Every system on Foundry 13 or later: the floor plus the core-document combat
// mirror (Combat and Combatant are not system-specific).
const MODERN_CAPABILITIES = ["combat.sync.v1", ...BASE_CAPABILITIES].sort();

const KNIGHT_ONLY_MUTATIONS = [
  "actor.items.v1",
  "actor.resources.v1",
  "actor.upsert.v1",
  "knight.attack.v1",
  "npc.upsert.v1",
];

// The Knight system's roller, as far as the attack lane feature-detects it.
const KNIGHT_ROLLER = {
  RollKnight: class {
    prepareWpnContact() {}
    prepareWpnDistance() {}
    doRoll() {}
  },
};

const KNIGHT_CAPABILITIES = [
  ...KNIGHT_ONLY_MUTATIONS,
  ...MODERN_CAPABILITIES,
].sort();

// Every procedure that writes a Foundry document. The agent mirrors this list
// and routes its fallback on it: a read that times out may fall back silently
// to the app's local engine, a mutation with an unknown outcome may NOT.
const MUTATION_PROCEDURES = [
  "actor.items.v1",
  "actor.resources.v1",
  "actor.upsert.v1",
  "combat.sync.v1",
  "knight.attack.v1",
  "npc.upsert.v1",
];

const READ = { kind: "read" } as const;

const RETIRED_PF2_PROCEDURES = [
  "pf2e.advancement.preview",
  "pf2e.advancement.apply",
  "pf2e.operation.status",
  ...NEVER_ADVERTISED,
];

afterEach(() => vi.unstubAllGlobals());

/** The Pathfinder 2e lanes: character draft, completion, live counters. */
const PF2E_LANES = [
  "pf2e.actor.upsert.v1",
  "pf2e.actor.complete.v1",
  "pf2e.resources.v1",
] as const;

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

  it("advertises only class-neutral and transient procedures on a pf2e below the floor", () => {
    const actorLookup = vi.fn();
    vi.stubGlobal("game", {
      system: { id: "pf2e", version: "8.3.0" },
      actors: { get: actorLookup },
      version: "14.364",
    });

    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);

    // No combat mirror either: the backend never writes to a PF2e world.
    expect(registry.capabilities()).toEqual(BASE_CAPABILITIES);
    for (const procedure of RETIRED_PF2_PROCEDURES) {
      expect(registry.get(procedure), procedure).toBeUndefined();
    }
    for (const lane of PF2E_LANES)
      expect(registry.unsupported()[lane], lane).toBe(
        "pf2e 8.3.0 on Foundry 14; requires pf2e 8.6.1 or later on Foundry 14",
      );
    expect(actorLookup).not.toHaveBeenCalled();
  });

  it("registers the three pf2e lanes only on pf2e 8.6.1 or later on Foundry 14 or later", () => {
    for (const version of ["8.6.1", "8.6.2", "8.7.0", "9.0.0"]) {
      vi.stubGlobal("game", {
        system: { id: "pf2e", version },
        release: { generation: 14 },
      });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      // Still no combat mirror: only the draft and completion lanes join the
      // floor.
      expect(registry.capabilities(), version).toEqual(
        [...PF2E_LANES, ...BASE_CAPABILITIES].sort(),
      );
      expect(registry.isSignedOnly("pf2e.resources.v1"), version).toBe(true);
      expect(registry.isSignedOnly("pf2e.actor.upsert.v1"), version).toBe(true);
      expect(registry.isSignedOnly("pf2e.actor.complete.v1"), version).toBe(
        true,
      );
      expect(registry.mutations(), version).toEqual([...PF2E_LANES].sort());
      expect(registry.unsupported(), version).toEqual({
        "combat.sync.v1": "combat mirroring is not available on pf2e",
      });
    }
    for (const [version, generation] of [
      ["8.6.0", 14],
      ["8.5.9", 14],
      ["v8.6.1", 14],
      ["8.6.1-beta", 14],
      ["8.6", 14],
      ["8.6.1", 13],
    ] as const) {
      vi.stubGlobal("game", {
        system: { id: "pf2e", version },
        release: { generation },
      });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities(), version).toEqual(BASE_CAPABILITIES);
      for (const lane of PF2E_LANES)
        expect(registry.unsupported()[lane], version).toBe(
          `pf2e ${version} on Foundry ${generation}; requires pf2e 8.6.1 or later on Foundry 14`,
        );
    }
    // Another system on an admitted version string never gets the lane,
    // nor a sibling built from the same tree.
    for (const id of ["sf2e", "dnd5e"]) {
      vi.stubGlobal("game", {
        system: { id, version: "8.6.1" },
        release: { generation: 14 },
      });
      const other = new ProcedureRegistry();
      registerBuiltinProcedures(other);
      for (const lane of PF2E_LANES) {
        expect(other.capabilities(), id).not.toContain(lane);
        expect(other.unsupported(), id).not.toHaveProperty(lane);
      }
    }
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

  it("names why the Knight upserts are withheld on another Knight version", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.32" },
      release: { generation: 14 },
    });
    const knight = new ProcedureRegistry();
    registerBuiltinProcedures(knight);
    expect(knight.capabilities()).toEqual(MODERN_CAPABILITIES);
    const withheld = knight.unsupported();
    expect(Object.keys(withheld).sort()).toEqual(KNIGHT_ONLY_MUTATIONS);
    expect(withheld["actor.upsert.v1"]).toBe(
      "Knight 3.58.32 on Foundry 14; requires Knight 3.58.33 or later on Foundry 13 or later",
    );

    // A dnd5e world withholds only its own lane, never the Knight ones.
    vi.stubGlobal("game", { system: { id: "dnd5e" } });
    const dnd = new ProcedureRegistry();
    registerBuiltinProcedures(dnd);
    expect(dnd.unsupported()).toEqual({
      "dnd5e.resources.v1":
        "dnd5e unknown on Foundry unknown; requires dnd5e 6.1.0 or later on Foundry 14 or later",
    });
  });

  it("registers dnd5e.resources.v1 only on dnd5e 6.1.0 or later on Foundry 14 or later", () => {
    for (const version of ["6.1.0", "6.1.1", "6.2.0", "7.0.0"]) {
      vi.stubGlobal("game", {
        system: { id: "dnd5e", version },
        release: { generation: 14 },
      });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities(), version).toEqual(
        ["dnd5e.resources.v1", ...MODERN_CAPABILITIES].sort(),
      );
      expect(registry.isSignedOnly("dnd5e.resources.v1"), version).toBe(true);
      expect(registry.mutations(), version).toEqual([
        "combat.sync.v1",
        "dnd5e.resources.v1",
      ]);
      expect(registry.unsupported(), version).toEqual({});
    }
    for (const [version, generation] of [
      ["6.0.9", 14],
      ["5.2.0", 14],
      ["v6.1.0", 14],
      ["6.1.0-beta", 14],
      ["6.1", 14],
      ["6.1.0", 13],
    ] as const) {
      vi.stubGlobal("game", {
        system: { id: "dnd5e", version },
        release: { generation },
      });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities(), version).not.toContain(
        "dnd5e.resources.v1",
      );
      expect(registry.unsupported()["dnd5e.resources.v1"], version).toBe(
        `dnd5e ${version} on Foundry ${generation}; requires dnd5e 6.1.0 or later on Foundry 14 or later`,
      );
    }
    // Another system on an admitted version string never gets the lane.
    vi.stubGlobal("game", {
      system: { id: "knight", version: "6.1.0" },
      release: { generation: 14 },
    });
    const knight = new ProcedureRegistry();
    registerBuiltinProcedures(knight);
    expect(knight.capabilities()).not.toContain("dnd5e.resources.v1");
    expect(knight.unsupported()).not.toHaveProperty("dnd5e.resources.v1");
  });

  it("registers actor.upsert.v1 only for Knight", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.33" },
      release: { generation: 14 },
      knight: KNIGHT_ROLLER,
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
    [
      "pf2e 8.6.1",
      { system: { id: "pf2e", version: "8.6.1" }, release: { generation: 14 } },
    ],
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
    [
      "pf2e 8.6.1",
      { system: { id: "pf2e", version: "8.6.1" }, release: { generation: 14 } },
    ],
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

  it("declares exactly the known mutations", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.33" },
      release: { generation: 14 },
      knight: KNIGHT_ROLLER,
    });
    const knight = new ProcedureRegistry();
    registerBuiltinProcedures(knight);
    expect(knight.mutations()).toEqual([...MUTATION_PROCEDURES].sort());

    // pf2e from the floor: the character-draft, completion and live-counters
    // lanes only (no combat mirror).
    vi.stubGlobal("game", {
      system: { id: "pf2e", version: "8.6.1" },
      release: { generation: 14 },
    });
    const pf2e = new ProcedureRegistry();
    registerBuiltinProcedures(pf2e);
    expect(pf2e.mutations()).toEqual([
      "pf2e.actor.complete.v1",
      "pf2e.actor.upsert.v1",
      "pf2e.resources.v1",
    ]);

    // Any other system exposes only the core-document combat mirror, and no
    // mutation at all before Foundry 13.
    for (const id of ["dnd5e", "custom-system"]) {
      vi.stubGlobal("game", { system: { id }, release: { generation: 14 } });
      const other = new ProcedureRegistry();
      registerBuiltinProcedures(other);
      expect(other.mutations(), id).toEqual(["combat.sync.v1"]);
      vi.stubGlobal("game", { system: { id } });
      const unknown = new ProcedureRegistry();
      registerBuiltinProcedures(unknown);
      expect(unknown.mutations(), id).toEqual([]);
    }
  });

  // The channel withholds a signed-only procedure from a responder that cannot
  // sign; the flag at registration is what puts the two upserts behind it.
  it("registers exactly the mutations as signed-only", () => {
    vi.stubGlobal("game", {
      system: { id: "knight", version: "3.58.33" },
      release: { generation: 14 },
      knight: KNIGHT_ROLLER,
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
      expect(registry.capabilities()).toContain("actor.resources.v1");
    }
  });

  it("advertises the Knight upserts on every Knight version from the floor", () => {
    expect(MINIMUM_KNIGHT_UPSERT_SYSTEM_VERSION).toBe("3.58.33");
    for (const version of [
      "3.58.33",
      "3.58.34",
      "3.58.35",
      "3.58.36",
      "3.58.37",
      "3.59.0",
      "4.0.0",
    ]) {
      vi.stubGlobal("game", {
        system: { id: "knight", version },
        release: { generation: 13 },
        knight: KNIGHT_ROLLER,
      });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities(), version).toEqual(KNIGHT_CAPABILITIES);
      expect(registry.unsupported(), version).toEqual({});
    }
  });

  it("compares the Knight version numerically against the floor", () => {
    for (const v of ["3.58.33", "3.58.36", "3.58.37", "3.58.100", "4.0.0"])
      expect(isAdmittedKnightSystemVersion(v), v).toBe(true);
    for (const v of [
      "3.58.32",
      "3.57.99",
      "3.6.0",
      "v3.58.36",
      "3.58.33-beta",
      "3.58",
      " 3.58.33",
      3.58,
      null,
    ])
      expect(isAdmittedKnightSystemVersion(v), String(v)).toBe(false);
  });

  it("does not advertise actor.upsert.v1 outside the admitted Knight runtime", () => {
    for (const game of [
      ...[
        "3.58.32",
        "3.57.99",
        "2.99.99",
        "v3.58.33",
        "v3.58.36",
        "3.58.3",
        "3.58.33-beta",
        "",
        undefined,
      ].map((version) => ({
        system: { id: "knight", version },
        release: { generation: 14 },
      })),
      {
        system: { id: "knight", version: "3.58.33" },
        release: { generation: 12 },
      },
    ]) {
      vi.stubGlobal("game", game);
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities()).toEqual(
        game.release.generation >= 13 ? MODERN_CAPABILITIES : BASE_CAPABILITIES,
      );
    }
  });

  it("advertises combat.sync.v1 on every system from Foundry 13, and says why not before", () => {
    for (const id of ["dnd5e", "knight", "custom-system", ""]) {
      vi.stubGlobal("game", { system: { id }, release: { generation: 13 } });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities(), id).toContain("combat.sync.v1");
      expect(registry.isSignedOnly("combat.sync.v1"), id).toBe(true);
    }
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      release: { generation: 12 },
    });
    const old = new ProcedureRegistry();
    registerBuiltinProcedures(old);
    expect(old.capabilities()).not.toContain("combat.sync.v1");
    expect(old.unsupported()["combat.sync.v1"]).toBe(
      "Foundry 12; requires Foundry 13 or later",
    );
  });

  it("never advertises combat.sync.v1 on a system the backend does not write to", () => {
    for (const id of ["pf2e", "cyberpunk-red-core", "cpred"]) {
      vi.stubGlobal("game", { system: { id }, release: { generation: 14 } });
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      expect(registry.capabilities(), id).not.toContain("combat.sync.v1");
      expect(registry.mutations(), id).toEqual([]);
      expect(registry.unsupported()["combat.sync.v1"], id).toBe(
        `combat mirroring is not available on ${id}`,
      );
    }
  });
});
