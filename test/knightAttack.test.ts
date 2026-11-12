import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACK_STAMP_MS,
  ATTACK_WAIT_MS,
  buildAttackResult,
  knightAttackV1,
  validateKnightAttackV1,
  type CardMessage,
} from "../src/procedures/knightAttack.js";
import { stampFollowUp } from "../src/procedures/knightAttackFollowUps.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import {
  MODULE_ID,
  REQUEST_TIMEOUT_MS,
  SETTING_AGENT_USER,
} from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";

type Dict = Record<string, any>;

// The result shape the backend and the apps read, cut by hand from a Knight
// 3.58.37 attack card (ids are synthetic).
const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/knight-attack-v1-result.json", import.meta.url),
    "utf8",
  ),
);

const EVENT = "6f1c2a7e-4b1d-4c8e-9a51-2f0d7c3b9e10";
const ENTRY = "0b7d5c1e-9f3a-4e2b-8c6d-1a2b3c4d5e6f";
const PC = "kQx3Lr9ZpT2mWv8A";
const NOCTE = "Nf7cH2kLm9QwE4rT";
const GARDE_TOKEN = "T0k3nZ9y8X7w6V5u";
const NOCTE_TOKEN = "T0k3nA1b2C3d4E5f";
const GM = "gmUser0000000001";
const PLAYER = "player0000000001";
const COMPANION = "companion0000001";

function payload(over: Dict = {}): Dict {
  return {
    eventId: EVENT,
    origin: "app",
    actorId: PC,
    entryId: ENTRY,
    label: "Épée bâtarde",
    dice: 7,
    bonus: [3],
    carac: ["Combat", "Force"],
    style: "standard",
    surprise: false,
    targetActorIds: [NOCTE],
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

/** A token on the GM's canvas. */
const token = (id: string, actorId: string | null) => ({
  id,
  document: { actorId },
});

class Message implements CardMessage {
  id: string;
  flags: Dict = {};
  speaker: Dict;
  rolls: unknown[];
  content: string;
  flavor?: string;
  author?: string;
  whisper?: string[];
  blind?: boolean;
  constructor(id: string, actorId: string, rolls: unknown[], content = "") {
    this.id = id;
    this.speaker = { actor: actorId };
    this.rolls = rolls;
    this.content = content;
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

/** Run a hook's handlers the way Foundry's `Hooks.callAll` does. */
function fire(name: string, ...args: unknown[]): void {
  for (const fn of [...(hooks.get(name)?.values() ?? [])]) fn(...args);
}

/** What the fake roller writes: its rolls, and the per-target lines of
 * `flags.knight.content[0].targets` for the targets it was given. */
interface Scenario {
  rolls: number[][];
  total?: number;
  targets: Dict[];
  weaponRaw?: string[];
  /** Merged into the prepared weapon (structural effects, options). */
  weapon?: Dict;
  landFlags?: boolean;
  /** Create the card this long after doRoll returns (the system is slow). */
  createAfterMs?: number;
}

let scenario: Scenario;
let world: Dict;
let hooks: Map<string, Map<number, (...a: any[]) => void>>;
let rollCalls: { data: Dict; updates: Dict; gmTargets: string[] }[];

class FakeRollKnight {
  constructor(
    private actor: Dict,
    private data: Dict,
  ) {}
  prepareWpnContact(item: Dict) {
    return {
      label: item.name,
      type: "contact",
      effets: { raw: scenario.weaponRaw ?? [] },
      ...scenario.weapon,
    };
  }
  prepareWpnDistance(item: Dict) {
    const weapon: Dict = { ...this.prepareWpnContact(item), type: "distance" };
    // Like Knight 3.58.38: ranged preparation defaults a barrage option ON.
    const raw = [
      ...(weapon.effets?.raw ?? []),
      ...(weapon.structurelles?.raw ?? []),
      ...(weapon.ornementales?.raw ?? []),
    ];
    if (!weapon.options && raw.some((e: string) => e.startsWith("barrage ")))
      weapon.options = [{ value: "barrage", active: true }];
    return weapon;
  }
  async doRoll(updates: Dict) {
    rollCalls.push({
      data: this.data,
      updates,
      gmTargets: [...world.user.targets].map((t: Dict) => t.id),
    });
    const msg = new Message(
      `msg${String(world.messages.contents.length + 1).padStart(13, "0")}`,
      this.actor.id,
      scenario.rolls.map(roll),
    );
    // Like #sendRollWeapon: not awaited by doRoll; create, then addFlags.
    const create = async () => {
      fire("preCreateChatMessage", msg, {}, {}, GM);
      world.messages.contents.push(msg);
      fire("createChatMessage", msg);
      if (scenario.landFlags === false) return;
      await Promise.resolve();
      msg.flags.knight = {
        content: [
          {
            total: scenario.total,
            targets: (this.data.targets as { id: string }[]).map((t, i) => ({
              id: t.id,
              ...scenario.targets[i],
            })),
          },
        ],
        rollData: this.data,
        surprise: this.data.surprise,
        weapon: this.data.weapon,
      };
      fire("updateChatMessage", msg); // addFlags is a document update
    };
    if (scenario.createAfterMs)
      setTimeout(() => void create(), scenario.createAfterMs);
    else void Promise.resolve().then(create);
    return 0;
  }
}

function stubWorld(over: Dict = {}): void {
  hooks = new Map();
  rollCalls = [];
  let nextHook = 0;
  const tokens = [token(NOCTE_TOKEN, NOCTE), token(GARDE_TOKEN, null)];
  const gm = {
    id: GM,
    name: "GM",
    isGM: true,
    active: true,
    targets: new Set(),
  };
  const player = {
    id: PLAYER,
    name: "Alice",
    isGM: false,
    active: true,
    character: { id: PC },
    targets: new Set(),
  };
  const companion = {
    id: COMPANION,
    name: "Companion",
    isGM: false,
    active: true,
    targets: new Set(),
  };
  const users = [gm, player, companion];
  const item = {
    id: "item000000000001",
    name: "Épée bâtarde",
    type: "arme",
    system: { type: "contact" },
    flags: { [MODULE_ID]: { entryId: ENTRY } },
  };
  const actor = {
    id: PC,
    name: "Hero",
    items: { contents: [item] },
    testUserPermission: (u: Dict) => u.id === PLAYER,
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
    actors: { get: (id: string) => (id === PC ? actor : undefined) },
    messages: { contents: [] as Message[] },
    knight: { RollKnight: FakeRollKnight },
    i18n: {
      localize: (key: string) =>
        ({
          "KNIGHT.JETS.RESULTATS.VsDefense": "vs Défense",
          "KNIGHT.JETS.RESULTATS.VsReaction": "vs Réaction",
        })[key] ?? key,
    },
    // The paired backend user is the Companion, known by id only.
    settings: {
      get: (_scope: string, key: string) =>
        key === SETTING_AGENT_USER ? COMPANION : "",
    },
    ...over,
  };
  vi.stubGlobal("game", world);
  vi.stubGlobal("canvas", {
    tokens: {
      placeables: tokens,
      get: (id: string) => tokens.find((t) => t.id === id),
      setTargets: vi.fn((ids: string[]) => {
        world.user.targets = new Set(tokens.filter((t) => ids.includes(t.id)));
      }),
    },
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

const NOCTE_LINE = {
  name: "Nocte",
  difficulty: 5,
  hit: true,
  marge: 2,
  ptsFaible: false,
  defense: "vs Défense (5)",
  effets: [
    { label: "Choc 1", hit: true },
    { label: "Électrifiée", hit: false },
  ],
};
const GARDE_LINE = {
  name: "Garde",
  difficulty: 8,
  ptsFaible: false,
  defense: "vs Défense (8)",
  effets: [],
};

const tokenOf = (id: string) =>
  (globalThis as any).canvas.tokens.get(id) as Dict;

beforeEach(() => {
  scenario = {
    rolls: [[2, 5, 6, 1, 4, 3, 2]],
    total: 7,
    targets: [NOCTE_LINE],
  };
  stubWorld();
});
afterEach(async () => {
  // Let every late-stamp window close, so no attack is still in flight for
  // the next test's same eventId.
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

describe("knight.attack.v1 payload", () => {
  it("accepts the documented payload", () => {
    expect(validateKnightAttackV1(payload())).toEqual(payload());
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["a missing key", { visibility: undefined }],
    ["an uppercase eventId", { eventId: EVENT.toUpperCase() }],
    ["a short actor id", { actorId: "abc" }],
    ["a non-UUID entryId", { entryId: "sword" }],
    ["an empty label", { label: " " }],
    ["a 121-char label", { label: "x".repeat(121) }],
    ["no dice", { dice: 0 }],
    ["61 dice", { dice: 61 }],
    ["a bonus above 30", { bonus: [31] }],
    ["eleven bonuses", { bonus: Array(11).fill(1) }],
    ["seven characteristics", { carac: Array(7).fill("Force") }],
    ["a 41-char characteristic", { carac: ["x".repeat(41)] }],
    ["a style with a space", { style: "a b" }],
    ["a string surprise", { surprise: "no" }],
    ["21 target actors", { targetActorIds: Array(21).fill(NOCTE) }],
    ["an unknown visibility", { visibility: "secret" }],
    ["an unknown origin", { origin: "agent" }],
  ])("refuses %s", (_, over) => {
    const p = payload(over);
    if ("visibility" in over && over.visibility === undefined)
      delete p.visibility;
    expect(() => validateKnightAttackV1(p)).toThrow(
      expect.objectContaining({ code: "invalid_args" }),
    );
  });

  it("refuses a non-object payload before touching the world", async () => {
    expect(() => knightAttackV1([], {} as never)).toThrow(RpcError);
    expect(rollCalls).toEqual([]);
  });
});

describe("knight.attack.v1 roll", () => {
  it("runs the system roller and returns the fixture-shaped result", async () => {
    world.users.get(PLAYER).targets = new Set([
      tokenOf(NOCTE_TOKEN),
      tokenOf(GARDE_TOKEN),
    ]);
    scenario.targets = [NOCTE_LINE, GARDE_LINE];
    const result = await knightAttackV1(payload(), {} as never);

    expect(result).toEqual({ ...FIXTURE, messageId: "msg0000000000001" });
    const [call] = rollCalls;
    expect(call!.updates).toEqual({});
    expect(call!.data).toMatchObject({
      name: "Épée bâtarde",
      dices: "7D6",
      carac: ["Combat", "Force"],
      bonus: [3],
      style: "standard",
      surprise: false,
      targets: [{ id: NOCTE_TOKEN }, { id: GARDE_TOKEN }],
      dataStyle: {},
      dataMod: { degats: { dice: 0, fixe: 0 }, violence: { dice: 0, fixe: 0 } },
      maximize: { degats: false, violence: false },
      weapon: { type: "contact" },
    });
    const card = world.messages.contents[0] as Message;
    expect(card.author).toBe(PLAYER);
    expect(card.whisper).toEqual([]);
    expect(card.blind).toBe(false);
    expect(card.flags[MODULE_ID]).toEqual({
      eventId: EVENT,
      origin: "app",
      lane: "knight.attack",
      attackResult: result,
    });
    expect(hooks.get("preCreateChatMessage")?.size).toBe(0);
  });

  it("answers a retry of the same eventId from the card, never rolling twice", async () => {
    const first = await knightAttackV1(payload(), {} as never);
    const again = await knightAttackV1(payload(), {} as never);
    expect(rollCalls).toHaveLength(1);
    expect(again).toEqual({ ...(first as Dict), alreadyRolled: true });
  });

  it("picks targets: player, then the app chip, then the GM, else none", async () => {
    const sourceOf = async (eventId: string) =>
      ((await knightAttackV1(payload({ eventId }), {} as never)) as Dict)
        .targetSource;
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

    world.users.get(PLAYER).targets = new Set([tokenOf(GARDE_TOKEN)]);
    world.user.targets = new Set([tokenOf(NOCTE_TOKEN)]);
    expect(await sourceOf(id(1))).toBe("player");
    expect(rollCalls.at(-1)!.data.targets).toEqual([{ id: GARDE_TOKEN }]);

    world.users.get(PLAYER).targets = new Set();
    expect(await sourceOf(id(2))).toBe("app");
    expect(rollCalls.at(-1)!.data.targets).toEqual([{ id: NOCTE_TOKEN }]);

    world.user.targets = new Set([tokenOf(GARDE_TOKEN)]);
    expect(
      (
        (await knightAttackV1(
          payload({ eventId: id(3), targetActorIds: [] }),
          {} as never,
        )) as Dict
      ).targetSource,
    ).toBe("gm");
    expect(rollCalls.at(-1)!.data.targets).toEqual([{ id: GARDE_TOKEN }]);

    world.user.targets = new Set();
    scenario.targets = [];
    const none = (await knightAttackV1(
      payload({ eventId: id(4), targetActorIds: ["noToken000000001"] }),
      {} as never,
    )) as Dict;
    expect(none.targetSource).toBe("none");
    expect(none.targets).toEqual([]);
  });

  it("ignores the targets of a player who is not connected", async () => {
    world.users.get(PLAYER).active = false;
    world.users.get(PLAYER).targets = new Set([tokenOf(GARDE_TOKEN)]);
    const result = (await knightAttackV1(payload(), {} as never)) as Dict;
    expect(result.targetSource).toBe("app");
  });

  it("applies the app's visibility and keeps the GM as author without a player", async () => {
    world.users.contents.splice(1, 1);
    await knightAttackV1(payload({ visibility: "blind" }), {} as never);
    const card = world.messages.contents[0] as Message;
    expect(card.author).toBeUndefined();
    // A blind roll reaches the service user too, so the backend can still
    // read its result when the reply was lost.
    expect(card.whisper).toEqual([GM, COMPANION]);
    expect(card.blind).toBe(true);
  });

  it("whispers a self roll to its author and the service user", async () => {
    await knightAttackV1(payload({ visibility: "self" }), {} as never);
    expect((world.messages.contents[0] as Message).whisper).toEqual([
      PLAYER,
      COMPANION,
    ]);
  });

  it("adds a renamed service user to a self roll by id, and whispers a public roll to no one", async () => {
    world.users.contents[2].name = "Table app";
    world.users.contents[1].name = "Companion";
    await knightAttackV1(payload({ visibility: "self" }), {} as never);
    expect((world.messages.contents[0] as Message).whisper).toEqual([
      PLAYER,
      COMPANION,
    ]);
    await knightAttackV1(
      payload({ eventId: "00000000-0000-4000-8000-000000000005" }),
      {} as never,
    );
    expect((world.messages.contents[1] as Message).whisper).toEqual([]);
  });

  it("never makes the app's service user the author", async () => {
    world.users.contents.splice(1, 1);
    world.actors.get(PC).testUserPermission = () => true;
    await knightAttackV1(payload({ visibility: "gm" }), {} as never);
    const card = world.messages.contents[0] as Message;
    expect(card.author).toBeUndefined();
    // A GM roll reaches the service user too: the backend reads the world as it.
    expect(card.whisper).toEqual([GM, COMPANION]);
  });

  it("tells the service user by id, not by name", async () => {
    // The real service user was renamed; a player took the default name.
    world.users.contents[2].name = "Table app";
    world.users.contents[1].name = "Companion";
    await knightAttackV1(payload({ visibility: "gm" }), {} as never);
    const card = world.messages.contents[0] as Message;
    expect(card.author).toBe(PLAYER);
    expect(card.whisper).toEqual([GM, COMPANION]);
  });

  it("rolls a ranged barrage weapon as an attack, with the option off", async () => {
    world.actors.get(PC).items.contents[0].system.type = "distance";
    scenario.weaponRaw = ["barrage 2"];
    await knightAttackV1(payload(), {} as never);
    expect(rollCalls).toHaveLength(1);
    expect((rollCalls[0]!.data.weapon as Dict).options).toEqual([
      { value: "barrage", active: false },
    ]);
  });

  it("refuses a barrage weapon with no barrage option to turn off", async () => {
    scenario.weaponRaw = ["barrage 2"];
    expect(
      await rejection(knightAttackV1(payload(), {} as never)),
    ).toMatchObject({ code: "weapon_unsupported" });
    scenario.weaponRaw = [];
    scenario.weapon = { ornementales: { raw: ["barrage 1"] } };
    expect(
      await rejection(knightAttackV1(payload(), {} as never)),
    ).toMatchObject({ code: "weapon_unsupported" });
    expect(rollCalls).toEqual([]);
    expect(hooks.get("preCreateChatMessage")?.size ?? 0).toBe(0);
  });

  it("rolls a barrage weapon whose barrage option is off", async () => {
    scenario.weapon = {
      structurelles: { raw: ["barrage 2"] },
      options: [{ value: "barrage", active: false }],
    };
    await knightAttackV1(payload(), {} as never);
    expect(rollCalls).toHaveLength(1);
  });

  it("lends the GM's targets to a cadence weapon and restores them", async () => {
    scenario.weaponRaw = ["cadence 2"];
    world.user.targets = new Set([tokenOf(GARDE_TOKEN)]);
    await knightAttackV1(payload(), {} as never);
    expect(rollCalls[0]!.gmTargets).toEqual([NOCTE_TOKEN]);
    expect([...world.user.targets].map((t: any) => t.id)).toEqual([
      GARDE_TOKEN,
    ]);
  });

  it("restores the targets and drops the hook when the roller throws", async () => {
    scenario.weaponRaw = ["cadence 2"];
    world.knight.RollKnight = class extends FakeRollKnight {
      override async doRoll(): Promise<number> {
        throw new Error("boom");
      }
    };
    await expect(knightAttackV1(payload(), {} as never)).rejects.toThrow(
      "boom",
    );
    expect(world.user.targets.size).toBe(0);
    expect(hooks.get("preCreateChatMessage")?.size).toBe(0);
  });

  it("times out when the card's Knight flags never land", async () => {
    vi.useFakeTimers();
    scenario.landFlags = false;
    const pending = rejection(knightAttackV1(payload(), {} as never));
    await vi.advanceTimersByTimeAsync(ATTACK_WAIT_MS + 200);
    expect(await pending).toMatchObject({ code: "attack_card_timeout" });
    // The card was created and stamped: a retry finds it and never rolls again.
    expect(world.messages.contents[0].flags[MODULE_ID].eventId).toBe(EVENT);
    expect(hooks.get("preCreateChatMessage")?.size).toBe(0);
  });

  it("keeps the hook for a late card only until the late-stamp window closes", async () => {
    vi.useFakeTimers();
    scenario.createAfterMs = ATTACK_STAMP_MS + 5_000;
    const pending = rejection(knightAttackV1(payload(), {} as never));
    await vi.advanceTimersByTimeAsync(ATTACK_WAIT_MS + 200);
    expect(await pending).toMatchObject({ code: "attack_card_timeout" });
    // The hook waits for a late card until the late-stamp window closes.
    expect(hooks.get("preCreateChatMessage")?.size).toBe(1);
    await vi.advanceTimersByTimeAsync(ATTACK_STAMP_MS);
    expect(hooks.get("preCreateChatMessage")?.size).toBe(0);
    expect(world.messages.contents[0].flags[MODULE_ID]).toBeUndefined();
  });

  it("stamps a card created after the answer, and a retry answers from it", async () => {
    vi.useFakeTimers();
    scenario.createAfterMs = ATTACK_WAIT_MS + 2_000;
    const late = rejection(knightAttackV1(payload(), {} as never));
    await vi.advanceTimersByTimeAsync(ATTACK_WAIT_MS + 200);
    expect(await late).toMatchObject({ code: "attack_card_timeout" });

    await vi.advanceTimersByTimeAsync(3_000);
    const card = world.messages.contents[0] as Message;
    expect(card.flags[MODULE_ID]).toMatchObject({
      eventId: EVENT,
      lane: "knight.attack",
      attackResult: { messageId: card.id, alreadyRolled: false },
    });
    expect(hooks.get("preCreateChatMessage")?.size).toBe(0);

    const retry = knightAttackV1(payload(), {} as never);
    await vi.advanceTimersByTimeAsync(200);
    expect(await retry).toMatchObject({
      messageId: card.id,
      alreadyRolled: true,
    });
    expect(rollCalls).toHaveLength(1);
  });

  it("joins a same-eventId retry while the first card is still on its way, never rolling twice", async () => {
    vi.useFakeTimers();
    scenario.createAfterMs = ATTACK_WAIT_MS + 3_000;
    const first = rejection(knightAttackV1(payload(), {} as never));
    await vi.advanceTimersByTimeAsync(ATTACK_WAIT_MS + 200);
    expect(await first).toMatchObject({ code: "attack_card_timeout" });
    expect(world.messages.contents).toHaveLength(0);

    // The backend retries the timed-out call before the late card lands.
    const retry = knightAttackV1(payload(), {} as never);
    await vi.advanceTimersByTimeAsync(4_000);
    const card = world.messages.contents[0] as Message;
    expect(await retry).toMatchObject({
      messageId: card.id,
      alreadyRolled: true,
    });
    expect(rollCalls).toHaveLength(1);
    expect(world.messages.contents).toHaveLength(1);
    expect(card.flags[MODULE_ID].eventId).toBe(EVENT);
  });

  it("answers as soon as the card's flags land, with no timer firing (a hidden tab)", async () => {
    vi.useFakeTimers();
    let answer: unknown;
    void Promise.resolve(knightAttackV1(payload(), {} as never)).then(
      (r) => (answer = r),
    );
    // Only promise jobs run: a throttled tab's timers never fire here.
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toMatchObject({ alreadyRolled: false, successes: 4 });
  });

  it("does not let a roll that never settles block later attacks", async () => {
    vi.useFakeTimers();
    let calls = 0;
    world.knight.RollKnight = class extends FakeRollKnight {
      override doRoll(updates: Dict): Promise<number> {
        return calls++ === 0 ? new Promise(() => {}) : super.doRoll(updates);
      }
    };
    void knightAttackV1(
      payload({ eventId: "00000000-0000-4000-8000-0000000000f1" }),
      {} as never,
    );
    let answer: unknown;
    void Promise.resolve(
      knightAttackV1(
        payload({ eventId: "00000000-0000-4000-8000-0000000000f2" }),
        {} as never,
      ),
    ).then((r) => (answer = r));
    await vi.advanceTimersByTimeAsync(ATTACK_STAMP_MS);
    expect(answer).toMatchObject({ alreadyRolled: false });
  });

  it("never stamps another roll of the actor when the roller posted no card", async () => {
    vi.useFakeTimers();
    world.knight.RollKnight = class extends FakeRollKnight {
      override async doRoll(): Promise<number> {
        return 0; // resolves, but no card is ever created
      }
    };
    const first = rejection(knightAttackV1(payload(), {} as never));
    await vi.advanceTimersByTimeAsync(ATTACK_WAIT_MS + 200);
    expect(await first).toMatchObject({ code: "attack_card_timeout" });
    // The GM rolls a smaller pool from the same PC's sheet within the minute.
    const own = new Message("own0000000000001", PC, [roll([2, 4, 6])]);
    own.author = GM;
    fire("preCreateChatMessage", own, {}, {}, GM);
    expect(own.flags[MODULE_ID]).toBeUndefined();
    expect(own.author).toBe(GM);
  });

  it("drops an older unfired hook when a new attack starts for the actor", async () => {
    vi.useFakeTimers();
    scenario.createAfterMs = 30_000;
    const first = rejection(knightAttackV1(payload(), {} as never));
    await vi.advanceTimersByTimeAsync(ATTACK_WAIT_MS + 200);
    expect(await first).toMatchObject({ code: "attack_card_timeout" });
    expect(hooks.get("preCreateChatMessage")?.size).toBe(1);

    scenario.createAfterMs = undefined;
    const second = knightAttackV1(
      payload({ eventId: "00000000-0000-4000-8000-000000000002" }),
      {} as never,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(await second).toMatchObject({ alreadyRolled: false });
    expect(hooks.get("preCreateChatMessage")?.size).toBe(0);

    // The first card arrives late, with no hook left: it imports unstamped.
    await vi.advanceTimersByTimeAsync(30_000);
    const [stamped, unstamped] = world.messages.contents as Message[];
    expect(stamped!.flags[MODULE_ID].eventId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(unstamped!.flags[MODULE_ID]).toBeUndefined();
  });

  it("keeps a newer roll's hook when an older attack's roller fails late", async () => {
    vi.useFakeTimers();
    let calls = 0;
    world.knight.RollKnight = class extends FakeRollKnight {
      override doRoll(updates: Dict): Promise<number> {
        if (calls++ > 0) return super.doRoll(updates);
        return new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("late")),
            REQUEST_TIMEOUT_MS + 1_000,
          ),
        );
      }
    };
    const first = rejection(knightAttackV1(payload(), {} as never));
    // The queue lets go of the stuck roll; a newer attack of the same actor
    // arms its hook, and its card comes after the older roller fails.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 200);
    scenario.createAfterMs = 3_000;
    const second = knightAttackV1(
      payload({ eventId: "00000000-0000-4000-8000-000000000002" }),
      {} as never,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(hooks.get("preCreateChatMessage")?.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first).message).toBe("late");
    expect(hooks.get("preCreateChatMessage")?.size).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await second).toMatchObject({ alreadyRolled: false });
    expect(
      (world.messages.contents[0] as Message).flags[MODULE_ID].eventId,
    ).toBe("00000000-0000-4000-8000-000000000002");
  });

  it.each([
    ["actor_not_found", () => payload({ actorId: "missing000000001" })],
    [
      "weapon_not_found",
      () => payload({ entryId: "11111111-2222-4333-8444-555555555555" }),
    ],
  ])("refuses with %s before rolling", async (code, p) => {
    expect(await rejection(knightAttackV1(p(), {} as never))).toMatchObject({
      code,
    });
    expect(rollCalls).toEqual([]);
  });

  it("refuses when the roller is gone at call time", async () => {
    world.knight = {};
    expect(
      await rejection(knightAttackV1(payload(), {} as never)),
    ).toMatchObject({ code: "knight_api_missing" });
  });

  it("refuses a non-GM responder", async () => {
    world.user = { id: PLAYER, isGM: false, targets: new Set() };
    expect(
      await rejection(knightAttackV1(payload(), {} as never)),
    ).toMatchObject({ code: "permission_denied" });
  });
});

describe("knight.attack.v1 result", () => {
  const card = (rolls: number[][], content: Dict[], over: Dict = {}) => {
    const m = new Message("msg0000000000009", PC, rolls.map(roll));
    m.flags.knight = { content, rollData: { bonus: [2] }, ...over };
    return m;
  };

  it("reads an Exploit: the reroll's faces and both rolls' successes", () => {
    const r = buildAttackResult(
      card(
        [
          [2, 4, 6],
          [1, 2, 5],
        ],
        [{ total: 6, targets: [] }],
      ),
      "none",
    );
    expect(r).toMatchObject({
      faces: [2, 4, 6],
      exploitFaces: [1, 2, 5],
      successes: 4,
      bonus: 2,
      total: 6,
      rollState: "exploit",
    });
  });

  it("reads a critical failure that the flat successes still carry to a hit", () => {
    const r = buildAttackResult(
      card(
        [[1, 3, 5]],
        [
          {
            total: 2,
            targets: [
              {
                id: NOCTE_TOKEN,
                name: "Nocte",
                difficulty: 1,
                hit: true,
                marge: 1,
                defense: "vs Réaction (1)",
              },
            ],
          },
        ],
      ),
      "app",
    );
    expect(r).toMatchObject({
      faces: [1, 3, 5],
      exploitFaces: null,
      successes: 0,
      total: 2,
      rollState: "epicFail",
    });
    expect(r.targets[0]).toEqual({
      tokenId: NOCTE_TOKEN,
      actorId: NOCTE,
      name: "Nocte",
      versus: "reaction",
      difficulty: 1,
      hit: true,
      margin: 1,
      weakPoint: false,
      effects: [],
    });
  });

  it("reads no versus on a surprise attack", () => {
    const r = buildAttackResult(
      card(
        [[2]],
        [
          {
            total: 3,
            targets: [
              {
                id: NOCTE_TOKEN,
                defense: "vs Défense (0)",
                hit: true,
                marge: 3,
              },
            ],
          },
        ],
        { surprise: true },
      ),
      "app",
    );
    expect(r.targets[0]!.versus).toBeNull();
  });

  it("reads a barrage card, which rolls nothing", () => {
    const r = buildAttackResult(
      card([], [{ targets: [{ id: NOCTE_TOKEN, hit: true }] }]),
      "gm",
    );
    expect(r).toMatchObject({
      faces: [],
      successes: 0,
      total: 2,
      rollState: "normal",
    });
    expect(r.targets[0]).toMatchObject({ hit: true, margin: null });
  });
});

describe("knight.attack.v1 follow-ups", () => {
  async function attackCard(): Promise<Message> {
    await knightAttackV1(payload(), {} as never);
    return world.messages.contents[0] as Message;
  }

  /** A damage card as rollDamage writes it: the attack's rolls in flags. */
  function followUp(attack: Message, over: Dict = {}): Message {
    const m = new Message(
      "msg0000000000002",
      PC,
      [roll([6, 6])],
      `<div><h4 class="dice-total">\n  14\n</h4></div>`,
    );
    m.flags.knight = {
      attaque: JSON.parse(JSON.stringify(attack.rolls)),
      weapon: { rollType: "damage" },
      ...over,
    };
    return m;
  }

  it("stamps a damage card with its attack's eventId and total", async () => {
    const attack = await attackCard();
    const dmg = followUp(attack);
    expect(await stampFollowUp(dmg)).toBe(true);
    expect(dmg.flags[MODULE_ID]).toEqual({
      followUp: { attackEventId: EVENT, kind: "damage", total: 14 },
    });
    expect(await stampFollowUp(dmg)).toBe(false);
  });

  it("reads violence from the flavor when the weapon has no roll type", async () => {
    const attack = await attackCard();
    const v = followUp(attack, { weapon: {} });
    v.flavor = "Épée bâtarde : Violence";
    await stampFollowUp(v);
    expect(v.flags[MODULE_ID].followUp.kind).toBe("violence");
  });

  it("leaves cards alone off the responder, or with no matching attack", async () => {
    const attack = await attackCard();
    const stranger = followUp(attack, { attaque: [roll([1, 1])] });
    expect(await stampFollowUp(stranger)).toBe(false);
    world.users.activeGM = { id: "otherGm000000001" };
    expect(await stampFollowUp(followUp(attack))).toBe(false);
    expect(await stampFollowUp(attack)).toBe(false);
  });
});

describe("knight.attack.v1 registration", () => {
  it("is a signed-only mutation on Knight with the roller", () => {
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).toContain("knight.attack.v1");
    expect(registry.mutations()).toContain("knight.attack.v1");
    expect(registry.isSignedOnly("knight.attack.v1")).toBe(true);
  });

  it("is withheld, with its reason, when the roller lacks a member", () => {
    world.knight = { RollKnight: class {} };
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).not.toContain("knight.attack.v1");
    expect(registry.unsupported()["knight.attack.v1"]).toMatch(/RollKnight/);
  });

  it("is withheld below the Knight floor", () => {
    world.system = { id: "knight", version: "3.58.32" };
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.unsupported()["knight.attack.v1"]).toMatch(/3\.58\.33/);
  });
});
