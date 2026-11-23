import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectFormula,
  followupResult,
  pf2eFollowupV1,
  validatePf2eFollowupV1,
} from "../src/procedures/pf2eFollowup.js";
import { pf2eRerollV1 } from "../src/procedures/pf2eReroll.js";
import { MODULE_ID, SETTING_AGENT_USER } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";

type Dict = Record<string, any>;

// The reply shape the backend and the apps read (a critical Strike); shared
// byte for byte with them.
const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/pf2e-followup-v1-result.json", import.meta.url),
    "utf8",
  ),
);

// SYNTHETIC, shape-only: pf2e 8.7.0's damage rolls as seen on a live Foundry
// 14 world. `message._strike.damage` / `.critical({checkContext, event})` and
// `message.item.rollDamage(event)` create ONE message through `ChatMessage`
// (so `preCreateChatMessage` runs), authored by the current user, its
// `flags.pf2e.context.type` "damage-roll", its first roll a `DamageRoll`.
const EVENT = "0b6e3c1a-9f3d-4f2a-8c6b-1d2e3f4a5b6c";
const SOURCE_EVENT = "6f1c2a7e-4b1d-4c8e-9a51-2f0d7c3b9e10";
const PC = "pf2ePC0000000001";
const OTHER = "pf2ePC0000000002";
const GM = "gmUser0000000001";
const PLAYER = "player0000000001";
const COMPANION = "companion0000001";
const POTION_UUID = `Actor.${PC}.Item.potion0000000001`;
const POTION_SOURCE = "Compendium.pf2e.equipment-srd.Item.potion";

let world: Dict;
let hooks: Map<number, (...a: any[]) => unknown>;
let nextHook: number;
let nextId: number;
/** What pf2e's damage call does: post its card, return a string, hang… */
let damageMode: "post" | "string" | "throw" | "hang";
/** The roll pf2e's damage card carries. */
let damageRoll: Dict;
/** Messages someone else creates just before pf2e's damage card. */
let alsoCreate: Dict[];
let damageCalls: { name: string; params: unknown }[];

function fire(doc: Dict, data: Dict, options: Dict): boolean {
  for (const fn of [...hooks.values()])
    if (fn(doc, data, options, GM) === false) return false;
  return true;
}

/** `ChatMessage.implementation.create` as Foundry 14 runs it: a pre-create
 * hook may veto it, and the server keeps `_id` only under `keepId`. */
async function create(data: Dict, options: Dict = {}) {
  const doc: Dict = {
    ...structuredClone(data),
    flags: structuredClone(data.flags ?? {}),
    updateSource(changes: Dict) {
      for (const [k, v] of Object.entries(changes)) {
        if (k.startsWith("flags.")) doc.flags[k.slice(6)] = v;
        else doc[k] = v;
      }
    },
  };
  if (!fire(doc, data, options)) return undefined;
  doc.id =
    options.keepId && doc._id
      ? doc._id
      : `made${String(++nextId).padStart(12, "0")}`;
  doc._source = { author: doc.author, whisper: doc.whisper, blind: doc.blind };
  world.messages.contents.push(doc);
  return doc;
}

/** pf2e's damage call: posts its own card as the GM, in the GM's mode. */
function pf2eDamage(name: string) {
  return vi.fn(async (params: unknown) => {
    damageCalls.push({ name, params });
    if (damageMode === "throw") throw new Error("pf2e broke");
    if (damageMode === "hang") return new Promise(() => {});
    if (damageMode === "string") return "no damage";
    for (const other of alsoCreate) await create(other);
    await create({
      author: GM,
      whisper: [],
      blind: false,
      speaker: { actor: PC, alias: "Ezren" },
      flavor: name,
      rolls: [structuredClone(damageRoll)],
      flags: { pf2e: { context: { type: "damage-roll" } } },
    });
    return damageRoll;
  });
}

function spell(over: Dict = {}): Dict {
  return {
    type: "spell",
    system: { damage: { "0": { formula: "2d6", type: "mental" } } },
    rollDamage: pf2eDamage("spell"),
    ...over,
  };
}

function potion(over: Dict = {}): Dict {
  return {
    type: "consumable",
    name: "Healing Potion (Moderate)",
    uuid: POTION_UUID,
    _stats: { compendiumSource: POTION_SOURCE },
    system: {
      damage: { formula: "3d8+10", type: "vitality", kind: "healing" },
    },
    consume: vi.fn(),
    update: vi.fn(),
    ...over,
  };
}

/** A card this module stamped: the check lane's or the card lane's. */
function sourceCard(over: Dict = {}): Dict {
  const o = {
    lane: "pf2e.check",
    eventId: SOURCE_EVENT,
    actor: PC,
    author: PLAYER,
    whisper: [] as string[],
    blind: false,
    strike: true,
    origin: undefined as Dict | undefined,
    item: null as Dict | null,
    effect: undefined as Dict | undefined,
    ...over,
  };
  const context = { type: "attack-roll", outcome: "success" };
  return {
    id: "srcMessage000001",
    _source: { author: o.author, whisper: o.whisper, blind: o.blind },
    author: { id: o.author },
    whisper: o.whisper,
    blind: o.blind,
    speaker: { actor: o.actor, alias: "Ezren" },
    _strike: o.strike
      ? { damage: pf2eDamage("damage"), critical: pf2eDamage("critical") }
      : null,
    item: o.item,
    flags: {
      pf2e: { context, ...(o.origin ? { origin: o.origin } : {}) },
      [MODULE_ID]: {
        eventId: o.eventId,
        origin: "player",
        lane: o.lane,
        result: { messageId: "srcMessage000001" },
        ...(o.effect ? { effect: o.effect } : {}),
      },
    },
  };
}

const spellAttack = (over: Dict = {}) =>
  sourceCard({
    strike: false,
    origin: { type: "spell" },
    item: spell(),
    ...over,
  });
const spellCard = (over: Dict = {}) =>
  sourceCard({ lane: "pf2e.card", strike: false, item: spell(), ...over });
const potionCard = (over: Dict = {}) =>
  sourceCard({ lane: "pf2e.card", strike: false, item: potion(), ...over });

const EFFECT = {
  name: "Healing Potion (Moderate)",
  formula: "3d8+10",
  type: "vitality",
  kind: "healing",
  sourceId: POTION_SOURCE,
  uuid: POTION_UUID,
};

class DamageRoll {
  static made: string[] = [];
  formula: string;
  total?: number;
  dice: Dict[] = [];
  kinds = new Set<string>();
  constructor(formula: string) {
    this.formula = formula;
    DamageRoll.made.push(formula);
  }
  async evaluate() {
    this.total = 19;
    this.dice = [
      {
        faces: 8,
        results: [{ result: 1, active: true }, { result: 2 }, { result: 6 }],
      },
    ];
    this.kinds = new Set([
      this.formula.includes("healing") ? "healing" : "damage",
    ]);
    return this;
  }
}

function stubWorld(cards: Dict[] = [sourceCard()]) {
  hooks = new Map();
  nextHook = 0;
  nextId = 0;
  alsoCreate = [];
  damageCalls = [];
  DamageRoll.made = [];
  const users = [
    { id: GM, isGM: true, active: true, settings: {} as Dict },
    { id: PLAYER, isGM: false, active: true, character: { id: PC } },
    { id: COMPANION, isGM: false, active: true },
  ];
  world = {
    system: { id: "pf2e", version: "8.7.0" },
    release: { generation: 14 },
    user: users[0],
    users: {
      contents: users,
      get: (id: string) => users.find((u) => u.id === id),
    },
    actors: { get: () => undefined },
    messages: { contents: cards },
    pf2e: { Check: { rerollFromMessage: vi.fn() } },
    i18n: {
      localize: (k: string) => k,
      format: (k: string, d: Dict) => `${k}:${d.name}`,
    },
    settings: {
      get: (_scope: string, key: string) =>
        key === SETTING_AGENT_USER ? COMPANION : "",
    },
  };
  vi.stubGlobal("game", world);
  vi.stubGlobal("Hooks", {
    on: (name: string, fn: (...a: any[]) => unknown) => {
      expect(name).toBe("preCreateChatMessage");
      hooks.set(++nextHook, fn);
      return nextHook;
    },
    off: (_name: string, id: number) => hooks.delete(id),
  });
  vi.stubGlobal("ChatMessage", { implementation: { create } });
  vi.stubGlobal("CONFIG", { Dice: { rolls: [class Roll {}, DamageRoll] } });
  vi.stubGlobal(
    "PointerEvent",
    class {
      ctrlKey = false;
      metaKey = false;
      shiftKey = false;
      constructor(
        readonly type: string,
        init: Dict = {},
      ) {
        Object.assign(this, init);
      }
    },
  );
}

function payload(over: Dict = {}): Dict {
  return {
    eventId: EVENT,
    origin: "player",
    actorId: PC,
    kind: "damage",
    sourceEventId: SOURCE_EVENT,
    ...over,
  };
}

const call = (p: Dict = payload()) =>
  Promise.resolve().then(() => pf2eFollowupV1(p, {} as never)) as Promise<Dict>;

async function rejects(pending: unknown, code: string) {
  const promise = Promise.resolve(pending);
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code });
}

const followupCard = (eventId = EVENT) =>
  world.messages.contents.find(
    (m: Dict) =>
      m.flags?.[MODULE_ID]?.eventId === eventId &&
      m.flags[MODULE_ID].lane === "pf2e.followup",
  );

const source = () => world.messages.contents[0];

beforeEach(() => {
  damageMode = "post";
  damageRoll = {
    formula: "2 * (1d4 + 6) bludgeoning",
    total: 16,
    dice: [{ faces: 4, results: [{ result: 2, active: true }] }],
    kinds: new Set(["damage"]),
  };
  stubWorld();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pf2e.followup.v1 payload", () => {
  it("accepts the documented payload", () => {
    expect(validatePf2eFollowupV1(payload())).toEqual(payload());
    const other = payload({ origin: "app", kind: "critical" });
    expect(validatePf2eFollowupV1(other)).toEqual(other);
  });

  it.each([
    ["an unknown key", { visibility: "gm" }],
    ["a missing eventId", { eventId: undefined }],
    ["a missing origin", { origin: undefined }],
    ["a missing actorId", { actorId: undefined }],
    ["a missing kind", { kind: undefined }],
    ["a missing sourceEventId", { sourceEventId: undefined }],
    ["an uppercase eventId", { eventId: EVENT.toUpperCase() }],
    ["a non-uuid sourceEventId", { sourceEventId: "nope" }],
    ["a short actorId", { actorId: "abc" }],
    ["an unknown origin", { origin: "gm" }],
    ["an unknown kind", { kind: "healing" }],
    ["the same event twice", { sourceEventId: EVENT }],
  ])("refuses %s", (_name, over) => {
    const p = payload(over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete p[k];
    expect(() => validatePf2eFollowupV1(p)).toThrowError(
      expect.objectContaining({ code: "invalid_args" }),
    );
  });

  it("refuses a non-object payload", () => {
    expect(() => validatePf2eFollowupV1(null)).toThrow(RpcError);
  });
});

describe("pf2e.followup.v1 from a Strike", () => {
  it("has pf2e roll the Strike's damage, stamped at birth with the source's author and visibility", async () => {
    const reply = await call();
    const strike = source()._strike;
    expect(strike.damage).toHaveBeenCalledTimes(1);
    expect(strike.critical).not.toHaveBeenCalled();
    expect(damageCalls[0].params).toEqual({
      checkContext: source().flags.pf2e.context,
      event: expect.any(PointerEvent),
    });
    expect(reply).toEqual({
      messageId: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
      alreadyRolled: false,
      formula: "2 * (1d4 + 6) bludgeoning",
      total: 16,
      dice: [{ faces: 4, results: [2] }],
      kind: "damage",
      critical: false,
      messageMode: "public",
    });
    const card = followupCard();
    expect(card.id).toBe(reply.messageId);
    expect(card).toMatchObject({ author: PLAYER, whisper: [], blind: false });
    expect(card.flags[MODULE_ID]).toEqual({
      eventId: EVENT,
      origin: "player",
      lane: "pf2e.followup",
      followupOf: SOURCE_EVENT,
      result: reply,
    });
    expect(card.flags.pf2e.context.type).toBe("damage-roll");
    expect(hooks.size).toBe(0);
  });

  it("reads the shared reply fixture's shape from a critical Strike", async () => {
    damageRoll = {
      formula: "2 * (2d8 + 7) tranchant + 1d10 perforant",
      total: 37,
      dice: [
        { faces: 8, results: [{ result: 3, active: true }, { result: 5 }] },
        { faces: 10, results: [{ result: 7 }] },
      ],
      kinds: new Set(["damage"]),
    };
    const reply = await call(payload({ kind: "critical" }));
    expect(followupCard().id).toBe(reply.messageId);
    expect(Object.keys(reply)).toEqual(Object.keys(FIXTURE));
    expect({ ...reply, messageId: FIXTURE.messageId }).toEqual(FIXTURE);
  });

  it("rolls the critical damage on kind critical", async () => {
    const reply = await call(payload({ kind: "critical" }));
    expect(source()._strike.critical).toHaveBeenCalledTimes(1);
    expect(source()._strike.damage).not.toHaveBeenCalled();
    expect(reply.critical).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])(
    "presses shift when the GM's damage dialogs are %s, never ctrl or meta",
    async (setting, shift) => {
      world.user.settings = {
        showDamageDialogs: setting,
        showCheckDialogs: !shift,
      };
      await call();
      expect(damageCalls[0].params).toMatchObject({
        event: {
          type: "click",
          shiftKey: shift,
          ctrlKey: false,
          metaKey: false,
        },
      });
    },
  );

  it("keeps a Gamemaster-only card the Gamemaster's, and a blind one blind", async () => {
    stubWorld([sourceCard({ author: GM, whisper: [GM, COMPANION] })]);
    expect((await call()).messageMode).toBe("gm");
    expect(followupCard()).toMatchObject({
      author: GM,
      whisper: [GM, COMPANION],
      blind: false,
    });
    stubWorld([sourceCard({ whisper: [GM, COMPANION], blind: true })]);
    expect((await call()).messageMode).toBe("blind");
    expect(followupCard()).toMatchObject({ author: PLAYER, blind: true });
  });

  it("follows up a reroll's card by the reroll's eventId", async () => {
    const reroll = "22222222-3333-4444-8555-666666666666";
    stubWorld([sourceCard({ eventId: reroll })]);
    await rejects(call(), "source_not_found");
    expect((await call(payload({ sourceEventId: reroll }))).total).toBe(16);
  });

  it("allows several follow-ups of one source, each its own card", async () => {
    const second = "33333333-4444-4555-8666-777777777777";
    const a = await call();
    const b = await call(payload({ eventId: second }));
    expect(b.messageId).not.toBe(a.messageId);
    expect(followupCard(second).flags[MODULE_ID].followupOf).toBe(SOURCE_EVENT);
    expect(source()._strike.damage).toHaveBeenCalledTimes(2);
  });

  it("leaves a message created meanwhile untouched", async () => {
    alsoCreate = [
      { author: GM, whisper: [], speaker: { actor: PC }, flags: { pf2e: {} } },
      {
        author: GM,
        whisper: [GM],
        speaker: { actor: OTHER },
        flags: { pf2e: { context: { type: "damage-roll" } } },
      },
    ];
    await call();
    const [, a, b] = world.messages.contents;
    for (const m of [a, b]) {
      expect(m.flags[MODULE_ID]).toBeUndefined();
      expect(m.author).toBe(GM);
      expect(m.id).toMatch(/^made/);
    }
    expect(followupCard()).toBeDefined();
  });

  it("answers a replay from the stamped card and joins one in flight, rolling once", async () => {
    const [a, b] = await Promise.all([call(), call()]);
    expect(b).toEqual({ ...a, alreadyRolled: true });
    expect(await call()).toEqual({ ...a, alreadyRolled: true });
    expect(source()._strike.damage).toHaveBeenCalledTimes(1);
  });
});

describe("pf2e.followup.v1 from a spell", () => {
  it("rolls a spell attack's damage through its spell, never critical", async () => {
    stubWorld([spellAttack()]);
    const reply = await call();
    expect(source().item.rollDamage).toHaveBeenCalledTimes(1);
    expect(damageCalls[0].params).toBeInstanceOf(PointerEvent);
    expect(reply.critical).toBe(false);
    stubWorld([spellAttack()]);
    await rejects(call(payload({ kind: "critical" })), "followup_refused");
    expect(source().item.rollDamage).not.toHaveBeenCalled();
    expect(hooks.size).toBe(0);
  });

  it("rolls a spell card's damage, never critical", async () => {
    stubWorld([spellCard()]);
    expect((await call()).formula).toBe("2 * (1d4 + 6) bludgeoning");
    expect(source().item.rollDamage).toHaveBeenCalledTimes(1);
    stubWorld([spellCard()]);
    await rejects(call(payload({ kind: "critical" })), "followup_refused");
    expect(source().item.rollDamage).not.toHaveBeenCalled();
  });

  it("refuses a spell without damage, or one no longer on the Actor", async () => {
    for (const card of [
      spellCard({ item: spell({ system: { damage: {} } }) }),
      spellCard({ item: spell({ system: {} }) }),
      spellAttack({ item: null }),
      spellAttack({ item: spell({ rollDamage: undefined }) }),
    ]) {
      stubWorld([card]);
      await rejects(call(), "followup_refused");
      expect(damageCalls).toEqual([]);
    }
  });

  it("reads a healing spell as healing", async () => {
    stubWorld([spellCard()]);
    damageRoll.kinds = new Set(["healing"]);
    expect((await call()).kind).toBe("healing");
  });
});

describe("pf2e.followup.v1 from a consumable", () => {
  it("posts pf2e's use card from the card's stamp, the item gone, spending nothing", async () => {
    stubWorld([
      potionCard({
        item: null,
        effect: EFFECT,
        author: GM,
        whisper: [GM, COMPANION],
      }),
    ]);
    const reply = await call();
    expect(DamageRoll.made).toEqual(["(3d8+10)[vitality,healing]"]);
    expect(reply).toEqual({
      messageId: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
      alreadyRolled: false,
      formula: "(3d8+10)[vitality,healing]",
      total: 19,
      dice: [{ faces: 8, results: [1, 2, 6] }],
      kind: "healing",
      critical: false,
      messageMode: "gm",
    });
    const card = followupCard();
    expect(card).toMatchObject({
      id: reply.messageId,
      author: GM,
      whisper: [GM, COMPANION],
      blind: false,
      speaker: { actor: PC, alias: "Ezren" },
      flavor: "PF2E.ConsumableMessage.UseSingle:Healing Potion (Moderate)",
    });
    expect(card.rolls).toHaveLength(1);
    expect(card.flags.pf2e).toEqual({
      origin: {
        sourceId: POTION_SOURCE,
        uuid: POTION_UUID,
        type: "consumable",
      },
    });
    expect(card.flags[MODULE_ID]).toEqual({
      eventId: EVENT,
      origin: "player",
      lane: "pf2e.followup",
      followupOf: SOURCE_EVENT,
      result: reply,
    });
    expect(hooks.size).toBe(0);
  });

  it("prefers the card's stamp to the live item, and never consumes it", async () => {
    stubWorld([
      potionCard({ effect: { ...EFFECT, formula: "1d8" }, item: potion() }),
    ]);
    await call();
    expect(DamageRoll.made).toEqual(["(1d8)[vitality,healing]"]);
    expect(source().item.consume).not.toHaveBeenCalled();
    expect(source().item.update).not.toHaveBeenCalled();
  });

  it("falls back to the live item without a stamp, never consuming it", async () => {
    stubWorld([
      potionCard({ item: potion({ _stats: undefined, sourceId: "s" }) }),
    ]);
    await call();
    expect(DamageRoll.made).toEqual(["(3d8+10)[vitality,healing]"]);
    expect(followupCard().flags.pf2e.origin.sourceId).toBe("s");
    expect(source().item.consume).not.toHaveBeenCalled();
    expect(source().item.update).not.toHaveBeenCalled();
  });

  it("builds pf2e's formula of a damaging or untyped effect", () => {
    expect(effectFormula({ ...EFFECT, type: "fire", kind: "damage" })).toBe(
      "(3d8+10)[fire]",
    );
    expect(effectFormula({ ...EFFECT, type: "", kind: "damage" })).toBe(
      "(3d8+10)",
    );
  });

  it("refuses without an effect, critical, a malformed stamp, or no card created", async () => {
    for (const card of [
      potionCard({ item: null }),
      potionCard({ item: null, effect: { formula: 3 } }),
      potionCard({ item: potion({ system: { damage: { formula: "" } } }) }),
      potionCard({ item: { type: "equipment", system: {} } }),
    ]) {
      stubWorld([card]);
      await rejects(call(), "followup_refused");
      expect(DamageRoll.made).toEqual([]);
    }
    stubWorld([potionCard({ effect: EFFECT })]);
    await rejects(call(payload({ kind: "critical" })), "followup_refused");
    stubWorld([potionCard({ effect: EFFECT })]);
    vi.stubGlobal("ChatMessage", {
      implementation: { create: async () => undefined },
    });
    await rejects(call(), "followup_refused");
  });

  it("refuses without pf2e's DamageRoll", async () => {
    stubWorld([potionCard({ effect: EFFECT })]);
    vi.stubGlobal("CONFIG", { Dice: { rolls: [] } });
    await rejects(call(), "unsupported_runtime");
    vi.stubGlobal("CONFIG", undefined);
    await rejects(call(), "unsupported_runtime");
  });
});

describe("pf2e.followup.v1 refusals", () => {
  it("refuses an unknown source, another actor's, or one of another lane", async () => {
    await rejects(
      call(payload({ sourceEventId: "11111111-2222-4333-8444-555555555555" })),
      "source_not_found",
    );
    await rejects(call(payload({ actorId: OTHER })), "source_not_found");
    stubWorld([sourceCard({ lane: "pf2e.followup" })]);
    await rejects(call(), "source_not_found");
    expect(damageCalls).toEqual([]);
  });

  it("refuses a check that is neither a Strike nor a spell attack", async () => {
    for (const kind of ["damage", "critical"]) {
      stubWorld([sourceCard({ strike: false })]);
      await rejects(call(payload({ kind })), "followup_refused");
      stubWorld([sourceCard({ strike: false, origin: { type: "feat" } })]);
      await rejects(call(payload({ kind })), "followup_refused");
    }
    expect(hooks.size).toBe(0);
  });

  it("refuses a Strike pf2e cannot roll damage for", async () => {
    const card = sourceCard();
    card._strike = { damage: undefined };
    stubWorld([card]);
    await rejects(call(), "followup_refused");
  });

  it("refuses when pf2e rolls nothing, and disarms the hook", async () => {
    damageMode = "string";
    await rejects(call(), "followup_refused");
    expect(hooks.size).toBe(0);
    expect(world.messages.contents).toHaveLength(1);
  });

  it("vetoes and refuses a card whose roll it cannot read", async () => {
    for (const roll of [
      { ...damageRoll, formula: "" },
      { ...damageRoll, total: 3.5 },
      { ...damageRoll, total: -1 },
      { ...damageRoll, dice: [{ faces: 1, results: [{ result: 1 }] }] },
    ]) {
      stubWorld();
      damageRoll = roll;
      await rejects(call(), "followup_refused");
      expect(world.messages.contents).toHaveLength(1);
      expect(hooks.size).toBe(0);
    }
  });

  it("fails when pf2e throws, and disarms the hook", async () => {
    damageMode = "throw";
    await expect(call()).rejects.toThrow("pf2e broke");
    expect(hooks.size).toBe(0);
  });

  it("disarms the hook when pf2e never returns", async () => {
    vi.useFakeTimers();
    damageMode = "hang";
    void call(payload({ eventId: "99999999-8888-4777-8666-555555555555" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hooks.size).toBe(0);
    await vi.runAllTimersAsync();
  });

  it("refuses without Foundry Hooks or below the check lane's floor", async () => {
    vi.stubGlobal("Hooks", undefined);
    await rejects(call(), "unsupported_runtime");
    world.pf2e = {};
    await rejects(call(), "unsupported_runtime");
  });

  it("waits for a reroll in flight before it rolls", async () => {
    stubWorld([
      sourceCard(),
      sourceCard({ eventId: "44444444-5555-4666-8777-888888888888" }),
    ]);
    let release!: () => void;
    world.pf2e.Check.rerollFromMessage = vi.fn(
      () => new Promise<void>((r) => (release = r)),
    );
    const reroll = Promise.resolve().then(() =>
      pf2eRerollV1(
        {
          eventId: "55555555-6666-4777-8888-999999999999",
          origin: "player",
          actorId: PC,
          sourceEventId: "44444444-5555-4666-8777-888888888888",
        },
        {} as never,
      ),
    );
    const followup = call();
    await new Promise((r) => setTimeout(r, 0));
    expect(world.pf2e.Check.rerollFromMessage).toHaveBeenCalledTimes(1);
    expect(damageCalls).toEqual([]);
    release();
    await rejects(reroll, "reroll_refused");
    expect((await followup).total).toBe(16);
  });
});

describe("pf2e.followup.v1 result", () => {
  it("keeps active results only, every die term in order, and reads mixed kinds as damage", () => {
    expect(
      followupResult(
        {
          formula: "2d8 + 1d10",
          total: 12,
          dice: [
            {
              faces: 8,
              results: [
                { result: 3, active: true },
                { result: 1, active: false },
                { result: 5, discarded: true },
                { result: 5 },
              ],
            },
            { faces: 10, results: [{ result: 4 }] },
          ],
          kinds: new Set(["damage", "healing"]),
        },
        "m",
        false,
        "public",
      ),
    ).toMatchObject({
      dice: [
        { faces: 8, results: [3, 5] },
        { faces: 10, results: [4] },
      ],
      kind: "damage",
    });
    expect(
      followupResult({ formula: "5", total: 5 }, "m", false, "public"),
    ).toMatchObject({ dice: [], kind: "damage", total: 5 });
    expect(
      followupResult({ formula: "x".repeat(300), total: 1 }, "m", false, "gm")
        .formula,
    ).toHaveLength(200);
  });

  it.each([
    ["no roll", null],
    ["51 die terms", { dice: Array(51).fill({ faces: 6, results: [] }) }],
    [
      "101 results",
      { dice: [{ faces: 6, results: Array(101).fill({ result: 1 }) }] },
    ],
    ["a d101", { dice: [{ faces: 101, results: [{ result: 1 }] }] }],
    [
      "a result over its faces",
      { dice: [{ faces: 6, results: [{ result: 7 }] }] },
    ],
  ])("refuses %s", (_name, over) => {
    const roll = over && { formula: "1d6", total: 3, ...over };
    expect(() => followupResult(roll, "m", false, "public")).toThrowError(
      expect.objectContaining({ code: "followup_refused" }),
    );
  });
});

describe("pf2e.followup.v1 capability", () => {
  it("is a signed-only mutation with game.pf2e.Check, unsupported without it", () => {
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).toContain("pf2e.followup.v1");
    expect(registry.mutations()).toContain("pf2e.followup.v1");
    expect(registry.isSignedOnly("pf2e.followup.v1")).toBe(true);

    world.pf2e = {};
    const without = new ProcedureRegistry();
    registerBuiltinProcedures(without);
    expect(without.capabilities()).not.toContain("pf2e.followup.v1");
    expect(without.unsupported()["pf2e.followup.v1"]).toBe(
      "pf2e 8.7.0 on Foundry 14; requires pf2e 8.5.1 or a later 8.x on Foundry 14 with game.pf2e.Check",
    );
  });
});
