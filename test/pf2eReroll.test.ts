import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pf2eRerollV1,
  unadjustedDegree,
  validatePf2eRerollV1,
} from "../src/procedures/pf2eReroll.js";
import { MODULE_ID, SETTING_AGENT_USER } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";

type Dict = Record<string, any>;

// SYNTHETIC, shape-only: pf2e 8.7.0's `Check.rerollFromMessage` as read in its
// sources and seen on a live Foundry 14 world. It deletes the source card and
// creates ONE new card through `ChatMessage` (so `preCreateChatMessage` runs),
// authored by the current user, whispered by pf2e's own message mode, with
// `context.isReroll` true, the outcome recomputed against the source's DC and
// the source's (stale) `unadjustedOutcome`.
const EVENT = "0b6e3c1a-9f3d-4f2a-8c6b-1d2e3f4a5b6c";
const SOURCE_EVENT = "6f1c2a7e-4b1d-4c8e-9a51-2f0d7c3b9e10";
const PC = "pf2ePC0000000001";
const OTHER = "pf2ePC0000000002";
const GM = "gmUser0000000001";
const PLAYER = "player0000000001";
const COMPANION = "companion0000001";
const SOURCE_ID = "srcMessage000001";

interface NewRoll {
  face: number;
  total: number;
  outcome: string | null;
}

let world: Dict;
let hooks: Map<number, (...a: any[]) => void>;
let nextHook: number;
let nextId: number;
let newRoll: NewRoll;
let rerollMode: "reroll" | "early" | "throw" | "hang";
let rerollCalls: { message: Dict; options: Dict }[];
/** Messages pf2e or someone else creates just before the replacement. */
let alsoCreate: Dict[];

function fire(doc: Dict, data: Dict, options: Dict) {
  for (const fn of [...hooks.values()]) fn(doc, data, options, GM);
}

/** `ChatMessage.implementation.create` as Foundry 14 runs it: the
 * pre-create hooks see the pending document and the operation options, and
 * the server keeps the document's `_id` only under `keepId`. */
async function create(data: Dict, options: Dict = {}) {
  const doc: Dict = {
    ...structuredClone(data),
    _id: null,
    updateSource(changes: Dict) {
      for (const [k, v] of Object.entries(changes)) {
        if (k.startsWith("flags.")) doc.flags[k.slice(6)] = v;
        else doc[k] = v;
      }
    },
  };
  fire(doc, data, options);
  doc.id =
    options.keepId && doc._id
      ? doc._id
      : `made${String(++nextId).padStart(12, "0")}`;
  doc._source = { author: doc.author, whisper: doc.whisper, blind: doc.blind };
  world.messages.contents.push(doc);
  return doc;
}

function sourceCard(over: Dict = {}): Dict {
  const o = {
    eventId: SOURCE_EVENT,
    actor: PC,
    author: PLAYER,
    whisper: [] as string[],
    blind: false,
    degreeSource: "dc" as string | null,
    messageMode: "public",
    isReroll: false,
    dc: { value: 18 } as Dict | null,
    options: ["check:statistic:perception"],
    ...over,
  };
  return {
    id: SOURCE_ID,
    _source: { author: o.author, whisper: o.whisper, blind: o.blind },
    author: { id: o.author },
    whisper: o.whisper,
    blind: o.blind,
    speaker: { actor: o.actor, alias: "Ezren" },
    rolls: [{ total: 16, dice: [{ faces: 20, results: [{ result: 9 }] }] }],
    flags: {
      core: {},
      pf2e: {
        context: {
          type: "perception-check",
          isReroll: o.isReroll,
          dc: o.dc,
          outcome: "failure",
          unadjustedOutcome: "failure",
          messageMode: o.messageMode,
          options: o.options,
        },
      },
      [MODULE_ID]: {
        eventId: o.eventId,
        origin: "player",
        lane: "pf2e.check",
        result: {
          messageId: SOURCE_ID,
          degreeSource: o.degreeSource,
          messageMode: o.messageMode,
        },
      },
    },
  };
}

async function rerollFromMessage(message: Dict, options: Dict) {
  rerollCalls.push({ message, options });
  if (rerollMode === "early") return;
  if (rerollMode === "throw") throw new Error("pf2e broke");
  if (rerollMode === "hang") return new Promise<void>(() => {});
  const context = message.flags.pf2e.context;
  // `message.delete({render: false})`, then `toMessage`.
  world.messages.contents = world.messages.contents.filter(
    (m: Dict) => m !== message,
  );
  for (const other of alsoCreate) await create(other);
  const mode = context.messageMode;
  await create(
    {
      author: GM,
      whisper: mode === "public" ? [] : [GM],
      blind: mode === "blind",
      speaker: message.speaker,
      content: "<div>old roll</div>",
      rolls: [
        {
          total: newRoll.total,
          dice: [
            {
              faces: 20,
              total: newRoll.face,
              results: [{ result: newRoll.face }],
            },
          ],
        },
      ],
      flags: {
        core: {},
        pf2e: {
          context: {
            ...structuredClone(context),
            isReroll: true,
            options: [...context.options, "check:reroll"],
            outcome: newRoll.outcome,
            // pf2e keeps the source roll's value here.
            unadjustedOutcome: context.unadjustedOutcome,
          },
        },
      },
    },
    { messageMode: mode },
  );
}

function stubWorld(over: Dict = {}, cards: Dict[] = [sourceCard()]) {
  hooks = new Map();
  nextHook = 0;
  nextId = 0;
  rerollCalls = [];
  alsoCreate = [];
  const users = [
    { id: GM, isGM: true, active: true },
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
    pf2e: { Check: { rerollFromMessage: vi.fn(rerollFromMessage) } },
    settings: {
      get: (scope: string, key: string) =>
        key === SETTING_AGENT_USER
          ? COMPANION
          : scope === "pf2e" && key === "metagame_showResults"
            ? true
            : "",
    },
    ...over,
  };
  vi.stubGlobal("game", world);
  vi.stubGlobal("Hooks", {
    on: (name: string, fn: (...a: any[]) => void) => {
      expect(name).toBe("preCreateChatMessage");
      hooks.set(++nextHook, fn);
      return nextHook;
    },
    off: (_name: string, id: number) => hooks.delete(id),
  });
  vi.stubGlobal("ChatMessage", { implementation: { create } });
}

function payload(over: Dict = {}): Dict {
  return {
    eventId: EVENT,
    origin: "player",
    actorId: PC,
    sourceEventId: SOURCE_EVENT,
    ...over,
  };
}

const call = (p: Dict = payload()) =>
  Promise.resolve().then(() => pf2eRerollV1(p, {} as never)) as Promise<Dict>;

async function rejects(pending: unknown, code: string) {
  const promise = Promise.resolve(pending);
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code });
}

const replacement = () =>
  world.messages.contents.find(
    (m: Dict) => m.flags?.[MODULE_ID]?.eventId === EVENT,
  );

beforeEach(() => {
  rerollMode = "reroll";
  newRoll = { face: 16, total: 25, outcome: "success" };
  stubWorld();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pf2e.reroll.v1 payload", () => {
  it("accepts the documented payload", () => {
    expect(validatePf2eRerollV1(payload())).toEqual(payload());
    expect(validatePf2eRerollV1(payload({ origin: "app" }))).toEqual(
      payload({ origin: "app" }),
    );
  });

  it.each([
    ["an unknown key", { visibility: "gm" }],
    ["a missing key", { sourceEventId: undefined }],
    ["an uppercase eventId", { eventId: EVENT.toUpperCase() }],
    ["a non-uuid sourceEventId", { sourceEventId: "nope" }],
    ["a short actorId", { actorId: "abc" }],
    ["an unknown origin", { origin: "gm" }],
    ["the same event twice", { sourceEventId: EVENT }],
  ])("refuses %s", (_name, over) => {
    const p = payload(over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete p[k];
    expect(() => validatePf2eRerollV1(p)).toThrowError(
      expect.objectContaining({ code: "invalid_args" }),
    );
  });
});

describe("pf2e.reroll.v1", () => {
  it("has pf2e reroll its own card, keeping the new result and spending nothing", async () => {
    const source = world.messages.contents[0];
    const reply = await call();
    expect(world.pf2e.Check.rerollFromMessage).toHaveBeenCalledTimes(1);
    expect(rerollCalls[0].message).toBe(source);
    expect(rerollCalls[0].options).toEqual({ keep: "new" });
    expect(rerollCalls[0].options).not.toHaveProperty("resource");
    expect(reply).toEqual({
      messageId: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
      alreadyRolled: false,
      faces: [16],
      kept: 16,
      modifier: 9,
      total: 25,
      degree: "success",
      unadjustedDegree: "success",
      degreeSource: "dc",
      resultsShown: true,
      messageMode: "public",
    });
    const card = replacement();
    expect(world.messages.contents).toEqual([card]);
    expect(card.id).toBe(reply.messageId);
    expect(card.flags[MODULE_ID]).toEqual({
      eventId: EVENT,
      origin: "player",
      lane: "pf2e.check",
      rerollOf: SOURCE_EVENT,
      result: reply,
    });
    expect(hooks.size).toBe(0);
  });

  it("answers a stale unadjustedOutcome with the new roll's own degree", async () => {
    // The source rolled 16 against 18 (failure); the reroll's 25 succeeds,
    // while pf2e still reads `unadjustedOutcome: failure`.
    const reply = await call();
    expect(replacement().flags.pf2e.context.unadjustedOutcome).toBe("failure");
    expect(reply.unadjustedDegree).toBe("success");
  });

  it("answers the unadjusted degree before a natural 20 or 1 when pf2e adjusted it", async () => {
    newRoll = { face: 20, total: 26, outcome: "criticalSuccess" };
    expect(await call()).toMatchObject({
      degree: "criticalSuccess",
      unadjustedDegree: "criticalSuccess",
    });
    expect(unadjustedDegree(26, 20, 18)).toBe("criticalSuccess");
    expect(unadjustedDegree(10, 1, 18)).toBe("criticalFailure");
    expect(unadjustedDegree(19, 1, 18)).toBe("failure");
    expect(unadjustedDegree(28, 19, 18)).toBe("criticalSuccess");
    expect(unadjustedDegree(8, 2, 18)).toBe("criticalFailure");
  });

  it("carries a target degree and reads the unadjusted degree from the target's DC", async () => {
    stubWorld({}, [
      sourceCard({ degreeSource: "target", dc: { slug: "ac", value: 20 } }),
    ]);
    newRoll = { face: 15, total: 24, outcome: "success" };
    expect(await call()).toMatchObject({
      degree: "success",
      unadjustedDegree: "success",
      degreeSource: "target",
    });
  });

  it("answers the degree as unadjusted when the context has no DC value", async () => {
    stubWorld({}, [sourceCard({ degreeSource: "target", dc: { slug: "ac" } })]);
    expect(await call()).toMatchObject({
      degree: "success",
      unadjustedDegree: "success",
      degreeSource: "target",
    });
  });

  it("answers no degree without a source degree, or without pf2e's outcome", async () => {
    stubWorld({}, [sourceCard({ degreeSource: null, dc: null })]);
    newRoll = { face: 16, total: 25, outcome: null };
    expect(await call()).toMatchObject({
      degree: null,
      unadjustedDegree: null,
      degreeSource: null,
    });
    stubWorld();
    newRoll = { face: 16, total: 25, outcome: null };
    expect(await call()).toMatchObject({
      degree: null,
      unadjustedDegree: null,
      degreeSource: null,
    });
  });

  it("keeps a public card the player's", async () => {
    await call();
    expect(replacement()).toMatchObject({
      author: PLAYER,
      whisper: [],
      blind: false,
    });
  });

  it("keeps a Gamemaster-only card the Gamemaster's, still reaching the service user", async () => {
    stubWorld({}, [
      sourceCard({ author: GM, whisper: [GM, COMPANION], messageMode: "gm" }),
    ]);
    const reply = await call();
    expect(replacement()).toMatchObject({
      author: GM,
      whisper: [GM, COMPANION],
      blind: false,
    });
    expect(reply.messageMode).toBe("gm");
  });

  it("keeps a blind card pf2e forced blind", async () => {
    stubWorld({}, [
      sourceCard({
        whisper: [GM, COMPANION],
        blind: true,
        messageMode: "blind",
        options: ["secret"],
      }),
    ]);
    const reply = await call();
    expect(replacement()).toMatchObject({
      author: PLAYER,
      whisper: [GM, COMPANION],
      blind: true,
    });
    expect(reply.messageMode).toBe("blind");
  });

  it("leaves a message created meanwhile untouched", async () => {
    alsoCreate = [
      {
        author: GM,
        whisper: [],
        speaker: { actor: PC },
        flags: { pf2e: { context: {} } },
      },
      {
        author: GM,
        whisper: [GM],
        speaker: { actor: OTHER },
        flags: { pf2e: { context: { isReroll: true } } },
      },
    ];
    await call();
    const [a, b] = world.messages.contents;
    for (const m of [a, b]) {
      expect(m.flags[MODULE_ID]).toBeUndefined();
      expect(m.author).toBe(GM);
      expect(m.id).toMatch(/^made/);
    }
    expect(b.whisper).toEqual([GM]);
    expect(replacement()).toBeDefined();
  });

  it("answers a replay from the stamped card without rerolling", async () => {
    const first = await call();
    const again = await call();
    expect(again).toEqual({ ...first, alreadyRolled: true });
    expect(world.pf2e.Check.rerollFromMessage).toHaveBeenCalledTimes(1);
  });

  it("joins a reroll still in flight", async () => {
    const [a, b] = await Promise.all([call(), call()]);
    expect(b).toEqual({ ...a, alreadyRolled: true });
    expect(world.pf2e.Check.rerollFromMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown source or another actor's", async () => {
    await rejects(
      call(payload({ sourceEventId: "11111111-2222-4333-8444-555555555555" })),
      "source_not_found",
    );
    await rejects(call(payload({ actorId: OTHER })), "source_not_found");
    stubWorld({}, [
      {
        ...sourceCard(),
        flags: {
          ...sourceCard().flags,
          [MODULE_ID]: { ...sourceCard().flags[MODULE_ID], lane: "pf2e.card" },
        },
      },
    ]);
    await rejects(call(), "source_not_found");
    expect(world.pf2e.Check.rerollFromMessage).not.toHaveBeenCalled();
  });

  it("refuses to reroll a reroll", async () => {
    stubWorld({}, [sourceCard({ isReroll: true })]);
    await rejects(call(), "reroll_refused");
    expect(world.pf2e.Check.rerollFromMessage).not.toHaveBeenCalled();
    expect(hooks.size).toBe(0);
  });

  it("refuses when pf2e changed nothing, and disarms the hook", async () => {
    rerollMode = "early";
    await rejects(call(), "reroll_refused");
    expect(hooks.size).toBe(0);
    expect(world.messages.contents).toHaveLength(1);
  });

  it("fails when pf2e throws, and disarms the hook", async () => {
    rerollMode = "throw";
    await expect(call()).rejects.toThrow("pf2e broke");
    expect(hooks.size).toBe(0);
  });

  it("disarms the hook when pf2e never returns", async () => {
    vi.useFakeTimers();
    rerollMode = "hang";
    // Its own eventId: a call that never settles stays joinable.
    void call(payload({ eventId: "99999999-8888-4777-8666-555555555555" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hooks.size).toBe(0);
    // The hung call holds the one-at-a-time queue only as long as the
    // backend waits.
    await vi.runAllTimersAsync();
  });

  it("fails when the source is gone but no stamped card appeared", async () => {
    world.pf2e.Check.rerollFromMessage = vi.fn(async (m: Dict) => {
      world.messages.contents = world.messages.contents.filter(
        (x: Dict) => x !== m,
      );
    });
    await rejects(call(), "procedure_failed");
    expect(hooks.size).toBe(0);
  });

  it("refuses without pf2e's reroll", async () => {
    world.pf2e.Check = {};
    await rejects(call(), "unsupported_runtime");
  });
});

describe("pf2e.reroll.v1 capability", () => {
  it("is advertised with Check.rerollFromMessage, unsupported without it", () => {
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).toContain("pf2e.reroll.v1");
    expect(registry.mutations()).toContain("pf2e.reroll.v1");
    expect(registry.isSignedOnly("pf2e.reroll.v1")).toBe(true);

    world.pf2e.Check = class {};
    const without = new ProcedureRegistry();
    registerBuiltinProcedures(without);
    expect(without.capabilities()).not.toContain("pf2e.reroll.v1");
    expect(without.capabilities()).toContain("pf2e.check.v1");
    expect(without.unsupported()["pf2e.reroll.v1"]).toBe(
      "pf2e 8.7.0 on Foundry 14; requires pf2e 8.5.1 or a later 8.x on Foundry 14 with game.pf2e.Check.rerollFromMessage",
    );
  });
});
