import { afterEach, describe, expect, it, vi } from "vitest";
import {
  combatSyncV1,
  validateCombatSyncV1,
  type CombatSyncResultV1,
  type CombatSyncV1,
} from "../src/procedures/combatSync.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";

afterEach(() => vi.unstubAllGlobals());

const HERO = "actorHero0000001";
const DRAGON = "actorDragon00001";
const SCENE = {
  id: "scene00000000001",
  tokens: { contents: [{ id: "tokenHero0000001", actorId: HERO }] },
};

type Dict = Record<string, unknown>;

interface FakeCombatant {
  id: string;
  name: string;
  initiative: number | null;
  hidden: boolean;
  actorId: string | null;
  tokenId: string | null;
  sceneId?: string;
  flags: Dict;
}

let nextId = 0;
const newId = (prefix: string) =>
  `${prefix}${String(++nextId).padStart(16 - prefix.length, "0")}`;

/** A Combat that applies its embedded writes and orders turns like Foundry:
 * initiative descending (unrolled last), then name. */
class FakeCombat {
  id = newId("combat");
  flags: Dict;
  scene: typeof SCENE | null;
  list: FakeCombatant[] = [];
  turns: FakeCombatant[] = [];
  round = 0;
  turn: number | null = null;
  updates: { changes: Dict; options?: Dict }[] = [];
  embeddedWrites = 0;
  deleted = false;

  constructor(flags: Dict, scene: typeof SCENE | null) {
    this.flags = flags;
    this.scene = scene;
  }
  get combatants() {
    return { contents: this.list };
  }
  setupTurns() {
    this.turns = [...this.list].sort(
      (a, b) =>
        (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity) ||
        a.name.localeCompare(b.name),
    );
    return this.turns;
  }
  async update(changes: Dict, options?: Dict) {
    this.updates.push({ changes, options });
    if ("round" in changes) this.round = changes.round as number;
    if ("turn" in changes) this.turn = changes.turn as number | null;
    const flag = changes[`flags.${MODULE_ID}.combatSync`];
    if (flag) {
      const ns = (this.flags[MODULE_ID] ??= {}) as Dict;
      ns.combatSync = { ...(ns.combatSync as Dict), ...(flag as Dict) };
    }
  }
  async delete() {
    this.deleted = true;
    combats.splice(combats.indexOf(this), 1);
  }
  async createEmbeddedDocuments(_type: string, data: Dict[]) {
    this.embeddedWrites++;
    for (const d of data)
      this.list.push({ id: newId("cbt"), ...(d as object) } as FakeCombatant);
  }
  async updateEmbeddedDocuments(_type: string, data: Dict[]) {
    this.embeddedWrites++;
    for (const d of data)
      Object.assign(
        this.list.find((c) => c.id === d._id)!,
        d,
      );
  }
  async deleteEmbeddedDocuments(_type: string, ids: string[]) {
    this.embeddedWrites++;
    this.list = this.list.filter((c) => !ids.includes(c.id));
  }
}

let combats: FakeCombat[] = [];
let create: ReturnType<typeof vi.fn>;

function stub({
  isGM = true,
  generation = 14,
  scene = SCENE as typeof SCENE | null,
} = {}) {
  combats = [];
  create = vi.fn(async (data: Dict) => {
    const combat = new FakeCombat(
      structuredClone(data.flags) as Dict,
      data.scene ? scene : null,
    );
    combats.push(combat);
    return combat;
  });
  vi.stubGlobal("game", {
    user: { isGM },
    release: { generation },
    combats: {
      get contents() {
        return combats;
      },
    },
    actors: {
      get: (id: string) => ([HERO, DRAGON].includes(id) ? { id } : undefined),
    },
    scenes: { viewed: scene },
  });
  vi.stubGlobal("Combat", { implementation: { create } });
}

function request(overrides: Partial<CombatSyncV1> = {}): CombatSyncV1 {
  return {
    schemaVersion: 1,
    worldId: "world-1",
    tableId: "table-1",
    combatId: "c0ffee00-0000-4000-8000-000000000001",
    sequence: 1,
    state: "active",
    round: 1,
    activeKey: "goblin",
    // The app's turn order: not Foundry's (initiative-descending) order.
    combatants: [
      {
        key: "goblin",
        actorId: null,
        name: "Goblin",
        initiative: 8,
        hidden: false,
      },
      {
        key: "hero",
        actorId: HERO,
        name: "Hero",
        initiative: 17,
        hidden: false,
      },
      {
        key: "dragon",
        actorId: DRAGON,
        name: "Dragon",
        initiative: 12.5,
        hidden: true,
      },
    ],
    ...overrides,
  };
}

async function apply(req: unknown): Promise<CombatSyncResultV1> {
  return (await combatSyncV1(req, {} as never)) as CombatSyncResultV1;
}

async function rpcCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error.code;
    throw error;
  }
  throw new Error("expected an RpcError");
}

const keyOf = (c: FakeCombatant) => (c.flags[MODULE_ID] as Dict).key;

describe("validateCombatSyncV1", () => {
  it("accepts the wire shape and normalizes absent nullables to null", () => {
    const req = request();
    expect(validateCombatSyncV1(req)).toEqual(req);
    const noActive: Partial<CombatSyncV1> = request({
      combatants: [{ key: "a", name: "A", hidden: false } as never],
    });
    delete noActive.activeKey;
    expect(validateCombatSyncV1(noActive)).toMatchObject({
      activeKey: null,
      combatants: [{ key: "a", actorId: null, initiative: null }],
    });
  });

  const entry = {
    key: "a",
    actorId: null,
    name: "A",
    initiative: null,
    hidden: false,
  };
  it.each([
    ["unknown top-level key", { scene: "x" }],
    ["unknown combatant key", { combatants: [{ ...entry, tokenId: "x" }] }],
    ["wrong schema", { schemaVersion: 2 }],
    ["bad state", { state: "paused" }],
    ["fractional round", { round: 1.5 }],
    ["negative round", { round: -1 }],
    ["zero sequence", { sequence: 0 }],
    ["bad combat id", { combatId: "a b" }],
    ["bad active key", { activeKey: "" }],
    ["combatants not an array", { combatants: {} }],
    [
      "65 combatants",
      {
        combatants: Array.from({ length: 65 }, (_, i) => ({
          ...entry,
          key: `k${i}`,
        })),
      },
    ],
    ["duplicate key", { combatants: [entry, entry] }],
    ["short actor id", { combatants: [{ ...entry, actorId: "abc" }] }],
    ["long name", { combatants: [{ ...entry, name: "é".repeat(121) }] }],
    ["NUL in name", { combatants: [{ ...entry, name: "a\0b" }] }],
    ["string initiative", { combatants: [{ ...entry, initiative: "12" }] }],
    ["huge initiative", { combatants: [{ ...entry, initiative: 1e9 }] }],
    ["missing hidden", { combatants: [{ ...entry, hidden: undefined }] }],
  ])("refuses %s", (_name, overrides) => {
    expect(() => validateCombatSyncV1({ ...request(), ...overrides })).toThrow(
      RpcError,
    );
  });
});

describe("combat.sync.v1", () => {
  it("creates the Combat on the viewed scene and sets the turn from Foundry's order", async () => {
    stub();
    const result = await apply(request());

    expect(create).toHaveBeenCalledWith(
      {
        scene: SCENE.id,
        active: true,
        flags: {
          [MODULE_ID]: {
            combatSync: { schemaVersion: 1, combatId: request().combatId },
          },
        },
      },
      { renderSheet: false },
    );
    const combat = combats[0];
    expect(result).toMatchObject({
      schemaVersion: 1,
      resultDocId: combat.id,
      outcome: "created",
      appliedRevision: 1,
      warnings: ["combatant_without_token:dragon"],
    });
    expect(result.appliedDigest).toMatch(/^[0-9a-f]{64}$/);
    const hero = combat.list.find((c) => keyOf(c) === "hero")!;
    expect(hero).toMatchObject({
      actorId: HERO,
      tokenId: "tokenHero0000001",
      sceneId: SCENE.id,
      initiative: 17,
    });
    expect(combat.list.find((c) => keyOf(c) === "dragon")).toMatchObject({
      actorId: DRAGON,
      tokenId: null,
      hidden: true,
    });
    // Foundry's order: Hero 17, Dragon 12.5, Goblin 8 — the active Goblin is turn 2, not the app's index 0.
    expect(combat.updates).toHaveLength(1);
    expect(combat.updates[0].changes).toMatchObject({ round: 1, turn: 2 });
    expect(combat.updates[0].options).toEqual({ turnEvents: false });
    expect((combat.flags[MODULE_ID] as Dict).combatSync).toMatchObject({
      combatId: request().combatId,
      appliedRevision: 1,
      appliedDigest: result.appliedDigest,
    });
  });

  it("creates an unlinked Combat when no scene is viewed", async () => {
    stub({ scene: null });
    const result = await apply(
      request({ combatants: [request().combatants[1]], activeKey: "hero" }),
    );
    expect(create.mock.calls[0][0]).toMatchObject({ scene: null });
    expect(result.warnings).toEqual(["combatant_without_token:hero"]);
  });

  it("upserts its own combatants by key, deletes the gone ones and never touches the GM's", async () => {
    stub();
    await apply(request());
    const combat = combats[0];
    combat.list.push({
      id: "gmOwn00000000001",
      name: "Ambush",
      initiative: 30,
      hidden: false,
      actorId: null,
      tokenId: null,
      flags: {},
    });
    const goblinId = combat.list.find((c) => keyOf(c) === "goblin")!.id;

    const result = await apply(
      request({
        sequence: 2,
        round: 2,
        activeKey: "goblin",
        combatants: [
          {
            key: "goblin",
            actorId: null,
            name: "Goblin chief",
            initiative: 20,
            hidden: false,
          },
          {
            key: "hero",
            actorId: HERO,
            name: "Hero",
            initiative: 17,
            hidden: false,
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      outcome: "updated",
      resultDocId: combat.id,
      appliedRevision: 2,
      warnings: [],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(combat.list.map((c) => c.name).sort()).toEqual([
      "Ambush",
      "Goblin chief",
      "Hero",
    ]);
    expect(combat.list.find((c) => keyOf(c) === "goblin")!.id).toBe(goblinId);
    // Ambush 30, Goblin chief 20, Hero 17: the GM's own combatant counts in Foundry's order.
    expect(combat.updates.at(-1)!.changes).toMatchObject({ round: 2, turn: 1 });
  });

  it("replays the stored result without writing, and refuses stale or conflicting sequences", async () => {
    stub();
    const first = await apply(request({ sequence: 5 }));
    const combat = combats[0];
    const writes = [combat.updates.length, combat.embeddedWrites];

    await expect(apply(request({ sequence: 5 }))).resolves.toEqual(first);
    expect([combat.updates.length, combat.embeddedWrites]).toEqual(writes);
    expect(await rpcCode(apply(request({ sequence: 4 })))).toBe(
      "stale_revision",
    );
    expect(await rpcCode(apply(request({ sequence: 5, round: 3 })))).toBe(
      "revision_conflict",
    );
    expect(await rpcCode(apply(request({ sequence: 4, state: "ended" })))).toBe(
      "stale_revision",
    );
    expect(combats).toHaveLength(1);
  });

  it("deletes the mirrored Combat when the fight ends, and converges when it is already gone", async () => {
    stub();
    await apply(request());
    const combat = combats[0];
    const ended = request({
      sequence: 2,
      state: "ended",
      activeKey: null,
      combatants: [],
    });

    const result = await apply(ended);
    expect(combat.deleted).toBe(true);
    expect(result).toMatchObject({
      outcome: "deleted",
      resultDocId: combat.id,
      appliedRevision: 2,
      warnings: [],
    });

    const replay = await apply(ended);
    expect(replay).toEqual({ ...result, resultDocId: "" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates a combatant by name only when its actor is not in the world", async () => {
    stub();
    const result = await apply(
      request({
        activeKey: "ghost",
        combatants: [
          {
            key: "ghost",
            actorId: "actorGone0000001",
            name: "Ghost",
            initiative: null,
            hidden: false,
          },
        ],
      }),
    );
    expect(result.warnings).toEqual(["combatant_actor_missing:ghost"]);
    expect(combats[0].list[0]).toMatchObject({
      name: "Ghost",
      actorId: null,
      tokenId: null,
    });
    expect(combats[0].updates[0].changes).toMatchObject({ turn: 0 });
  });

  it("warns when the active key is not a combatant", async () => {
    stub();
    const result = await apply(request({ activeKey: "nobody" }));
    expect(result.warnings).toContain("active_combatant_missing");
    expect(combats[0].updates[0].changes).toMatchObject({ turn: 0 });
    stub();
    await apply(request({ activeKey: null, combatants: [] }));
    expect(combats[0].updates[0].changes).toMatchObject({
      turn: null,
      round: 1,
    });
  });

  it("refuses a non-GM responder, Foundry before 13 and two Combats with the same id", async () => {
    stub({ isGM: false });
    expect(await rpcCode(apply(request()))).toBe("permission_denied");
    stub({ generation: 12 });
    expect(await rpcCode(apply(request()))).toBe("unsupported_runtime");
    stub();
    const flags = {
      [MODULE_ID]: {
        combatSync: { schemaVersion: 1, combatId: request().combatId },
      },
    };
    combats.push(
      new FakeCombat(flags, SCENE),
      new FakeCombat(structuredClone(flags), SCENE),
    );
    expect(await rpcCode(apply(request()))).toBe("binding_collision");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an invalid request before touching the world", async () => {
    stub();
    expect(await rpcCode(apply({ ...request(), flags: {} }))).toBe(
      "invalid_args",
    );
    expect(create).not.toHaveBeenCalled();
  });
});
