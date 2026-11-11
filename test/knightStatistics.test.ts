import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knightStatisticsV1 } from "../src/procedures/knightStatistics.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { RpcError } from "../src/rpc/errors.js";
import { canonicalize } from "../src/util/canonicalJson.js";

// SYNTHETIC, shape-only: prepared Knight Actors as the Knight data models
// describe them (source-derived, not a capture). Knight sets its prepared
// values with Object.defineProperty: non-enumerable on the instance and absent
// from `_source` / `toObject()`, which here hold DIFFERENT numbers, so a
// handler that serializes or iterates instead of reading by path reddens.

const PC = "knightPC00000001";
const BANDE = "knightBande00001";
const VEHICLE = "knightVehicle001";
const MECHA = "knightMecha00001";
const AI = "knightIA00000001";
const MISSING = "missingActor0001";

const CHARACTERISTICS = {
  chair: ["deplacement", "force", "endurance"],
  bete: ["hargne", "combat", "instinct"],
  machine: ["tir", "savoir", "technique"],
  dame: ["aura", "parole", "sangFroid"],
  masque: ["discretion", "dexterite", "perception"],
} as const;

/** Set `value` at `path` as Knight prepares it: a non-enumerable own property
 * of a plain (enumerable) container. */
function prepare(root: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let at = root;
  for (const part of parts.slice(0, -1)) {
    if (typeof at[part] !== "object" || at[part] === null) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  Object.defineProperty(at, parts.at(-1)!, {
    value,
    enumerable: false,
    configurable: true,
  });
}

function actor(id: string, type: string, prepared: Record<string, unknown>) {
  const system: Record<string, unknown> = {};
  const source: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(prepared)) {
    prepare(system, path, value);
    // The stored source holds other numbers.
    let at = source;
    const parts = path.split(".");
    for (const part of parts.slice(0, -1))
      at = (at[part] ??= {}) as Record<string, unknown>;
    at[parts.at(-1)!] = typeof value === "number" ? value + 1000 : "source";
  }
  return {
    id,
    type,
    name: `<b>${type}</b>`,
    system,
    _source: { system: source },
    toObject: () => ({ system: structuredClone(source) }),
  };
}

function knightPC(over: Record<string, unknown> = {}) {
  const prepared: Record<string, unknown> = {
    "sante.max": 42,
    "sante.value": 40,
    "espoir.max": 50,
    "espoir.value": 31,
    "armure.max": 60,
    "armure.value": 55,
    "energie.max": 30,
    "energie.value": 12,
    "contacts.value": 4,
    "contacts.actuel": 3,
    "champDeForce.value": 6,
    "defense.value": 7,
    "reaction.value": -2,
    "initiative.value": 9,
    "initiative.dice": 4,
  };
  let n = 1;
  for (const [aspect, keys] of Object.entries(CHARACTERISTICS)) {
    prepared[`aspects.${aspect}.value`] = n++;
    for (const key of keys) {
      prepared[`aspects.${aspect}.caracteristiques.${key}.value`] = n++;
      prepared[`aspects.${aspect}.caracteristiques.${key}.overdrive.value`] =
        n % 3;
    }
  }
  return actor(PC, "knight", { ...prepared, ...over });
}

const bande = () =>
  actor(BANDE, "bande", {
    "aspects.chair.value": 4,
    "aspects.bete.value": 5,
    "aspects.machine.value": 2,
    "aspects.dame.value": 1,
    "aspects.masque.value": 3,
    "sante.max": 80,
    "sante.value": 64,
    "champDeForce.value": 2,
    "defense.value": 3,
    "reaction.value": 2,
    "initiative.value": 1,
    "initiative.dice": 0,
  });
const vehicle = () =>
  actor(VEHICLE, "vehicule", {
    "armure.max": 120,
    "armure.value": 100,
    "energie.max": 40,
    "energie.value": 40,
    "champDeForce.value": 10,
    "defense.value": 5,
    "reaction.value": 6,
    "initiative.value": 8,
    "initiative.dice": 3,
  });
const mecha = () => actor(MECHA, "mechaarmure", { "champDeForce.value": 14 });
const ai = () => actor(AI, "ia", {});

function stubWorld(
  actors: unknown[],
  { version = "3.58.37", generation = 14, isGM = true } = {},
) {
  vi.stubGlobal("game", {
    user: { id: "gm", isGM },
    system: { id: "knight", version },
    release: { generation },
    actors: {
      contents: actors,
      get: (id: string) =>
        (actors as { id: string }[]).find((a) => a.id === id),
    },
  });
}

const request = (actorIds: unknown, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  worldId: "world-1",
  actorIds,
  ...over,
});

type Reply = {
  schemaVersion: 1;
  actors: Record<string, any>[];
  skipped: { actorId: string; reason: string }[];
};
const read = async (payload: unknown) =>
  (await knightStatisticsV1(payload, {} as never)) as Reply;

async function code(payload: unknown): Promise<string> {
  try {
    await knightStatisticsV1(payload, {} as never);
  } catch (error) {
    if (error instanceof RpcError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

afterEach(() => vi.unstubAllGlobals());

const FIXTURE = new URL(
  "./fixtures/knight-statistics-v1-reply.json",
  import.meta.url,
);
const pretty = (value: unknown) =>
  `${JSON.stringify(JSON.parse(canonicalize(value)), null, 2)}\n`;

describe("knight.statistics.v1", () => {
  it("reads a PC's prepared numbers by path, never its source", async () => {
    stubWorld([knightPC()]);
    const reply = await read(request([PC]));
    expect(reply.skipped).toEqual([]);
    const pc = reply.actors[0];
    expect(pc).toMatchObject({
      actorId: PC,
      actorType: "knight",
      aspects: { chair: 1, bete: 5, machine: 9, dame: 13, masque: 17 },
      health: { max: 42, value: 40 },
      hope: { max: 50, value: 31 },
      armour: { max: 60, value: 55 },
      energy: { max: 30, value: 12 },
      contact: { max: 4, value: 3 },
      forceField: 6,
      defense: 7,
      reaction: -2,
      initiative: { value: 9, dice: 4 },
    });
    expect(Object.keys(pc.characteristics).sort()).toEqual(
      Object.values(CHARACTERISTICS).flat().sort(),
    );
    expect(pc.characteristics.force).toEqual({ value: 3, overdrive: 1 });
    expect(pc.characteristics.sangFroid).toEqual({ value: 16, overdrive: 2 });
    // Nothing from the stored source (all of it is ≥ 1000 or text).
    expect(JSON.stringify(reply)).not.toMatch(/10\d\d|source|<b>/);
  });

  it("answers null for a member that is missing or not a bounded integer, alone", async () => {
    const pc = knightPC({
      "defense.value": Number.NaN,
      "reaction.value": 1e9,
      "initiative.value": "9",
      "sante.max": 10_000,
      "espoir.max": -10_000,
      "armure.value": 1.5,
    });
    delete (pc.system.champDeForce as Record<string, unknown> | undefined)
      ?.value;
    delete pc.system.contacts;
    stubWorld([pc]);
    const [row] = (await read(request([PC]))).actors;
    expect(row).toMatchObject({
      defense: null,
      reaction: null,
      initiative: { value: null, dice: 4 },
      health: { max: null, value: 40 },
      hope: { max: null, value: 31 },
      armour: { max: 60, value: null },
      contact: { max: null, value: null },
      forceField: null,
      energy: { max: 30, value: 12 },
    });
    expect(row.reaction).toBeNull();
    const ok = (await read(request([PC]))).actors[0];
    expect(ok.aspects.chair).toBe(1);
  });

  it("answers each type with the members it has", async () => {
    stubWorld([bande(), vehicle(), mecha()]);
    const [b, v, m] = (await read(request([BANDE, VEHICLE, MECHA]))).actors;
    expect(b).toEqual({
      actorId: BANDE,
      actorType: "bande",
      aspects: { chair: 4, bete: 5, machine: 2, dame: 1, masque: 3 },
      characteristics: null,
      health: { max: 80, value: 64 },
      hope: null,
      armour: null,
      energy: null,
      contact: null,
      forceField: 2,
      defense: 3,
      reaction: 2,
      initiative: { value: 1, dice: 0 },
    });
    expect(v).toMatchObject({
      aspects: null,
      characteristics: null,
      health: null,
      armour: { max: 120, value: 100 },
      energy: { max: 40, value: 40 },
      forceField: 10,
      defense: 5,
    });
    expect(m).toMatchObject({
      actorType: "mechaarmure",
      aspects: null,
      health: null,
      armour: null,
      forceField: 14,
      defense: null,
      initiative: null,
    });
  });

  it("answers every asked id once, in request order, or skips it with a reason", async () => {
    stubWorld([knightPC(), ai(), bande()]);
    const reply = await read(request([BANDE, MISSING, AI, PC]));
    expect(reply.actors.map((a) => a.actorId)).toEqual([BANDE, PC]);
    expect(reply.skipped).toEqual([
      { actorId: MISSING, reason: "not_found" },
      { actorId: AI, reason: "no_statistics" },
    ]);
  });

  it.each([
    ["an unknown key", request([PC], { extra: 1 })],
    ["schemaVersion 2", request([PC], { schemaVersion: 2 })],
    ["no id", request([])],
    [
      "33 ids",
      request(
        Array.from(
          { length: 33 },
          (_, i) => `actor${String(i).padStart(11, "0")}`,
        ),
      ),
    ],
    ["a duplicate id", request([PC, PC])],
    ["a malformed id", request(["short"])],
    ["a non-array", request(PC)],
    ["a malformed worldId", request([PC], { worldId: "a b" })],
  ])("refuses %s with invalid_args", async (_label, payload) => {
    stubWorld([knightPC()]);
    expect(await code(payload)).toBe("invalid_args");
  });

  it("accepts 32 ids", async () => {
    stubWorld([]);
    const ids = Array.from(
      { length: 32 },
      (_, i) => `actor${String(i).padStart(11, "0")}`,
    );
    expect((await read(request(ids))).skipped).toHaveLength(32);
  });

  it("requires a GM responder on an admitted Knight runtime", async () => {
    stubWorld([knightPC()], { isGM: false });
    expect(await code(request([PC]))).toBe("permission_denied");
    stubWorld([knightPC()], { version: "3.58.32" });
    expect(await code(request([PC]))).toBe("unsupported_runtime");
  });

  it("is advertised as a signed-only read on Knight, withheld with a reason otherwise", () => {
    const registered = () => {
      const registry = new ProcedureRegistry();
      registerBuiltinProcedures(registry);
      return registry;
    };
    for (const generation of [13, 14]) {
      stubWorld([], { generation });
      const registry = registered();
      expect(registry.capabilities()).toContain("knight.statistics.v1");
      expect(registry.isSignedOnly("knight.statistics.v1")).toBe(true);
      expect(registry.mutations()).not.toContain("knight.statistics.v1");
    }
    for (const [version, generation] of [
      ["3.58.32", 14],
      ["4.0.0", 14],
      ["3.58", 14],
      ["3.58.37", 12],
    ] as const) {
      stubWorld([], { version, generation });
      const registry = registered();
      expect(registry.capabilities()).not.toContain("knight.statistics.v1");
      expect(registry.unsupported()["knight.statistics.v1"]).toMatch(
        /requires Knight/,
      );
    }
    vi.stubGlobal("game", { system: { id: "pf2e", version: "8.6.1" } });
    const other = registered();
    expect(other.capabilities()).not.toContain("knight.statistics.v1");
    expect(other.unsupported()).not.toHaveProperty("knight.statistics.v1");
  });

  // The shared reply fixture: this world's reply, sorted keys, 2-space
  // indent, trailing newline. Re-cut with UPDATE_KNIGHT_STATISTICS_FIXTURE=1.
  it("produces the shared reply fixture", async () => {
    stubWorld([knightPC(), vehicle(), ai()]);
    const text = pretty(await read(request([PC, VEHICLE, AI, MISSING])));
    if (process.env.UPDATE_KNIGHT_STATISTICS_FIXTURE === "1")
      writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });
});
