import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEST_WAIT_MS,
  knightTestV1,
  validateKnightTestV1,
} from "../src/procedures/knightTest.js";
import { knightAttackV1 } from "../src/procedures/knightAttack.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import {
  MODULE_ID,
  REQUEST_TIMEOUT_MS,
  SETTING_AGENT_USER,
} from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import { canonicalize } from "../src/util/canonicalJson.js";

type Dict = Record<string, any>;

const FIXTURE = new URL(
  "./fixtures/knight-test-v1-result.json",
  import.meta.url,
);
const pretty = (value: unknown) =>
  `${JSON.stringify(JSON.parse(canonicalize(value)), null, 2)}\n`;

const EVENT = "6f1c2a7e-4b1d-4c8e-9a51-2f0d7c3b9e10";
const ENTRY = "0b7d5c1e-9f3a-4e2b-8c6d-1a2b3c4d5e6f";
const PC = "kQx3Lr9ZpT2mWv8A";
const VEHICLE = "vEh1cLe0000000Aa";
const GM = "gmUser0000000001";
const PLAYER = "player0000000001";
const COMPANION = "companion0000001";

function payload(over: Dict = {}): Dict {
  return {
    eventId: EVENT,
    origin: "app",
    actorId: PC,
    label: "Chair · Force + Endurance",
    dice: 7,
    bonus: [2, 1],
    carac: ["Force", "Endurance"],
    difficulty: 4,
    visibility: "public",
    ...over,
  };
}

const roll = (faces: number[]) => ({
  formula: `${faces.length}D6`,
  total: faces.reduce((a, b) => a + b, 0),
  dice: [
    { faces: 6, results: faces.map((result) => ({ result, active: true })) },
  ],
});

class Message {
  id: string;
  flags: Dict = {};
  speaker: Dict;
  rolls: unknown[];
  author?: string;
  whisper?: string[];
  blind?: boolean;
  constructor(id: string, actorId: string, rolls: unknown[]) {
    this.id = id;
    this.speaker = { actor: actorId };
    this.rolls = rolls;
  }
  updateSource(changes: Dict) {
    for (const [key, value] of Object.entries(changes)) {
      if (key === `flags.${MODULE_ID}`) this.flags[MODULE_ID] = value;
      else (this as Dict)[key] = value;
    }
  }
  getFlag(ns: string, key: string) {
    return this.flags[ns]?.[key];
  }
  async setFlag(ns: string, key: string, value: unknown) {
    (this.flags[ns] ??= {})[key] = value;
    fire("updateChatMessage", this);
  }
}

function fire(name: string, ...args: unknown[]): void {
  for (const fn of [...(hooks.get(name)?.values() ?? [])]) fn(...args);
}

/** What the fake roller rolls: each roll's faces, in order (a second roll is
 * the Exploit reroll), and how long the card takes to be created. */
let rolls: number[][];
let createDelayMs: number;
let postsCard: boolean;
let world: Dict;
let hooks: Map<string, Map<number, (...a: any[]) => void>>;
let rollCalls: { data: Dict; updates: Dict }[];

/** The Knight roller as both lanes call it: a plain test awaits its card
 * (`#sendRoll`); a weapon attack creates it after `doRoll` returns, then
 * writes its Knight flags. */
class FakeRollKnight {
  constructor(
    private actor: Dict,
    private data: Dict,
  ) {}
  prepareWpnContact() {
    return { type: "contact", effets: { raw: [] } };
  }
  prepareWpnDistance() {
    return this.prepareWpnContact();
  }
  async doRoll(updates: Dict) {
    rollCalls.push({ data: this.data, updates });
    const msg = new Message(
      `msg${String(world.messages.contents.length + 1).padStart(13, "0")}`,
      this.actor.id,
      rolls.map(roll),
    );
    const create = async () => {
      fire("preCreateChatMessage", msg, {}, {}, GM);
      world.messages.contents.push(msg);
      fire("createChatMessage", msg);
    };
    if (this.data.weapon) {
      void Promise.resolve().then(async () => {
        await create();
        msg.flags.knight = {
          content: [{ total: 0, targets: [] }],
          rollData: this.data,
        };
        fire("updateChatMessage", msg);
      });
      return 0;
    }
    if (!postsCard) return 0;
    if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
    await create();
    return 0;
  }
}

function stubWorld(): void {
  hooks = new Map();
  rollCalls = [];
  let nextHook = 0;
  const gm = { id: GM, name: "GM", isGM: true, active: true };
  const player = {
    id: PLAYER,
    name: "Alice",
    isGM: false,
    active: true,
    character: { id: PC },
  };
  const companion = { id: COMPANION, name: "Companion", isGM: false };
  const users = [gm, player, companion];
  const actors: Dict = {
    [PC]: {
      id: PC,
      type: "knight",
      items: {
        contents: [
          {
            id: "item000000000001",
            type: "arme",
            system: { type: "contact" },
            flags: { [MODULE_ID]: { entryId: ENTRY } },
          },
        ],
      },
    },
    [VEHICLE]: { id: VEHICLE, type: "vehicule", items: { contents: [] } },
  };
  world = {
    system: { id: "knight", version: "3.58.37" },
    release: { generation: 14 },
    user: gm,
    users: {
      contents: users,
      activeGM: gm,
      get: (id: string) => users.find((u) => u.id === id),
    },
    actors: { get: (id: string) => actors[id] },
    messages: { contents: [] as Message[] },
    knight: { RollKnight: FakeRollKnight },
    i18n: {
      localize: (key: string) =>
        key === "KNIGHT.AUTRE.Difficulte" ? "Difficulté" : key,
    },
    settings: {
      get: (_scope: string, key: string) =>
        key === SETTING_AGENT_USER ? COMPANION : "",
    },
  };
  vi.stubGlobal("game", world);
  vi.stubGlobal("canvas", {
    tokens: { placeables: [], get: () => undefined },
  });
  vi.stubGlobal("Hooks", {
    on: (name: string, fn: (...a: any[]) => void) => {
      const id = ++nextHook;
      if (!hooks.has(name)) hooks.set(name, new Map());
      hooks.get(name)!.set(id, fn);
      return id;
    },
    off: (name: string, id: number) => hooks.get(name)?.delete(id),
  });
}

beforeEach(() => {
  rolls = [[2, 5, 6, 1, 4, 3, 2]];
  createDelayMs = 0;
  postsCard = true;
  stubWorld();
});
afterEach(async () => {
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rejection = async (p: unknown) => {
  try {
    await p;
  } catch (error) {
    return error as RpcError;
  }
  throw new Error("expected a rejection");
};
const card = (i = 0) => world.messages.contents[i] as Message;
const preCreateHooks = () => hooks.get("preCreateChatMessage")?.size ?? 0;

describe("knight.test.v1 payload", () => {
  it("accepts the documented payload", () => {
    expect(validateKnightTestV1(payload())).toEqual(payload());
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["a missing key", { difficulty: undefined }],
    ["an uppercase eventId", { eventId: EVENT.toUpperCase() }],
    ["an unknown origin", { origin: "agent" }],
    ["a short actor id", { actorId: "abc" }],
    ["an empty label", { label: " " }],
    ["a 121-char label", { label: "x".repeat(121) }],
    ["no dice", { dice: 0 }],
    ["61 dice", { dice: 61 }],
    ["fractional dice", { dice: 2.5 }],
    ["a bonus above 30", { bonus: [31] }],
    ["a negative bonus", { bonus: [-1] }],
    ["eleven bonuses", { bonus: Array(11).fill(1) }],
    ["no characteristic", { carac: [] }],
    ["seven characteristics", { carac: Array(7).fill("Force") }],
    ["a 41-char characteristic", { carac: ["x".repeat(41)] }],
    ["a negative difficulty", { difficulty: -1 }],
    ["a difficulty of 100", { difficulty: 100 }],
    ["a null difficulty", { difficulty: null }],
    ["an unknown visibility", { visibility: "secret" }],
  ])("refuses %s", (_, over) => {
    const p = payload(over);
    if ("difficulty" in over && over.difficulty === undefined)
      delete p.difficulty;
    expect(() => validateKnightTestV1(p)).toThrow(
      expect.objectContaining({ code: "invalid_args" }),
    );
  });

  it("refuses a non-object payload before touching the world", () => {
    expect(() => knightTestV1([], {} as never)).toThrow(RpcError);
    expect(rollCalls).toEqual([]);
  });
});

describe("knight.test.v1 roll", () => {
  it("runs the system roller with no weapon and no cost, and stamps its card", async () => {
    const result = await knightTestV1(payload(), {} as never);
    expect(result).toEqual({
      messageId: "msg0000000000001",
      alreadyRolled: false,
      faces: [2, 5, 6, 1, 4, 3, 2],
      exploitFaces: null,
      successes: 4,
      bonus: 3,
      total: 7,
      rollState: "normal",
    });
    expect(rollCalls).toHaveLength(1);
    const [call] = rollCalls;
    expect(call!.updates).toEqual({});
    expect(call!.data).toEqual({
      name: "Chair · Force + Endurance",
      dices: "7D6",
      carac: ["Force", "Endurance"],
      bonus: [2, 1],
      difficulte: 4,
      tags: [{ key: "difficulte", label: "Difficulté : 4" }],
    });
    expect(card().author).toBe(PLAYER);
    expect(card().whisper).toEqual([]);
    expect(card().blind).toBe(false);
    expect(card().flags[MODULE_ID]).toEqual({
      eventId: EVENT,
      origin: "app",
      lane: "knight.test",
      testResult: result,
    });
    expect(preCreateHooks()).toBe(0);
  });

  it("sends no difficulty and no tag for difficulty 0", async () => {
    await knightTestV1(payload({ difficulty: 0 }), {} as never);
    expect(rollCalls[0]!.data.difficulte).toBeUndefined();
    expect(rollCalls[0]!.data.tags).toEqual([]);
  });

  it("reads an Exploit: the reroll's faces and both rolls' successes", async () => {
    rolls = [
      [2, 4, 6],
      [1, 2, 5],
    ];
    expect(
      await knightTestV1(payload({ dice: 3, bonus: [] }), {} as never),
    ).toMatchObject({
      faces: [2, 4, 6],
      exploitFaces: [1, 2, 5],
      successes: 4,
      bonus: 0,
      total: 4,
      rollState: "exploit",
    });
  });

  it("reads a critical failure when no die is even", async () => {
    rolls = [[1, 3, 5]];
    expect(
      await knightTestV1(payload({ dice: 3, bonus: [2] }), {} as never),
    ).toMatchObject({
      faces: [1, 3, 5],
      exploitFaces: null,
      successes: 0,
      total: 2,
      rollState: "epicFail",
    });
  });

  it("whispers a gm test to the GMs and the service user, a blind one blind", async () => {
    await knightTestV1(payload({ visibility: "gm" }), {} as never);
    expect(card(0).whisper).toEqual([GM, COMPANION]);
    expect(card(0).blind).toBe(false);
    await knightTestV1(
      payload({
        eventId: "00000000-0000-4000-8000-000000000002",
        visibility: "blind",
      }),
      {} as never,
    );
    expect(card(1).whisper).toEqual([GM, COMPANION]);
    expect(card(1).blind).toBe(true);
  });

  it("answers a retry of the same eventId from the card, never rolling twice", async () => {
    const first = await knightTestV1(payload(), {} as never);
    const again = await knightTestV1(payload(), {} as never);
    expect(rollCalls).toHaveLength(1);
    expect(again).toEqual({ ...(first as Dict), alreadyRolled: true });
  });

  it("joins a same-eventId retry while the first roll is still running, never rolling twice", async () => {
    vi.useFakeTimers();
    createDelayMs = REQUEST_TIMEOUT_MS + 2_000;
    const first = knightTestV1(payload(), {} as never);
    // The backend gave up on the first call and retries it; the queue has
    // let go of the stuck roll, the card is not there yet.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 200);
    expect(world.messages.contents).toHaveLength(0);
    const retry = knightTestV1(payload(), {} as never);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toMatchObject({ alreadyRolled: false });
    expect(await retry).toMatchObject({
      messageId: card().id,
      alreadyRolled: true,
    });
    expect(rollCalls).toHaveLength(1);
    expect(world.messages.contents).toHaveLength(1);
  });

  it("times out when the roller posts no card, and stamps no later roll", async () => {
    vi.useFakeTimers();
    postsCard = false;
    const pending = rejection(knightTestV1(payload(), {} as never));
    await vi.advanceTimersByTimeAsync(TEST_WAIT_MS + 200);
    expect(await pending).toMatchObject({ code: "test_card_timeout" });
    expect(preCreateHooks()).toBe(0);
    const own = new Message("own0000000000001", PC, [
      roll([2, 4, 6, 1, 3, 5, 2]),
    ]);
    fire("preCreateChatMessage", own, {}, {}, GM);
    expect(own.flags[MODULE_ID]).toBeUndefined();
  });

  it("drops the hook when the roller throws", async () => {
    world.knight.RollKnight = class extends FakeRollKnight {
      override async doRoll(): Promise<number> {
        throw new Error("boom");
      }
    };
    await expect(knightTestV1(payload(), {} as never)).rejects.toThrow("boom");
    expect(preCreateHooks()).toBe(0);
  });

  it("stamps an attack and a test of the same actor, back to back, each with its own lane", async () => {
    const attack = knightAttackV1(
      {
        eventId: "00000000-0000-4000-8000-0000000000a1",
        origin: "app",
        actorId: PC,
        entryId: ENTRY,
        label: "Épée",
        dice: 7,
        bonus: [],
        carac: ["Combat"],
        style: "standard",
        surprise: false,
        targetActorIds: [],
        visibility: "public",
      },
      {} as never,
    );
    const test = knightTestV1(payload(), {} as never);
    await Promise.all([attack, test]);
    expect(rollCalls).toHaveLength(2);
    expect(card(0).flags[MODULE_ID]).toMatchObject({
      eventId: "00000000-0000-4000-8000-0000000000a1",
      lane: "knight.attack",
    });
    expect(card(1).flags[MODULE_ID]).toMatchObject({
      eventId: EVENT,
      lane: "knight.test",
    });
    expect(preCreateHooks()).toBe(0);
  });

  it.each([
    ["actor_not_found", { actorId: "missing000000001" }],
    ["actor_unsupported", { actorId: VEHICLE }],
  ])("refuses with %s before rolling", async (code, over) => {
    expect(
      await rejection(knightTestV1(payload(over), {} as never)),
    ).toMatchObject({ code });
    expect(rollCalls).toEqual([]);
    expect(preCreateHooks()).toBe(0);
  });

  it("refuses a non-GM responder", async () => {
    world.user = { id: PLAYER, isGM: false };
    expect(await rejection(knightTestV1(payload(), {} as never))).toMatchObject(
      { code: "permission_denied" },
    );
  });

  // The shared result fixture: this world's result, sorted keys, 2-space
  // indent, trailing newline. Re-cut with UPDATE_KNIGHT_TEST_FIXTURE=1.
  it("produces the shared result fixture", async () => {
    const text = pretty(await knightTestV1(payload(), {} as never));
    if (process.env.UPDATE_KNIGHT_TEST_FIXTURE === "1")
      writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });
});

describe("knight.test.v1 registration", () => {
  it("is a signed-only mutation on Knight with the roller", () => {
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).toContain("knight.test.v1");
    expect(registry.mutations()).toContain("knight.test.v1");
    expect(registry.isSignedOnly("knight.test.v1")).toBe(true);
  });

  it("is withheld, with its reason, when the roller has no doRoll", () => {
    world.knight = { RollKnight: class {} };
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).not.toContain("knight.test.v1");
    expect(registry.unsupported()["knight.test.v1"]).toMatch(/doRoll/);
  });

  it("is withheld below the Knight floor", () => {
    world.system = { id: "knight", version: "3.58.32" };
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).not.toContain("knight.test.v1");
    expect(registry.unsupported()["knight.test.v1"]).toMatch(/3\.58\.33/);
  });
});
