import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pf2eCardV1, validatePf2eCardV1 } from "../src/procedures/pf2eCard.js";
import { MODULE_ID, SETTING_AGENT_USER } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";

type Dict = Record<string, any>;

// SYNTHETIC, shape-only: a spell's and an item's `toMessage` as the pf2e
// 8.6.1 sources describe them — with `create: false` they answer the unsaved
// message, whose `toObject()` is the card's source.
const EVENT = "0b7d5c1e-9f3a-4e2b-8c6d-1a2b3c4d5e6f";
const PC = "pf2ePC0000000001";
const ENTRY = "spellEntry000001";
const SPELL = "spell00000000001";
const POTION = "potion0000000001";
const GM = "gmUser0000000001";
const PLAYER = "player0000000001";
const COMPANION = "companion0000001";

let world: Dict;
let created: { data: Dict; options: Dict }[];
let actor: ReturnType<typeof character>;

const unposted = (content: string) => ({
  toObject: () => ({
    speaker: { actor: PC, alias: "Ezren" },
    content,
    whisper: [GM],
    flags: { pf2e: { origin: { type: "spell" }, casting: { id: ENTRY } } },
  }),
});

function character() {
  const entry = {
    id: ENTRY,
    type: "spellcastingEntry",
    cast: vi.fn(),
    consume: vi.fn(),
  };
  const spell = {
    id: SPELL,
    type: "spell",
    rank: 1,
    toMessage: vi.fn(async (_event: unknown, _options: Dict) =>
      unposted("<div>Invisibility</div>"),
    ),
    update: vi.fn(),
  };
  const potion = {
    id: POTION,
    type: "consumable",
    toMessage: vi.fn(async (_event: unknown, _options: Dict) =>
      unposted("<div>Healing Potion</div>"),
    ),
    consume: vi.fn(),
    update: vi.fn(),
  };
  return {
    id: PC,
    type: "character",
    items: { contents: [entry, spell, potion] },
    testUserPermission: (u: Dict) => u.id === PLAYER,
    update: vi.fn(),
    updateEmbeddedDocuments: vi.fn(),
    entry,
    spell,
    potion,
  };
}

function stubWorld(): void {
  created = [];
  actor = character();
  const gm = { id: GM, isGM: true, active: true };
  const users = [
    gm,
    { id: PLAYER, isGM: false, active: true, character: { id: PC } },
    { id: COMPANION, isGM: false, active: true },
  ];
  world = {
    system: { id: "pf2e", version: "8.5.1" },
    release: { generation: 14 },
    user: gm,
    users: {
      contents: users,
      get: (id: string) => users.find((u) => u.id === id),
    },
    actors: { get: (id: string) => (id === PC ? actor : undefined) },
    messages: { contents: [] as Dict[] },
    settings: {
      get: (_scope: string, key: string) =>
        key === SETTING_AGENT_USER ? COMPANION : "",
    },
  };
  vi.stubGlobal("game", world);
  vi.stubGlobal("ChatMessage", {
    implementation: {
      create: vi.fn(async (data: Dict, options: Dict) => {
        created.push({ data, options });
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
    origin: "app",
    actorId: PC,
    kind: "spell",
    itemId: SPELL,
    castRank: 2,
    visibility: "public",
    ...over,
  };
}

const item = (over: Dict = {}) =>
  payload({ kind: "item", itemId: POTION, castRank: null, ...over });

const call = (p: Dict) =>
  Promise.resolve().then(() => pf2eCardV1(p, {} as never)) as Promise<Dict>;

async function rejects(pending: unknown, code: string) {
  const promise = Promise.resolve(pending);
  await expect(promise).rejects.toBeInstanceOf(RpcError);
  await expect(promise).rejects.toMatchObject({ code });
}

/** Nothing anywhere spent a slot, a focus point or an item. */
function nothingSpent() {
  expect(actor.entry.cast).not.toHaveBeenCalled();
  expect(actor.entry.consume).not.toHaveBeenCalled();
  expect(actor.potion.consume).not.toHaveBeenCalled();
  expect(actor.spell.update).not.toHaveBeenCalled();
  expect(actor.potion.update).not.toHaveBeenCalled();
  expect(actor.update).not.toHaveBeenCalled();
  expect(actor.updateEmbeddedDocuments).not.toHaveBeenCalled();
}

beforeEach(stubWorld);
afterEach(() => vi.unstubAllGlobals());

describe("pf2e.card.v1 payload", () => {
  it("accepts the documented payloads", () => {
    expect(validatePf2eCardV1(payload())).toEqual(payload());
    expect(validatePf2eCardV1(payload({ castRank: null }))).toEqual(
      payload({ castRank: null }),
    );
    expect(validatePf2eCardV1(item({ visibility: "gm" }))).toEqual(
      item({ visibility: "gm" }),
    );
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["a missing key", { castRank: undefined }],
    ["an unknown kind", { kind: "feat" }],
    ["a rank of 0", { castRank: 0 }],
    ["a rank of 11", { castRank: 11 }],
    ["a cast rank on an item", { kind: "item", castRank: 1 }],
    ["a malformed item id", { itemId: "potion" }],
    ["a blind card", { visibility: "blind" }],
    ["a non-UUID eventId", { eventId: "event-1" }],
  ])("refuses %s", (_label, over) => {
    const p = payload(over);
    for (const [k, v] of Object.entries(p)) if (v === undefined) delete p[k];
    expect(() => validatePf2eCardV1(p)).toThrow(RpcError);
  });
});

describe("pf2e.card.v1", () => {
  it("posts the spell's own card heightened to its cast rank, unposted then created once, spending nothing", async () => {
    const result = await call(payload());
    expect(actor.spell.toMessage).toHaveBeenCalledWith(null, {
      create: false,
      mode: "public",
      actualCast: true,
      data: { castRank: 2 },
    });
    expect(result).toEqual({
      messageId: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
      alreadyPosted: false,
    });
    expect(created).toHaveLength(1);
    const { data, options } = created[0];
    expect(options).toEqual({ keepId: true });
    expect(data._id).toBe(result.messageId);
    expect(data.content).toBe("<div>Invisibility</div>");
    expect(data.author).toBe(PLAYER);
    expect(data.whisper).toEqual([]);
    expect(data.flags.pf2e.casting).toEqual({ id: ENTRY });
    expect(data.flags[MODULE_ID]).toEqual({
      eventId: EVENT,
      origin: "app",
      lane: "pf2e.card",
      result,
    });
    nothingSpent();
  });

  it("leaves the rank to pf2e when the app asks below the spell's own rank", async () => {
    // pf2e's toMessage never returns for a rank under the spell's (a focus
    // spell or a cantrip is heightened by itself): it recurses until the stack ends.
    actor.spell.rank = 4;
    await call(payload({ castRank: 1 }));
    expect(actor.spell.toMessage).toHaveBeenCalledWith(null, {
      create: false,
      mode: "public",
      actualCast: true,
      data: {},
    });
    actor.spell.toMessage.mockClear();
    await call(payload({ eventId: EVENT.replace(/.$/, "0"), castRank: 5 }));
    expect(actor.spell.toMessage).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ data: { castRank: 5 } }),
    );
  });

  it("leaves the rank to pf2e when the app sent none", async () => {
    await call(payload({ castRank: null }));
    expect(actor.spell.toMessage).toHaveBeenCalledWith(null, {
      create: false,
      mode: "public",
      actualCast: true,
      data: {},
    });
  });

  it("posts an item's card without consuming it", async () => {
    await call(item());
    expect(actor.potion.toMessage).toHaveBeenCalledWith(null, {
      create: false,
      mode: "public",
    });
    expect(created).toHaveLength(1);
    expect(created[0].data.content).toBe("<div>Healing Potion</div>");
    expect(created[0].data.flags[MODULE_ID]).not.toHaveProperty("effect");
    nothingSpent();
  });

  it("keeps a consumable's effect on its card's stamp", async () => {
    Object.assign(actor.potion, {
      name: "Healing Potion (Moderate)",
      uuid: `Actor.${PC}.Item.${POTION}`,
      _stats: { compendiumSource: "Compendium.pf2e.equipment-srd.Item.x" },
      system: {
        damage: { formula: "3d8+10", type: "vitality", kind: "healing" },
      },
    });
    const reply = await call(item());
    expect(reply).toEqual({
      messageId: expect.any(String),
      alreadyPosted: false,
    });
    expect(created[0].data.flags[MODULE_ID].effect).toEqual({
      name: "Healing Potion (Moderate)",
      formula: "3d8+10",
      type: "vitality",
      kind: "healing",
      sourceId: "Compendium.pf2e.equipment-srd.Item.x",
      uuid: `Actor.${PC}.Item.${POTION}`,
    });
    nothingSpent();
  });

  it("whispers a GM card to every GM and the Companion user", async () => {
    await call(payload({ visibility: "gm" }));
    expect(actor.spell.toMessage.mock.calls[0][1]).toMatchObject({
      mode: "gm",
    });
    expect(created[0].data.whisper).toEqual([GM, COMPANION]);
    expect(created[0].data.blind).toBe(false);
    // Authored by the GM, so the PC's player cannot read it.
    expect(created[0].data).not.toHaveProperty("author");
  });

  it("answers a retry from the stamped card and joins one in flight, posting once", async () => {
    const [a, b] = await Promise.all([call(payload()), call(payload())]);
    const c = await call(payload());
    expect(b).toEqual({ ...a, alreadyPosted: true });
    expect(c).toEqual({ ...a, alreadyPosted: true });
    expect(actor.spell.toMessage).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it.each([
    ["actor_not_found", payload({ actorId: "missing000000001" })],
    ["spell_not_found", payload({ itemId: POTION })],
    ["spell_not_found", payload({ itemId: "missing000000001" })],
    ["item_not_found", item({ itemId: SPELL })],
    ["item_not_found", item({ itemId: ENTRY })],
  ])("refuses with %s, posting nothing", async (code, p) => {
    await rejects(call(p), code);
    expect(created).toHaveLength(0);
  });

  it("refuses when pf2e builds no card, or Foundry creates none", async () => {
    actor.spell.toMessage.mockResolvedValueOnce(undefined as never);
    await rejects(call(payload()), "spell_not_found");
    (globalThis as Dict).ChatMessage.implementation.create = vi.fn(
      async () => undefined,
    );
    await rejects(call(item()), "item_not_found");
    expect(world.messages.contents).toHaveLength(0);
  });

  it("refuses a non-GM responder and a pf2e below the floor", async () => {
    world.user = { id: PLAYER, isGM: false };
    await rejects(call(payload()), "permission_denied");
    stubWorld();
    world.system.version = "8.5.0";
    await rejects(call(payload()), "unsupported_runtime");
    expect(created).toHaveLength(0);
  });
});
