import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_ID } from "../src/constants.js";
import {
  buildKnightFollowupResult,
  knightFollowupV1,
  supportsKnightFollowupV1Runtime,
  validateKnightFollowupV1,
} from "../src/procedures/knightFollowup.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";

type Dict = Record<string, any>;
const actorId = "kQx3Lr9ZpT2mWv8A";
const sourceEventId = "6f1c2a7e-4b1d-4c8e-9a51-2f0d7c3b9e10";
const eventId = "0b7d5c1e-9f3a-4e2b-8c6d-1a2b3c4d5e6f";
const payload = (over: Dict = {}) => ({
  eventId,
  origin: "player",
  actorId,
  sourceEventId,
  kind: "damage",
  ...over,
});
const roll = {
  dice: [
    {
      faces: 6,
      results: [{ result: 2 }, { result: 5 }, { result: 1, active: false }],
    },
  ],
};
let world: Dict;
let source: Dict;
let hooks: Map<string, Map<number, (...args: any[]) => void>>;
let calls: Dict[];
let delay = 0;
let throwsAfterRoll = false;
const fire = (name: string, ...args: any[]) => {
  for (const fn of [...(hooks.get(name)?.values() ?? [])]) fn(...args);
};

class Roller {
  constructor(
    private actor: Dict,
    private data: Dict,
  ) {}
  prepareWpnContact() {
    return {};
  }
  prepareWpnDistance() {
    return {};
  }
  async doRoll() {}
  async doRollDamage(data: Dict) {
    return this.post("damage", data);
  }
  async doRollViolence(data: Dict) {
    return this.post("violence", data);
  }
  async post(kind: string, data: Dict) {
    calls.push({ kind, data, weapon: this.data.weapon });
    const post = () => {
      const msg: Dict = {
        id: "message000000001",
        flags: {},
        speaker: { actor: this.actor.id },
        rolls: [roll],
        content: '<h4 class="dice-total">14</h4>',
      };
      msg.updateSource = (changes: Dict) => {
        for (const [key, value] of Object.entries(changes)) {
          if (key === `flags.${MODULE_ID}`) msg.flags[MODULE_ID] = value;
          else if (key === "_id") msg.id = value;
          else msg[key] = value;
        }
      };
      fire("preCreateChatMessage", msg, {}, {});
      world.messages.contents.push(msg);
      fire("createChatMessage", msg);
    };
    if (delay) setTimeout(post, delay);
    else post();
    if (throwsAfterRoll) throw new Error("system failed after its card");
  }
}

beforeEach(() => {
  delay = 0;
  throwsAfterRoll = false;
  calls = [];
  hooks = new Map();
  let next = 0;
  const gm = { id: "gmUser0000000001", active: true, isGM: true };
  source = {
    id: "source0000000001",
    speaker: { actor: actorId },
    _source: {
      author: "player0000000001",
      whisper: ["gmUser0000000001"],
      blind: true,
    },
    rolls: [{ formula: "5d6", total: 18 }],
    flags: {
      [MODULE_ID]: { eventId: sourceEventId, lane: "knight.attack" },
      knight: {
        flavor: "Pistolet",
        weapon: { effets: { raw: [] } },
        style: "standard",
        dataStyle: {},
        dataMod: {
          degats: { dice: 0, fixe: 0 },
          violence: { dice: 0, fixe: 0 },
        },
        maximize: { degats: false, violence: false },
        content: [
          {
            total: 5,
            targets: [
              {
                hit: true,
                btn: [
                  { classes: ["applyAttaqueEffects"] },
                  { classes: ["autoStatus"] },
                  { classes: ["damage"] },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  world = {
    system: { id: "knight", version: "3.58.38" },
    release: { generation: 14 },
    user: gm,
    users: { activeGM: gm, contents: [gm] },
    settings: { get: () => "" },
    actors: {
      get: (id: string) => (id === actorId ? { id: actorId } : undefined),
    },
    messages: { contents: [source] },
    knight: { RollKnight: Roller },
  };
  vi.stubGlobal("game", world);
  vi.stubGlobal("Hooks", {
    on: (name: string, fn: (...args: any[]) => void) => {
      if (!hooks.has(name)) hooks.set(name, new Map());
      const id = ++next;
      hooks.get(name)!.set(id, fn);
      return id;
    },
    off: (name: string, id: number) => hooks.get(name)?.delete(id),
  });
});
afterEach(async () => {
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Knight follow-up", () => {
  it("reads the shared shape-only Knight 3.58.38 contract", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/knight-followup-v1.json", import.meta.url),
        "utf8",
      ),
    );
    expect(validateKnightFollowupV1(fixture.request)).toEqual(fixture.request);
    expect(
      buildKnightFollowupResult(
        {
          rolls: [
            { dice: [{ faces: 6, results: [{ result: 4 }, { result: 5 }] }] },
          ],
          content: '<h4 class="dice-total">15</h4>',
        },
        "damage",
        fixture.result.messageId,
      ),
    ).toEqual(fixture.result);
  });
  it("strictly accepts only its five keys and two kinds", () => {
    expect(validateKnightFollowupV1(payload())).toEqual(payload());
    expect(validateKnightFollowupV1(payload({ kind: "violence" })).kind).toBe(
      "violence",
    );
    for (const bad of [
      payload({ kind: "critical" }),
      payload({ origin: "gm" }),
      payload({ actorId: "short" }),
      payload({ eventId: sourceEventId }),
      payload({ updates: {} }),
      payload({ kind: null }),
    ])
      expect(() => validateKnightFollowupV1(bad)).toThrow();
    const missing = payload();
    delete (missing as Dict).kind;
    expect(() => validateKnightFollowupV1(missing)).toThrow();
  });
  it("uses the system total and active dice, including bonuses outside Roll.total", () => {
    expect(
      buildKnightFollowupResult(
        { rolls: [roll], content: '<h4 class="dice-total">14</h4>' },
        "damage",
        "message000000001",
      ),
    ).toEqual({
      messageId: "message000000001",
      alreadyRolled: false,
      formula: "2d6+7",
      total: 14,
      dice: [{ faces: 6, results: [2, 5] }],
      kind: "damage",
    });
    for (const content of [
      "",
      '<h4 class="dice-total">14.5</h4>',
      '<h4 class="dice-total">-1</h4>',
    ])
      expect(() =>
        buildKnightFollowupResult(
          { rolls: [roll], content },
          "damage",
          "message000000001",
        ),
      ).toThrow();
  });
  it("runs Knight's damage with the frozen flags and preserves source visibility", async () => {
    const before = JSON.stringify(source);
    const result = (await knightFollowupV1(payload(), {} as never)) as Dict;
    expect(calls).toHaveLength(1);
    expect(calls[0].data.flags.style).toBe("standard");
    expect(calls[0].data.targets[0].btn).toEqual([{ classes: ["damage"] }]);
    expect(JSON.stringify(source)).toBe(before);
    const card = world.messages.contents[1];
    expect(card.author).toBe(source._source.author);
    expect(card.whisper).toEqual(source._source.whisper);
    expect(card.blind).toBe(true);
    expect(card.flags[MODULE_ID]).toMatchObject({
      lane: "knight.followup",
      followupOf: sourceEventId,
      result,
    });
    expect(card.id).toBe(result.messageId);
  });
  it("replays retries and another request for the same kind without a second roll", async () => {
    const result = (await knightFollowupV1(payload(), {} as never)) as Dict;
    expect(await knightFollowupV1(payload(), {} as never)).toEqual({
      ...result,
      alreadyRolled: true,
    });
    expect(
      await knightFollowupV1(
        payload({ eventId: "11111111-1111-4111-8111-111111111111" }),
        {} as never,
      ),
    ).toEqual({ ...result, alreadyRolled: true });
    expect(calls).toHaveLength(1);
    await knightFollowupV1(
      payload({
        eventId: "22222222-2222-4222-8222-222222222222",
        kind: "violence",
      }),
      {} as never,
    );
    expect(calls[1].kind).toBe("violence");
    expect(calls[1].data.targets[0].btn).toHaveLength(2);
  });
  it("rejects another actor, an unstamped source, and a miss before rolling", async () => {
    await expect(
      knightFollowupV1(payload({ actorId: "otherActor000001" }), {} as never),
    ).rejects.toMatchObject({ code: "source_not_found" });
    source.flags[MODULE_ID].lane = "knight.test";
    await expect(
      knightFollowupV1(payload(), {} as never),
    ).rejects.toMatchObject({ code: "source_not_found" });
    source.flags[MODULE_ID].lane = "knight.attack";
    source.flags.knight.content[0].targets[0].hit = false;
    await expect(
      knightFollowupV1(payload(), {} as never),
    ).rejects.toMatchObject({ code: "followup_refused" });
    expect(calls).toHaveLength(0);
  });
  it("reuses damage already rolled with the Foundry card's button", async () => {
    world.messages.contents.push({
      id: "manual0000000001",
      speaker: { actor: actorId },
      rolls: [roll],
      content: '<h4 class="dice-total">14</h4>',
      flags: {
        [MODULE_ID]: {
          followUp: { attackEventId: sourceEventId, kind: "damage" },
        },
      },
    });
    await expect(
      knightFollowupV1(payload(), {} as never),
    ).resolves.toMatchObject({
      messageId: "manual0000000001",
      total: 14,
      alreadyRolled: true,
    });
    expect(calls).toHaveLength(0);
  });
  it("accepts an unknown opposition and retains burst information", async () => {
    source.flags.knight.content[0].targets = [];
    source.flags.knight.weapon.effets.raw = ["tirenrafale"];
    await knightFollowupV1(payload(), {} as never);
    expect(calls[0].data.content).toEqual({ tirenrafale: true });
  });
  it("recovers a card even when Knight throws after posting", async () => {
    throwsAfterRoll = true;
    await expect(
      knightFollowupV1(payload(), {} as never),
    ).resolves.toMatchObject({ total: 14 });
  });
  it("holds a late card without rolling a retry twice", async () => {
    vi.useFakeTimers();
    delay = 9000;
    const first = expect(
      knightFollowupV1(payload(), {} as never),
    ).rejects.toMatchObject({ code: "followup_outcome_unknown" });
    await vi.advanceTimersByTimeAsync(8001);
    await first;
    const retry = knightFollowupV1(payload(), {} as never);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(retry).resolves.toMatchObject({
      total: 14,
      alreadyRolled: true,
    });
    expect(calls).toHaveLength(1);
  });
  it("is a signed-only mutation only when the Knight API exists", () => {
    expect(supportsKnightFollowupV1Runtime()).toBe(true);
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.mutations()).toContain("knight.followup.v1");
    expect(registry.isSignedOnly("knight.followup.v1")).toBe(true);
    world.knight.RollKnight = class {};
    expect(supportsKnightFollowupV1Runtime()).toBe(false);
  });
  it("refuses a non-GM responder", async () => {
    world.user.isGM = false;
    await expect(
      knightFollowupV1(payload(), {} as never),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});
