import { afterEach, describe, expect, it, vi } from "vitest";
import {
  combatSyncV1,
  validateCombatSyncV1,
  type CombatSyncResultV1,
  type CombatSyncV1,
} from "../src/procedures/combatSync.js";
import { combatStateV1Snapshot } from "../src/procedures/combatSyncState.js";
import { MODULE_ID } from "../src/constants.js";
import { setAgentTableGate } from "../src/procedures/upsertShared.js";
import { RpcError } from "../src/rpc/errors.js";
import { applyUpdate } from "./support/actorUpsertHarness.js";

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
 * initiative descending (unrolled last), then name. Like Foundry's
 * `_onCreateDescendantDocuments`/`_onDeleteDescendantDocuments`, a create or
 * delete keeps the current combatant by emitting its own `update({turn})`,
 * turn events on, when that combatant's index moved. */
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
    const flags = Object.fromEntries(
      Object.entries(changes).filter(([key]) => key.startsWith("flags.")),
    );
    applyUpdate(this as unknown as Dict, flags);
  }
  async delete() {
    this.deleted = true;
    combats.splice(combats.indexOf(this), 1);
  }
  private async keepCurrent(write: () => void) {
    const current = this.turn === null ? undefined : this.turns[this.turn];
    write();
    this.setupTurns();
    if (!current) return;
    const turn = Math.max(
      this.turns.findIndex((c) => c.id === current.id),
      0,
    );
    if (turn !== this.turn) await this.update({ turn });
  }
  async createEmbeddedDocuments(_type: string, data: Dict[]) {
    this.embeddedWrites++;
    await this.keepCurrent(() => {
      for (const d of data)
        this.list.push({ id: newId("cbt"), ...(d as object) } as FakeCombatant);
    });
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
    await this.keepCurrent(() => {
      this.list = this.list.filter((c) => !ids.includes(c.id));
    });
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

  it("emits no turn update with turn events on when the list changes, and no reset when it does not", async () => {
    stub();
    await apply(request()); // Hero 17, Dragon 12.5, Goblin 8: Goblin active at 2
    const combat = combats[0];
    expect(combat.turn).toBe(2);
    combat.updates = [];

    // Dragon leaves and a 30 Ambush joins: Foundry would shift Goblin's index.
    const [goblin, hero] = request().combatants;
    const ambush = {
      ...hero,
      key: "ambush",
      actorId: null,
      name: "Ambush",
      initiative: 30,
    };
    await apply(request({ sequence: 2, combatants: [goblin, hero, ambush] }));
    expect(combat.updates.map((u) => u.options)).toEqual([
      { turnEvents: false },
      { turnEvents: false },
    ]);
    expect(combat.updates[0].changes).toEqual({ turn: null });
    expect(combat.updates[1].changes).toMatchObject({ turn: 2 });
    expect(combat.turn).toBe(2);

    combat.updates = [];
    await apply(
      request({ sequence: 3, round: 2, combatants: [goblin, hero, ambush] }),
    );
    expect(combat.updates).toHaveLength(1);
    expect(combat.updates[0]).toMatchObject({
      changes: { round: 2, turn: 2 },
      options: { turnEvents: false },
    });
  });

  // Foundry persists no turn of its own on a Combatant update (rollInitiative
  // and resetAll take `updateTurn` to do it themselves), so an initiative-only
  // change needs no reset: the final quiet update sets the re-sorted index.
  it("re-sorts on an initiative-only change without a turn reset", async () => {
    stub();
    await apply(request()); // Hero 17, Dragon 12.5, Goblin 8: Goblin active at 2
    const combat = combats[0];
    combat.updates = [];
    const [goblin, hero, dragon] = request().combatants;
    await apply(
      request({
        sequence: 2,
        combatants: [{ ...goblin, initiative: 20 }, hero, dragon],
      }),
    );
    expect(combat.updates).toHaveLength(1);
    expect(combat.updates[0]).toMatchObject({
      changes: { round: 1, turn: 0 },
      options: { turnEvents: false },
    });
    expect(combat.turns[0].name).toBe("Goblin");
  });

  it("links two combatants of one actor, both to the first of its tokens", async () => {
    const scene = {
      ...SCENE,
      tokens: {
        contents: [
          { id: "tokenHero0000001", actorId: HERO },
          { id: "tokenHero0000002", actorId: HERO },
        ],
      },
    };
    stub({ scene });
    const [, hero] = request().combatants;
    const result = await apply(
      request({
        activeKey: "hero-a",
        combatants: [
          { ...hero, key: "hero-a", name: "Hero A" },
          { ...hero, key: "hero-b", name: "Hero B", initiative: 3 },
        ],
      }),
    );
    expect(result.warnings).toEqual([]);
    const list = combats[0].list;
    expect(list.map(keyOf)).toEqual(["hero-a", "hero-b"]);
    // The request names the actor, not a token: the mirror cannot tell two
    // tokens of one actor apart, so both take the first.
    for (const c of list)
      expect(c).toMatchObject({ actorId: HERO, tokenId: "tokenHero0000001" });
  });

  it("keeps an initiative rolled in Foundry when the app's entry has none", async () => {
    stub();
    await apply(request());
    const combat = combats[0];
    const hero = combat.list.find((c) => keyOf(c) === "hero")!;
    hero.initiative = 14; // rolled in Foundry
    const spy = vi.spyOn(combat, "updateEmbeddedDocuments");

    await apply(
      request({
        sequence: 2,
        combatants: [
          {
            key: "hero",
            actorId: HERO,
            name: "Hero",
            initiative: null,
            hidden: false,
          },
        ],
      }),
    );

    const [, data] = spy.mock.calls[0];
    const update = data.find((d) => d._id === hero.id)!;
    expect(update).not.toHaveProperty("initiative");
    expect(hero.initiative).toBe(14);
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

  it("ends only its own Combat while another one is active in the world", async () => {
    stub();
    await apply(request());
    const mirrored = combats[0];
    const other = new FakeCombat({}, SCENE); // the GM's own encounter
    other.list.push({
      id: newId("cbt"),
      name: "Orc",
      initiative: 5,
      hidden: false,
      actorId: null,
      tokenId: null,
      flags: {},
    });
    other.turn = 0;
    combats.push(other);

    await apply(
      request({
        sequence: 2,
        state: "ended",
        activeKey: null,
        combatants: [],
      }),
    );
    expect(mirrored.deleted).toBe(true);
    expect(combats).toEqual([other]);
    expect(other).toMatchObject({
      deleted: false,
      updates: [],
      embeddedWrites: 0,
      turn: 0,
    });
    expect(other.list).toHaveLength(1);
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

describe("combat.sync.v1 adopting a Combat started in Foundry", () => {
  const OTHER_SCENE = {
    id: "scene00000000002",
    tokens: { contents: [{ id: "tokenHero0000002", actorId: HERO }] },
  };

  /** A Combat the GM started in Foundry, on a scene the responder tab does
   * not view: a linked hero with its token and an NPC Actor of no app sheet. */
  function foundryCombat(): FakeCombat {
    const combat = new FakeCombat({}, OTHER_SCENE as typeof SCENE);
    combat.list.push(
      {
        id: "cbtHero000000001",
        name: "Hero",
        initiative: 14.5,
        hidden: false,
        actorId: HERO,
        tokenId: "tokenHero0000002",
        flags: {},
      },
      {
        id: "cbtOrc0000000001",
        name: "Orc",
        initiative: 9,
        hidden: true,
        actorId: "actorOrcNpc00001",
        tokenId: "tokenOrc00000001",
        flags: {},
      },
    );
    combat.setupTurns();
    combat.round = 1;
    combat.turn = 0;
    combats.push(combat);
    return combat;
  }

  /** The app's request after adopting it: a bound hero, the orc as a plain
   * entry (no Actor), both born from Foundry combatants. */
  function adoption(combat: FakeCombat, overrides: Partial<CombatSyncV1> = {}) {
    return request({
      foundryCombatId: combat.id,
      activeKey: "hero-entry",
      combatants: [
        {
          key: "hero-entry",
          actorId: HERO,
          name: "Hero",
          initiative: 15,
          hidden: false,
          foundryCombatantId: "cbtHero000000001",
        },
        {
          key: "orc-entry",
          actorId: null,
          name: "Orc",
          initiative: 9,
          hidden: true,
          foundryCombatantId: "cbtOrc0000000001",
        },
      ],
      ...overrides,
    });
  }

  it("keys the existing Combat and combatants in place, on any scene, without touching their links", async () => {
    stub();
    const combat = foundryCombat();
    const result = await apply(adoption(combat));

    expect(create).not.toHaveBeenCalled();
    expect(combats).toEqual([combat]);
    expect(result).toMatchObject({
      resultDocId: combat.id,
      outcome: "updated",
      appliedRevision: 1,
      warnings: [],
    });
    expect(combat.list).toHaveLength(2);
    expect(combat.list.map(keyOf)).toEqual(["hero-entry", "orc-entry"]);
    // The NPC sent as a plain entry keeps its Actor and token; the hero its
    // token on the other scene; 14.5 survives the app's rounded 15.
    expect(combat.list[0]).toMatchObject({
      actorId: HERO,
      tokenId: "tokenHero0000002",
      initiative: 14.5,
    });
    expect(combat.list[1]).toMatchObject({
      actorId: "actorOrcNpc00001",
      tokenId: "tokenOrc00000001",
      hidden: true,
    });
    expect((combat.flags[MODULE_ID] as Dict).combatSync).toMatchObject({
      combatId: request().combatId,
      appliedRevision: 1,
    });
    expect(combat.updates.at(-1)?.changes).toMatchObject({ round: 1, turn: 0 });

    // The next sequence finds it by its flag; no second combatant appears.
    await apply(adoption(combat, { sequence: 2, round: 2 }));
    expect(combat.list).toHaveLength(2);
    expect(combat.round).toBe(2);
  });

  it("adds an app entry next to the adopted ones and sets a new initiative", async () => {
    stub();
    const combat = foundryCombat();
    const req = adoption(combat);
    req.combatants[0].initiative = 20;
    req.combatants.push({
      key: "goblin",
      actorId: null,
      name: "Goblin",
      initiative: 3,
      hidden: false,
    });
    await apply(req);
    expect(combat.list).toHaveLength(3);
    expect(combat.list[0].initiative).toBe(20);
    expect(combat.list.find((c) => keyOf(c) === "goblin")).toMatchObject({
      name: "Goblin",
      actorId: null,
    });
  });

  it("refuses a Combat that is gone or mirrors another app combat", async () => {
    stub();
    const combat = foundryCombat();
    const req = adoption(combat);
    await combat.delete();
    expect(await rpcCode(apply(req))).toBe("not_found");
    expect(create).not.toHaveBeenCalled();

    stub();
    const taken = foundryCombat();
    taken.flags = {
      [MODULE_ID]: { combatSync: { schemaVersion: 1, combatId: "another" } },
    };
    expect(await rpcCode(apply(adoption(taken)))).toBe("binding_conflict");
    expect(taken.updates).toEqual([]);
  });

  it("deletes the adopted Combat when the app ends it before it was keyed", async () => {
    stub();
    const combat = foundryCombat();
    const result = await apply(
      adoption(combat, { state: "ended", activeKey: null, combatants: [] }),
    );
    expect(combat.deleted).toBe(true);
    expect(result).toMatchObject({
      outcome: "deleted",
      resultDocId: combat.id,
    });
  });

  it("validates the adoption fields and leaves an old-shape request's digest alone", async () => {
    const bad = request({ foundryCombatId: "short" });
    expect(() => validateCombatSyncV1(bad)).toThrow(RpcError);
    const entry = {
      ...request().combatants[0],
      foundryCombatantId: "x".repeat(17),
    };
    expect(() =>
      validateCombatSyncV1(request({ combatants: [entry] })),
    ).toThrow(RpcError);
    expect("foundryCombatId" in validateCombatSyncV1(request())).toBe(false);
    expect(
      "foundryCombatantId" in validateCombatSyncV1(request()).combatants[0],
    ).toBe(false);
  });

  describe("with the backend's table gate", () => {
    afterEach(() => setAgentTableGate(false));

    it("re-flags a running Combat another table's combat mirrors", async () => {
      setAgentTableGate(true);
      stub();
      const taken = foundryCombat();
      taken.flags = {
        [MODULE_ID]: { combatSync: { schemaVersion: 1, combatId: "another" } },
      };
      // The other table keyed its combatants; this table matches them by id.
      taken.list[0].flags = { [MODULE_ID]: { key: "their-hero" } };
      const req = adoption(taken);
      const result = await apply(req);
      expect(result.resultDocId).toBe(taken.id);
      expect((taken.flags[MODULE_ID] as Dict).combatSync).toMatchObject({
        combatId: req.combatId,
      });
      expect(create).not.toHaveBeenCalled();
      expect(taken.list).toHaveLength(2);
      expect(taken.list.map(keyOf).sort()).toEqual(["hero-entry", "orc-entry"]);
    });
  });
});

describe("combat.state.v1 after the mirror wrote (echo)", () => {
  it("names the app combat, the applied sequence and the entry keys of its own Combat", async () => {
    stub();
    await apply(request());
    await apply(request({ sequence: 2, activeKey: "hero" }));
    const combat = combats[0];
    const [state] = combatStateV1Snapshot().combats;
    expect(state).toMatchObject({
      id: combat.id,
      round: 1,
      appCombatId: request().combatId,
      appliedSequence: 2,
    });
    // Foundry's order, the active one by id, every entry keyed.
    expect(state.combatants.map((c) => c.appKey)).toEqual([
      "hero",
      "dragon",
      "goblin",
    ]);
    expect(state.activeCombatantId).toBe(
      combat.list.find((c) => keyOf(c) === "hero")!.id,
    );
  });

  it("names the app combat from the create itself, before any combatant", async () => {
    stub();
    let seen: unknown;
    vi.stubGlobal("Combat", {
      implementation: {
        create: async (data: Dict) => {
          const made = await (
            create as unknown as (d: Dict) => Promise<FakeCombat>
          )(data);
          seen = combatStateV1Snapshot().combats[0];
          return made;
        },
      },
    });
    await apply(request());
    expect(seen).toMatchObject({
      round: 0,
      appCombatId: request().combatId,
      appliedSequence: null,
      combatants: [],
    });
  });
});
