import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dcValueOf,
  pf2eCheckV1,
  validatePf2eCheckV1,
} from "../src/procedures/pf2eCheck.js";
import { MODULE_ID, SETTING_AGENT_USER } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";

type Dict = Record<string, any>;

// The result shape the backend and the apps read (a fortune Strike against a
// target, no DC sent); shared byte for byte with them.
const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/pf2e-check-v1-result.json", import.meta.url),
    "utf8",
  ),
);

// SYNTHETIC, shape-only: pf2e's roll surfaces as the pf2e 8.6.1 sources
// describe them. Every roll function behaves like `Check.roll` with
// `createMessage: false`: it hands its callback the unposted message (whose
// `flags.pf2e.context` carries the outcome) and returns the roll.
const EVENT = "6f1c2a7e-4b1d-4c8e-9a51-2f0d7c3b9e10";
const PC = "pf2ePC0000000001";
const NPC = "pf2eNPC000000001";
const FOE = "pf2eFoe000000001";
const WEAPON = "weapon0000000001";
const ENTRY = "spellEntry000001";
const SPELL = "spell00000000001";
const GM = "gmUser0000000001";
const PLAYER = "player0000000001";
const COMPANION = "companion0000001";
/** The target's AC as pf2e would record it: never in the reply. */
const TARGET_AC = 18;
/** pf2e's world setting `metagame_showResults` (« Show Check Outcomes »). */
let showResults: unknown;

interface Outcome {
  faces: number[];
  total: number;
  outcome?: string | null;
  unadjustedOutcome?: string | null;
  options?: string[];
  /** pf2e's own mode, when a secret roll option forced one. */
  messageMode?: string;
  /** pf2e resolved a target (`context.target`) and took its DC from it. */
  target?: boolean;
  noD20?: boolean;
}

let outcome: Outcome | null;
let world: Dict;
let created: { data: Dict; options: Dict }[];
let createResult: "message" | "nothing";

/** What pf2e resolved as the target of the last roll (8.6.1: the passed
 * target, else the rolling user's first target), and the Gamemaster's target
 * set as pf2e saw it. */
let resolved: { target: unknown; gmTargets: unknown[] } | null;

function fakeRoll(params: Dict) {
  return Promise.resolve().then(() => {
    const gmTargets = [...((world.user.targets as Set<unknown>) ?? [])];
    resolved = { target: params.target ?? gmTargets[0] ?? null, gmTargets };
    if (!outcome) return null;
    const o = outcome;
    const results = o.faces.map((result) => ({
      result,
      active: o.faces.length === 1 || result === Math.max(...o.faces),
      ...(o.faces.length === 2 && result !== Math.max(...o.faces)
        ? { discarded: true }
        : {}),
    }));
    const roll = {
      total: o.total,
      dice: o.noD20 ? [] : [{ faces: 20, results }],
    };
    const source = {
      speaker: { actor: PC, alias: "Ezren" },
      content: "<h4 class='action'>Strike</h4>",
      rolls: [JSON.stringify(roll)],
      whisper: [GM],
      flags: {
        pf2e: {
          context: {
            outcome: o.outcome ?? null,
            unadjustedOutcome: o.unadjustedOutcome ?? o.outcome ?? null,
            messageMode: o.messageMode ?? params.messageMode ?? "public",
            options: o.options ?? ["self:action:slug:strike"],
            // pf2e records the DC it used, a target's AC included.
            dc: params.dc?.value
              ? { value: params.dc.value }
              : o.target
                ? { slug: "ac", value: TARGET_AC }
                : null,
            target:
              o.target || resolved.target
                ? { actor: `Actor.${FOE}`, token: "Scene.s.Token.t" }
                : null,
          },
        },
      },
    };
    params.callback?.(roll, o.outcome, { toObject: () => source });
    return roll;
  });
}

const roller = () => vi.fn((params: Dict) => fakeRoll(params));

function character() {
  const variants = [0, 1, 2].map(() => ({ roll: roller() }));
  const statistics: Dict = {
    perception: { roll: roller() },
    stealth: { roll: roller() },
    "connaissance-de-la-forêt": { roll: roller() },
  };
  const entry = {
    id: ENTRY,
    type: "spellcastingEntry",
    tradition: "arcane",
    statistic: { check: { roll: roller() } },
    cast: vi.fn(),
    consume: vi.fn(),
  };
  const spell = {
    id: SPELL,
    type: "spell",
    system: {
      location: { value: ENTRY },
      traits: { value: ["attack", "fire"] },
      defense: null,
    },
  };
  return {
    id: PC,
    type: "character",
    getStatistic: vi.fn((slug: string) => statistics[slug] ?? null),
    system: {
      actions: [
        { type: "strike", slug: "claw", item: { id: WEAPON }, variants },
        {
          type: "strike",
          slug: "fist",
          item: { id: "fist000000000001" },
          visible: false,
          variants: [{ roll: roller() }],
        },
      ],
    },
    items: { contents: [entry, spell] },
    testUserPermission: (u: Dict) => u.id === PLAYER,
    update: vi.fn(),
    statistics,
    variants,
    entry,
  };
}

function npc() {
  return {
    id: NPC,
    type: "npc",
    getStatistic: vi.fn(() => ({ roll: roller() })),
    system: {
      actions: [
        {
          type: "strike",
          slug: "jaws",
          item: { id: WEAPON },
          variants: [{ roll: roller() }],
        },
      ],
    },
    items: { contents: [] },
    update: vi.fn(),
  };
}

let pc: ReturnType<typeof character>;
let foeToken: Dict;

function stubWorld(over: Dict = {}): void {
  created = [];
  createResult = "message";
  pc = character();
  const monster = npc();
  const gm = {
    id: GM,
    isGM: true,
    active: true,
    settings: { showCheckDialogs: true },
    targets: new Set<unknown>(),
  };
  const users = [
    gm,
    {
      id: PLAYER,
      isGM: false,
      active: true,
      character: { id: PC },
      targets: new Set<unknown>(),
    },
    { id: COMPANION, isGM: false, active: true },
  ];
  const actors = [pc, monster];
  world = {
    system: { id: "pf2e", version: "8.6.1" },
    release: { generation: 14 },
    user: gm,
    users: {
      contents: users,
      get: (id: string) => users.find((u) => u.id === id),
    },
    actors: { get: (id: string) => actors.find((a) => a.id === id) },
    messages: { contents: [] as Dict[] },
    pf2e: { Check: class {} },
    settings: {
      get: (scope: string, key: string) =>
        key === SETTING_AGENT_USER
          ? COMPANION
          : scope === "pf2e" && key === "metagame_showResults"
            ? showResults
            : "",
    },
    ...over,
  };
  foeToken = {
    id: "token00000000001",
    document: { actorId: FOE },
    actor: { id: FOE },
  };
  vi.stubGlobal("game", world);
  vi.stubGlobal("canvas", { tokens: { placeables: [foeToken] } });
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
  vi.stubGlobal("ChatMessage", {
    implementation: {
      create: vi.fn(async (data: Dict, options: Dict) => {
        created.push({ data, options });
        if (createResult === "nothing") return undefined;
        const message = { id: data._id, ...data };
        world.messages.contents.push(message);
        return message;
      }),
    },
  });
}

function payload(over: Dict = {}): Dict {
  return {
    eventId: EVENT,
    origin: "player",
    actorId: PC,
    kind: "statistic",
    statistic: "perception",
    strike: null,
    spell: null,
    mapIncreases: 0,
    dc: 20,
    rollTwice: null,
    targetActorIds: [],
    visibility: "public",
    ...over,
  };
}

const strike = (over: Dict = {}) =>
  payload({
    kind: "strike",
    statistic: null,
    strike: { itemId: WEAPON, slug: "claw" },
    ...over,
  });

const call = (p: Dict) =>
  Promise.resolve().then(() => pf2eCheckV1(p, {} as never)) as Promise<Dict>;

async function rejects(pending: unknown, code: string) {
  const promise = Promise.resolve(pending);
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code });
}

beforeEach(() => {
  resolved = null;
  outcome = { faces: [12], total: 21, outcome: "success" };
  showResults = true;
  stubWorld();
});
afterEach(() => vi.unstubAllGlobals());

describe("pf2e.check.v1 payload", () => {
  it("accepts the documented payloads", () => {
    expect(validatePf2eCheckV1(payload())).toEqual(payload());
    expect(validatePf2eCheckV1(strike({ mapIncreases: 2 }))).toEqual(
      strike({ mapIncreases: 2 }),
    );
    const spell = payload({
      kind: "spellAttack",
      statistic: null,
      spell: { entryId: ENTRY, spellId: SPELL },
      dc: null,
      rollTwice: "keep-lower",
      targetActorIds: [FOE],
      visibility: "gm",
    });
    expect(validatePf2eCheckV1(spell)).toEqual(spell);
    // A lore's pf2e slug may be accented.
    const lore = payload({ statistic: "connaissance-de-la-forêt" });
    expect(validatePf2eCheckV1(lore)).toEqual(lore);
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["a missing key", { visibility: undefined }],
    ["an uppercase eventId", { eventId: EVENT.toUpperCase() }],
    ["a short actor id", { actorId: "abc" }],
    ["an unknown kind", { kind: "damage" }],
    ["a statistic kind without a statistic", { statistic: null }],
    [
      "a statistic kind with a strike",
      { strike: { itemId: WEAPON, slug: "claw" } },
    ],
    ["a slug with a space", { statistic: "warfare lore" }],
    ["a 65-char slug", { statistic: "a".repeat(65) }],
    ["a MAP step of 3", { mapIncreases: 3 }],
    ["a DC of 0", { dc: 0 }],
    ["a DC of 100", { dc: 100 }],
    ["a fractional DC", { dc: 20.5 }],
    ["a bad fortune", { rollTwice: "keep-both" }],
    ["21 targets", { targetActorIds: Array(21).fill(FOE) }],
    ["a malformed target", { targetActorIds: ["x"] }],
    ["a blind roll", { visibility: "blind" }],
    ["a self roll", { visibility: "self" }],
    ["an unknown origin", { origin: "gm" }],
    ["a non-boolean dcVisible", { dcVisible: "no" }],
    ["a null dcVisible", { dcVisible: null }],
    ["a hidden DC without a DC", { dcVisible: false, dc: null }],
  ])("refuses %s", (_label, over) => {
    const p = payload(over);
    for (const [k, v] of Object.entries(p)) if (v === undefined) delete p[k];
    expect(() => validatePf2eCheckV1(p)).toThrow(RpcError);
  });

  it("accepts the optional dcVisible, and leaves it out when absent", () => {
    expect(validatePf2eCheckV1(payload({ dcVisible: false }))).toEqual(
      payload({ dcVisible: false }),
    );
    expect(validatePf2eCheckV1(payload({ dcVisible: true, dc: null }))).toEqual(
      payload({ dcVisible: true, dc: null }),
    );
    expect(validatePf2eCheckV1(payload())).not.toHaveProperty("dcVisible");
  });

  it("refuses a strike block with an unknown key or a malformed item id", () => {
    expect(() =>
      validatePf2eCheckV1(
        strike({ strike: { itemId: WEAPON, slug: "claw", map: 1 } }),
      ),
    ).toThrow(RpcError);
    expect(() =>
      validatePf2eCheckV1(strike({ strike: { itemId: "w", slug: "claw" } })),
    ).toThrow(RpcError);
    expect(() =>
      validatePf2eCheckV1(
        payload({
          kind: "spellAttack",
          statistic: null,
          spell: { entryId: ENTRY },
        }),
      ),
    ).toThrow(RpcError);
  });
});

describe("pf2e.check.v1", () => {
  it("rolls a statistic through pf2e, dialog skipped and unposted, then creates its card once, stamped at birth", async () => {
    const result = await call(payload());
    const stat = pc.statistics.perception.roll;
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls[0][0]).toMatchObject({
      createMessage: false,
      skipDialog: true,
      messageMode: "public",
      dc: { value: 20 },
      rollTwice: false,
    });
    expect(stat.mock.calls[0][0]).not.toHaveProperty("target");
    expect(result).toEqual({
      messageId: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
      alreadyRolled: false,
      faces: [12],
      kept: 12,
      modifier: 9,
      total: 21,
      degree: "success",
      unadjustedDegree: "success",
      degreeSource: "dc",
      resultsShown: true,
      messageMode: "public",
      dcValue: 20,
    });
    expect(created).toHaveLength(1);
    const { data, options } = created[0];
    expect(options).toEqual({ keepId: true });
    expect(data._id).toBe(result.messageId);
    // The character speaks; the PC's player is the author; public card.
    expect(data.speaker).toEqual({ actor: PC, alias: "Ezren" });
    expect(data.author).toBe(PLAYER);
    expect(data.whisper).toEqual([]);
    expect(data.blind).toBe(false);
    // pf2e's own flags are kept; the module's stamp carries the result.
    expect(data.flags.pf2e.context.outcome).toBe("success");
    // The stamp keeps the result without the DC, which pf2e's context holds.
    const stamped = { ...result, dcValue: undefined };
    expect(data.flags[MODULE_ID]).toEqual({
      eventId: EVENT,
      origin: "player",
      lane: "pf2e.check",
      result: stamped,
    });
    expect(data.flags[MODULE_ID].result).not.toHaveProperty("dcValue");
  });

  it("reads the shared result fixture's shape from a fortune strike against a target", async () => {
    outcome = { faces: [14, 6], total: 27, outcome: "success", target: true };
    const result = await call(
      strike({
        rollTwice: "keep-higher",
        dc: null,
        origin: "app",
        targetActorIds: [FOE],
      }),
    );
    expect(Object.keys(result)).toEqual(Object.keys(FIXTURE));
    expect({ ...result, messageId: FIXTURE.messageId }).toEqual(FIXTURE);
    expect(pc.variants[0].roll.mock.calls[0][0]).toMatchObject({
      rollTwice: "keep-higher",
      dc: null,
      target: foeToken,
    });
  });

  it("answers the target's degree when the app sent no DC, never the AC itself", async () => {
    outcome = {
      faces: [19],
      total: 38,
      outcome: "criticalSuccess",
      unadjustedOutcome: "success",
      target: true,
    };
    const result = await call(strike({ dc: null, targetActorIds: [FOE] }));
    expect(result).toMatchObject({
      degree: "criticalSuccess",
      unadjustedDegree: "success",
      degreeSource: "target",
      resultsShown: true,
    });
    // The reply tells the Gamemaster's device the AC pf2e judged against,
    // read from pf2e's own context; the module's stamp never copies it.
    const { data } = created[0];
    expect(data.flags.pf2e.context.dc.value).toBe(TARGET_AC);
    expect(result.dcValue).toBe(TARGET_AC);
    expect(Object.keys(result).at(-1)).toBe("dcValue");
    const stamped = { ...result, dcValue: undefined };
    expect(data.flags[MODULE_ID].result).toEqual(stamped);
    expect(JSON.stringify(data.flags[MODULE_ID])).not.toContain("dcValue");
    expect(Object.keys(result)).not.toContain("dc");
  });

  it("answers the DC's degree when the app sent one, a target or not", async () => {
    outcome = { faces: [8], total: 21, outcome: "failure", target: true };
    const result = await call(strike({ dc: 22, targetActorIds: [FOE] }));
    expect(result).toMatchObject({
      degree: "failure",
      unadjustedDegree: "failure",
      degreeSource: "dc",
    });
  });

  it("answers no degree when neither a DC nor a target gave one, whatever Foundry folded", async () => {
    outcome = { faces: [3], total: 12, outcome: "failure" };
    const result = await call(payload({ dc: null }));
    expect(pc.statistics.perception.roll.mock.calls[0][0].dc).toBeNull();
    expect(result).toMatchObject({
      degree: null,
      unadjustedDegree: null,
      degreeSource: null,
      resultsShown: true,
      dcValue: null,
    });
    // A target pf2e resolved but no outcome: still no degree.
    stubWorld();
    outcome = { faces: [3], total: 12, outcome: null, target: true };
    const none = await call(strike({ dc: null, targetActorIds: [FOE] }));
    expect([none.degree, none.unadjustedDegree, none.degreeSource]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it.each([
    [true, true],
    [false, false],
    // Unregistered or malformed: the results count as hidden.
    [undefined, false],
    ["true", false],
  ])(
    "reports resultsShown from pf2e's metagame_showResults (%s → %s), with or without a degree",
    async (setting, shown) => {
      showResults = setting;
      outcome = { faces: [15], total: 30, outcome: "success", target: true };
      const hit = await call(strike({ dc: null, targetActorIds: [FOE] }));
      expect(hit).toMatchObject({
        degreeSource: "target",
        resultsShown: shown,
      });
      expect(created[0].data.flags[MODULE_ID].result.resultsShown).toBe(shown);
      stubWorld();
      outcome = { faces: [15], total: 30, outcome: "success" };
      const plain = await call(payload({ dc: null }));
      expect(plain).toMatchObject({ degreeSource: null, resultsShown: shown });
    },
  );

  it("answers a replay of a target's degree from the stamp, unchanged", async () => {
    outcome = { faces: [15], total: 30, outcome: "success", target: true };
    const p = strike({ dc: null, targetActorIds: [FOE] });
    const first = await call(p);
    // The setting moving afterwards does not rewrite the stamped answer.
    showResults = false;
    const again = await call(p);
    expect(again).toEqual({ ...first, alreadyRolled: true });
    expect(first).toMatchObject({ degreeSource: "target", resultsShown: true });
    expect(pc.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it("answers both degrees or neither, and modifier = total - kept", async () => {
    outcome = { faces: [17], total: 26, outcome: "criticalSuccess" };
    outcome.unadjustedOutcome = undefined;
    const lone = await call(payload());
    expect(lone.degree).toBe("criticalSuccess");
    expect(lone.unadjustedDegree).toBe("criticalSuccess");
    expect(lone.total).toBe(lone.kept + lone.modifier);
    stubWorld();
    outcome = { faces: [5], total: 14, outcome: null };
    const none = await call(payload());
    expect([none.degree, none.unadjustedDegree, none.degreeSource]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("refuses a roll with more than two d20 faces", async () => {
    outcome = { faces: [4, 9, 2], total: 18 };
    await rejects(call(payload()), "roll_refused");
    expect(created).toHaveLength(0);
  });

  it("accepts a strike slug up to 120 characters, as the statistics read gives it", () => {
    const long = strike({ strike: { itemId: WEAPON, slug: "s".repeat(120) } });
    expect(validatePf2eCheckV1(long)).toEqual(long);
    expect(() =>
      validatePf2eCheckV1(
        strike({ strike: { itemId: WEAPON, slug: "s".repeat(121) } }),
      ),
    ).toThrow(RpcError);
  });

  it("rolls a lore by its pf2e slug", async () => {
    await call(payload({ statistic: "connaissance-de-la-forêt" }));
    expect(pc.getStatistic).toHaveBeenCalledWith("connaissance-de-la-forêt");
    expect(
      pc.statistics["connaissance-de-la-forêt"].roll,
    ).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2] as const)(
    "rolls a character strike's MAP variant %i with no ammunition and no dialog",
    async (map) => {
      await call(strike({ mapIncreases: map, targetActorIds: [FOE] }));
      pc.variants.forEach((v, i) =>
        expect(v.roll, `variant ${i}`).toHaveBeenCalledTimes(i === map ? 1 : 0),
      );
      const params = pc.variants[map].roll.mock.calls[0][0];
      expect(params).toMatchObject({
        createMessage: false,
        consumeAmmo: false,
        dc: { value: 20 },
        target: foeToken,
      });
      // The synthetic click skips the dialog: shift equals showCheckDialogs;
      // never ctrl or meta, which would force a GM roll.
      expect(params.event).toMatchObject({
        type: "click",
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
      });
    },
  );

  it("presses no shift when the GM's dialogs are off, and lets Foundry target when the app's target is not on the canvas", async () => {
    world.user.settings.showCheckDialogs = false;
    await call(strike({ targetActorIds: ["notOnCanvas00001"] }));
    const params = pc.variants[0].roll.mock.calls[0][0];
    expect(params.event.shiftKey).toBe(false);
    expect(params).not.toHaveProperty("target");
  });

  it("rolls a spell attack as rollAttack builds it, never casting", async () => {
    await call(
      payload({
        kind: "spellAttack",
        statistic: null,
        spell: { entryId: ENTRY, spellId: SPELL },
        mapIncreases: 1,
        dc: null,
        targetActorIds: [FOE],
      }),
    );
    const roll = pc.entry.statistic.check.roll;
    expect(roll).toHaveBeenCalledTimes(1);
    expect(roll.mock.calls[0][0]).toMatchObject({
      item: pc.items.contents[1],
      attackNumber: 2,
      action: "cast-a-spell",
      extraRollOptions: ["action:cast-a-spell"],
      traits: ["attack", "fire", "arcane"],
      dc: { slug: "ac" },
      messageMode: "public",
      skipDialog: true,
      createMessage: false,
      target: foeToken.actor,
    });
    expect(pc.entry.cast).not.toHaveBeenCalled();
    expect(pc.entry.consume).not.toHaveBeenCalled();
    expect(pc.update).not.toHaveBeenCalled();
  });

  it.each([
    ["statistic", () => payload(), () => pc.statistics.perception.roll],
    ["strike", () => strike(), () => pc.variants[0].roll],
    [
      "spellAttack",
      () =>
        payload({
          kind: "spellAttack",
          statistic: null,
          spell: { entryId: ENTRY, spellId: SPELL },
        }),
      () => pc.entry.statistic.check.roll,
    ],
  ])(
    "hides the DC of a %s from players on dcVisible false, and only then",
    async (_kind, request, roll) => {
      const hidden = await call({ ...request(), dcVisible: false });
      expect(roll().mock.calls[0][0].dc).toEqual({ value: 20, visible: false });
      expect(hidden.degreeSource).toBe("dc");
      stubWorld();
      await call({
        ...request(),
        eventId: "77777777-6666-4555-8444-333333333333",
        dcVisible: true,
      });
      expect(roll().mock.calls[0][0].dc).toEqual({ value: 20 });
    },
  );

  it.each([
    ["actor_not_found", payload({ actorId: "missing000000001" })],
    ["statistic_not_found", payload({ statistic: "athletics" })],
    ["strike_not_found", strike({ strike: { itemId: WEAPON, slug: "bite" } })],
    [
      "strike_not_found",
      strike({ strike: { itemId: "fist000000000001", slug: "fist" } }),
    ],
    [
      "spell_not_found",
      payload({
        kind: "spellAttack",
        statistic: null,
        spell: { entryId: "otherEntry000001", spellId: SPELL },
      }),
    ],
    // pf2e's NPC strike never hands its callback the unposted card.
    [
      "unsupported_runtime",
      strike({ actorId: NPC, strike: { itemId: WEAPON, slug: "jaws" } }),
    ],
  ])("refuses with %s before rolling", async (code, p) => {
    await rejects(call(p), code);
    expect(created).toHaveLength(0);
    for (const v of pc.variants) expect(v.roll).not.toHaveBeenCalled();
  });

  it("answers a retry from the stamped card, never rolling twice", async () => {
    const first = await call(payload());
    const again = await call(payload());
    expect(again).toEqual({ ...first, alreadyRolled: true });
    // The stamp has no DC; the replay reads it from pf2e's context again.
    expect(created[0].data.flags[MODULE_ID].result).not.toHaveProperty(
      "dcValue",
    );
    expect(again.dcValue).toBe(20);
    expect(Object.keys(again).at(-1)).toBe("dcValue");
    expect(pc.statistics.perception.roll).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it.each([
    [{ dc: { value: 20 } }, 20],
    [{ dc: { slug: "ac", value: 0 } }, 0],
    [{ dc: { value: 200 } }, 200],
    [{ dc: { value: 20.5 } }, null],
    [{ dc: { value: -1 } }, null],
    [{ dc: { value: 201 } }, null],
    [{ dc: { value: "20" } }, null],
    [{ dc: { slug: "ac" } }, null],
    [{ dc: null }, null],
    [{}, null],
    [null, null],
  ])("reads the DC of context %j as %j", (context, value) => {
    expect(dcValueOf(context)).toBe(value);
  });

  it("joins a retry that arrives while the first call is still rolling", async () => {
    const [a, b] = await Promise.all([call(payload()), call(payload())]);
    expect(b).toEqual({ ...a, alreadyRolled: true });
    expect(pc.statistics.perception.roll).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("whispers a GM roll to every GM and the Companion user", async () => {
    const result = await call(payload({ visibility: "gm" }));
    expect(pc.statistics.perception.roll.mock.calls[0][0].messageMode).toBe(
      "gm",
    );
    expect(created[0].data.whisper).toEqual([GM, COMPANION]);
    expect(created[0].data.blind).toBe(false);
    expect(result.messageMode).toBe("gm");
  });

  it.each(["app", "player"])(
    "authors a GM roll (origin %s) as the GM, so the player cannot read it",
    async (origin) => {
      await call(payload({ visibility: "gm", origin }));
      expect(created[0].data).not.toHaveProperty("author");
      expect(created[0].data.whisper).toEqual([GM, COMPANION]);
      expect(created[0].data.blind).toBe(false);
    },
  );

  it("keeps a check secret when pf2e made it so, whatever the request asked", async () => {
    outcome = {
      faces: [9],
      total: 15,
      outcome: "failure",
      options: ["secret"],
      messageMode: "gm",
    };
    const result = await call(payload({ statistic: "stealth" }));
    expect(result.messageMode).toBe("gm");
    expect(created[0].data.whisper).toEqual([GM, COMPANION]);
    expect(created[0].data.blind).toBe(false);
    // Secret to the player too: the GM, not the player, authors it.
    expect(created[0].data).not.toHaveProperty("author");
    // The GM's own chat mode alone does not make an app roll secret.
    outcome = { faces: [9], total: 15, messageMode: "gm" };
    stubWorld();
    const plain = await call(strike());
    expect(plain.messageMode).toBe("public");
    expect(created[0].data.whisper).toEqual([]);
  });

  it("authors the card as the GM when no player owns the actor", async () => {
    world.users.contents.splice(1, 1);
    await call(payload());
    expect(created[0].data).not.toHaveProperty("author");
  });

  it.each([
    ["pf2e refuses the roll", () => (outcome = null)],
    [
      "the roll has no d20",
      () => (outcome = { faces: [], total: 10, noD20: true }),
    ],
    ["Foundry creates nothing", () => (createResult = "nothing")],
  ])("answers roll_refused when %s", async (_label, arrange) => {
    arrange();
    await rejects(call(payload()), "roll_refused");
    expect(world.messages.contents).toHaveLength(0);
  });

  it("answers roll_refused when pf2e rolls without handing back its card", async () => {
    pc.statistics.perception.roll = vi.fn(async () => ({
      total: 20,
      dice: [{ faces: 20, results: [{ result: 11 }] }],
    }));
    await rejects(call(payload()), "roll_refused");
    expect(created).toHaveLength(0);
  });

  it("refuses a non-GM responder and a runtime without pf2e's Check", async () => {
    world.user = { id: PLAYER, isGM: false };
    await rejects(call(payload()), "permission_denied");
    stubWorld({ pf2e: {} });
    await rejects(call(payload()), "unsupported_runtime");
    stubWorld({ system: { id: "pf2e", version: "8.5.0" } });
    await rejects(call(payload()), "unsupported_runtime");
    expect(created).toHaveLength(0);
  });

  it("refuses when Foundry has no ChatMessage class, before creating anything", async () => {
    vi.stubGlobal("ChatMessage", undefined);
    await rejects(call(payload()), "unsupported_runtime");
  });

  describe("the roller's target, never someone else's", () => {
    const gmTarget = () => ({ id: "gmTarget00000001", actor: { id: FOE } });
    const player = () => world.users.get(PLAYER);
    const spellAttack = (over: Dict = {}) =>
      payload({
        kind: "spellAttack",
        statistic: null,
        spell: { entryId: ENTRY, spellId: SPELL },
        dc: null,
        ...over,
      });

    it.each([
      ["Strike", () => strike({ dc: null })],
      ["spell attack", () => spellAttack()],
    ])(
      "rolls a player's %s with no target when the player targets nothing, the Gamemaster's left as they were",
      async (_label, p) => {
        const before = world.user.targets as Set<unknown>;
        const mine = gmTarget();
        before.add(mine);
        const result = await call(p());
        expect(resolved).toEqual({ target: null, gmTargets: [] });
        expect(result).toMatchObject({ degree: null, degreeSource: null });
        expect(created[0].data.flags.pf2e.context.target).toBeNull();
        // The very same set, holding the same target, after the call.
        expect(world.user.targets).toBe(before);
        expect([...before]).toEqual([mine]);
      },
    );

    it("rolls a player's Strike against the token that player targets", async () => {
      (world.user.targets as Set<unknown>).add(gmTarget());
      (player().targets as Set<unknown>).add(foeToken);
      const result = await call(strike({ dc: null }));
      expect(pc.variants[0].roll.mock.calls[0][0].target).toBe(foeToken);
      expect(resolved!.target).toBe(foeToken);
      expect(result.degreeSource).toBe("target");
    });

    it("rolls the Gamemaster's own roll against the Gamemaster's targets", async () => {
      const mine = gmTarget();
      (world.user.targets as Set<unknown>).add(mine);
      const result = await call(strike({ dc: null, origin: "app" }));
      expect(pc.variants[0].roll.mock.calls[0][0]).not.toHaveProperty("target");
      expect(resolved!.target).toBe(mine);
      expect(result.degreeSource).toBe("target");
      expect([...(world.user.targets as Set<unknown>)]).toEqual([mine]);
    });

    it("rolls against the app's named target before anyone's own, and keeps the Gamemaster's", async () => {
      const mine = gmTarget();
      (world.user.targets as Set<unknown>).add(mine);
      await call(strike({ dc: null, targetActorIds: [FOE] }));
      expect(resolved!.target).toBe(foeToken);
      expect([...(world.user.targets as Set<unknown>)]).toEqual([mine]);
    });

    it("hides the Gamemaster's targets once for overlapping player rolls, and puts them back", async () => {
      const before = world.user.targets as Set<unknown>;
      before.add(gmTarget());
      const other = "7a2c3b8e-5c2e-4d9f-8b62-3e1f8d4c0a21";
      await Promise.all([
        call(strike({ dc: null })),
        call(spellAttack({ eventId: other })),
      ]);
      expect(world.user.targets).toBe(before);
      expect(before.size).toBe(1);
    });

    it("puts the Gamemaster's targets back when the roll fails", async () => {
      const before = world.user.targets as Set<unknown>;
      outcome = null;
      await rejects(call(strike({ dc: null })), "roll_refused");
      expect(world.user.targets).toBe(before);
    });
  });

  it("answers a failure for a stamped card that lost its result", async () => {
    world.messages.contents.push({
      id: "old0000000000001",
      flags: { [MODULE_ID]: { eventId: EVENT, lane: "pf2e.check" } },
    });
    await rejects(call(payload()), "procedure_failed");
    expect(pc.statistics.perception.roll).not.toHaveBeenCalled();
  });
});
