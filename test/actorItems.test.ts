import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorItemsV1 } from "../src/procedures/actorItems.js";
import { readWeaponAttacks } from "../src/procedures/actorItems.read.js";
import {
  validateKnightActorItemsV1,
  type AttackProfileV1,
} from "../src/procedures/actorItems.validate.js";
import { MODULE_ID } from "../src/constants.js";
import { RpcError } from "../src/rpc/errors.js";
import {
  ACTOR_ID,
  USER_ID,
  fakeActor,
  pairCompanion,
  stubFoundry,
  type FakeActor,
  type StubCompendium,
} from "./support/actorUpsertHarness.js";

afterEach(() => vi.unstubAllGlobals());

const ENTRY = "6f1c0a52-8a43-4c9e-9b41-0a1e5d7c2b01";
const MODULE_PACK = "knight-compendium.modules-standard";
const SAUT_DOC = "sXd50IHvgwvC3R5k";
const WORLD_ITEM = "worldItem0000001";

type Item = Record<string, unknown> & { id: string };

function request(op: unknown): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actorType: "knight",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    expectedActorId: ACTOR_ID,
    op,
  };
}

/** One module level as the Knight 3.58.37 schema initializes it. */
function levelDetails(raw: string[] = [], over: Record<string, unknown> = {}) {
  return {
    energie: {
      tour: { value: 0, label: "" },
      minute: { value: 0, label: "" },
      supplementaire: 0,
    },
    arme: {
      optionsmunitions: { has: false, actuel: "0", value: 1, liste: {} },
      effets: { liste: [], raw, custom: [], activable: [], chargeur: null },
    },
    ...over,
  };
}

function moduleSystem(
  details: Record<string, unknown> = { n1: levelDetails() },
  value = 1,
) {
  return {
    active: { base: false },
    description: "",
    slots: {
      tete: 0,
      torse: 0,
      brasGauche: 0,
      brasDroit: 0,
      jambeGauche: 0,
      jambeDroite: 0,
    },
    niveau: { value, max: Object.keys(details).length, details },
  };
}

let actor: FakeActor;

/** A bound Knight PC whose Item creation fills a built module's schema
 * defaults, as Foundry does. */
function world(compendium?: StubCompendium, worldItems = {}): void {
  actor = fakeActor();
  actor.items.contents = [];
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: "world-1",
      tableId: "table-1",
      characterId: "character-1",
    },
  };
  const create = actor.createEmbeddedDocuments.getMockImplementation() as (
    type: string,
    data: Record<string, unknown>[],
  ) => Promise<unknown>;
  actor.createEmbeddedDocuments = vi.fn(
    async (type: string, data: Record<string, unknown>[]) => {
      const filled = data.map((source) =>
        source.type === "module" &&
        Object.keys(source.system as object).length === 0
          ? { ...source, system: moduleSystem() }
          : source,
      );
      return create(type, filled);
    },
  );
  stubFoundry([actor], undefined, 14, compendium, "3.58.37");
  const game = (globalThis as unknown as { game: Record<string, unknown> })
    .game;
  vi.stubGlobal("game", {
    ...game,
    items: {
      get: (id: string) => {
        const source = (worldItems as Record<string, unknown>)[id];
        return source ? { toObject: () => structuredClone(source) } : undefined;
      },
    },
  });
}

const items = () => actor.items.contents as Item[];
const sys = (item: Item) => item.system as Record<string, any>;
const flags = (item: Item) =>
  (item.flags as Record<string, unknown>)[MODULE_ID];

async function run(op: unknown) {
  return (await actorItemsV1(request(op), {} as never)) as Record<
    string,
    unknown
  >;
}

async function refused(op: unknown, code: string) {
  await expect(run(op)).rejects.toMatchObject({ code });
}

const SLOTS = {
  tete: 0,
  torse: 1,
  bras_gauche: 1,
  bras_droit: 1,
  jambe_gauche: 0,
  jambe_droite: 0,
};

function addModule(
  item: Record<string, unknown>,
  source: unknown = { custom: true },
) {
  return { add: { entryId: ENTRY, kind: "module", source, item } };
}

/** A module Item already on the Actor. */
function ownModule(
  id: string,
  over: Record<string, unknown> = {},
  system = moduleSystem(),
): Item {
  const item: Item = {
    id,
    type: "module",
    name: "Saut",
    system,
    flags: {},
    ...over,
  };
  item.update = vi.fn(async (changes: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(changes)) {
      const parts = key.split(".");
      let cursor: Record<string, unknown> = item;
      for (const part of parts.slice(0, -1)) {
        cursor[part] ??= {};
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts.at(-1)!] = value;
    }
  });
  actor.items.contents.push(item);
  return item;
}

describe("actor.items.v1 validation", () => {
  const ok = addModule({ name: "Accélérateur", level: 1, slots: SLOTS });
  const refuse = (op: unknown) =>
    expect(() => validateKnightActorItemsV1(request(op))).toThrowError(
      RpcError,
    );

  it("accepts the three ops", () => {
    expect(validateKnightActorItemsV1(request(ok)).op).toEqual(ok);
    validateKnightActorItemsV1(
      request({
        update: {
          itemId: "aB3dE5fG7hJ9kL1m",
          kind: "module",
          item: {},
          expected: {},
          entryId: ENTRY,
        },
      }),
    );
    validateKnightActorItemsV1(
      request({
        remove: {
          itemId: "aB3dE5fG7hJ9kL1m",
          kind: "weapon",
          expectedName: "X",
        },
      }),
    );
  });

  it("refuses unknown keys at every boundary", () => {
    expect(() =>
      validateKnightActorItemsV1({ ...request(ok), sequence: 1 }),
    ).toThrowError(/not allowed/);
    refuse({ ...ok, remove: ok.add });
    refuse({ add: { ...ok.add, extra: 1 } });
    refuse(addModule({ name: "A", colour: "red" }));
    refuse(addModule({ name: "A" }, { custom: true, catalogId: "x" }));
    refuse(
      addModule({ name: "A" }, { live: { pack: "", docId: WORLD_ITEM, x: 1 } }),
    );
    refuse(addModule({ name: "A", slots: { ...SLOTS, queue: 0 } }));
  });

  it("keeps module and weapon fields apart", () => {
    refuse({
      add: {
        entryId: ENTRY,
        kind: "weapon",
        source: { custom: true },
        item: { name: "Fusil", level: 1 },
      },
    });
    refuse(addModule({ name: "A", profiles: [] }));
    refuse({
      add: {
        entryId: ENTRY,
        kind: "weapon",
        source: { custom: true },
        item: { name: "Fusil", description: "x" },
      },
    });
  });

  it("bounds every field", () => {
    for (const item of [
      { name: " " },
      { name: "a".repeat(201) },
      { name: "a\0b" },
      { name: "A", level: 0 },
      { name: "A", level: 6 },
      { name: "A", energy: 21 },
      { name: "A", energy: -1 },
      { name: "A", slots: { ...SLOTS, tete: 10 } },
      { name: "A", slots: { tete: 1 } },
      { name: "A", active: "yes" },
      { name: "A", chargesCurrent: 1 },
      { name: "A", chargesCurrent: 3, chargesMax: 2 },
      { name: "A", chargesCurrent: 100, chargesMax: 100 },
      { name: "A", description: "é".repeat(4097) },
      { level: 1 },
    ])
      refuse(addModule(item));
    validateKnightActorItemsV1(
      request(
        addModule({ name: "a".repeat(200), description: "é".repeat(4096) }),
      ),
    );
    refuse({ add: { ...ok.add, entryId: ENTRY.toUpperCase() } });
    refuse(addModule({ name: "A" }, { custom: false }));
    refuse(addModule({ name: "A" }, { catalogId: "bad id" }));
    refuse(addModule({ name: "A" }, { live: { pack: "", docId: "short" } }));
    refuse(
      addModule(
        { name: "A", description: "x" },
        { live: { pack: "", docId: WORLD_ITEM } },
      ),
    );
    const weapon = (profiles: unknown) => ({
      add: {
        entryId: ENTRY,
        kind: "weapon",
        source: { custom: true },
        item: { name: "Fusil", profiles },
      },
    });
    const attack = (id: string) => ({ id, name: "Tir" });
    refuse(weapon(Array.from({ length: 9 }, (_, i) => attack(`a${i}`))));
    refuse(weapon([attack("a"), attack("a")]));
    refuse(weapon([{ id: "a", name: "Tir", range: "" }]));
    refuse(weapon([{ id: "a", name: "Tir", damage: { count: 1, faces: 6 } }]));
    refuse(weapon([{ id: "a", name: "Tir", note: "x" }]));
    // Dice a damage roll could not survive: negative, oversized, faceless.
    const shot = (damage: Record<string, number>) =>
      weapon([{ id: "a", name: "Tir", damage: { flat: 0, ...damage } }]);
    refuse(shot({ count: -1, faces: 6 }));
    refuse(shot({ count: 99999999, faces: 6 }));
    refuse(shot({ count: 1001, faces: 6 }));
    refuse(shot({ count: 1, faces: 0 }));
    refuse(shot({ count: 1, faces: -6 }));
    refuse(shot({ count: 1, faces: 1001 }));
    validateKnightActorItemsV1(request(shot({ count: 0, faces: 6, flat: 2 })));
    validateKnightActorItemsV1(request(shot({ count: 1000, faces: 6 })));
    validateKnightActorItemsV1(
      request(weapon(Array.from({ length: 8 }, (_, i) => attack(`a${i}`)))),
    );
  });

  it("refuses an update whose item and expected differ, a description, or nothing", () => {
    const update = (u: Record<string, unknown>) => ({
      update: { itemId: "aB3dE5fG7hJ9kL1m", kind: "module", ...u },
    });
    refuse(update({ item: { active: true }, expected: {} }));
    refuse(update({ item: { active: true }, expected: { level: 1 } }));
    refuse(update({ item: {}, expected: {} }));
    refuse(
      update({ item: { description: "x" }, expected: { description: "y" } }),
    );
    refuse(update({ item: {}, expected: {}, entryId: "nope" }));
  });
});

describe("actor.items.v1 add", () => {
  it("builds a custom module from every field and stamps only the entry id", async () => {
    world();
    const result = await run(
      addModule({
        name: "Bras-canon maison",
        level: 2,
        energy: 3,
        slots: SLOTS,
        active: true,
        description: "Tir <lourd> & sûr.\n\nSecond paragraphe.",
      }),
    );
    expect(items()).toHaveLength(1);
    const item = items()[0];
    expect(result).toEqual({
      schemaVersion: 1,
      resultDocId: ACTOR_ID,
      outcome: "updated",
      appliedDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      warnings: ["item_built"],
      itemId: item.id,
    });
    expect(item.name).toBe("Bras-canon maison");
    expect(flags(item)).toEqual({ entryId: ENTRY });
    const s = sys(item);
    expect(s.niveau.value).toBe(2);
    expect(s.niveau.max).toBe(2);
    expect(s.niveau.details.n2.energie.tour.value).toBe(3);
    expect(s.niveau.details.n1.energie.tour.value).toBe(0);
    expect(s.slots).toEqual({
      tete: 0,
      torse: 1,
      brasGauche: 1,
      brasDroit: 1,
      jambeGauche: 0,
      jambeDroite: 0,
    });
    expect(s.active.base).toBe(true);
    expect(s.description).toBe(
      "<p>Tir &lt;lourd&gt; &amp; sûr.</p><p>Second paragraphe.</p>",
    );
  });

  it("re-sent, updates the flagged Item and never makes a second one", async () => {
    world();
    await run(addModule({ name: "Saut", level: 1 }));
    const result = await run(
      addModule({ name: "Saut", level: 1, active: true }),
    );
    expect(items()).toHaveLength(1);
    expect(result.itemId).toBe(items()[0].id);
    expect(result.warnings).toEqual([]);
    expect(sys(items()[0]).active.base).toBe(true);
  });

  it("copies a mapped catalog module from the compendium, without the catalog flags", async () => {
    world({
      documents: {
        [MODULE_PACK]: {
          [SAUT_DOC]: {
            _id: SAUT_DOC,
            name: "Saut",
            type: "module",
            ownership: { default: 0 },
            flags: { [MODULE_ID]: { equipmentCatalogId: "stale" } },
            system: moduleSystem({
              n1: levelDetails(),
              n2: levelDetails(["chargeur 3"], {
                energie: {
                  tour: { value: 0 },
                  minute: { value: 4 },
                  supplementaire: 0,
                },
              }),
              n3: levelDetails(),
            }),
          },
        },
      },
    });
    const result = await run(
      addModule(
        { name: "Saut", energy: 6, chargesCurrent: 1, chargesMax: 3 },
        { catalogId: "knight.module.saut.l2" },
      ),
    );
    expect(result.warnings).toEqual([]);
    const item = items()[0];
    expect(item._id).toBeUndefined();
    expect(item.ownership).toBeUndefined();
    expect(flags(item)).toEqual({ entryId: ENTRY });
    const s = sys(item);
    expect(s.niveau.value).toBe(2); // the catalog entry's level
    expect(s.niveau.max).toBe(3);
    expect(s.niveau.details.n2.energie.minute.value).toBe(6);
    expect(s.niveau.details.n2.energie.tour.value).toBe(0);
    expect(s.niveau.details.n2.arme.effets.chargeur).toBe(1);
  });

  it("builds a catalog module the compendium cannot provide", async () => {
    world();
    expect(
      (
        await run(
          addModule(
            { name: "Accélérateur", level: 1, energy: 5 },
            { catalogId: "knight.module.saut.l1" },
          ),
        )
      ).warnings,
    ).toEqual(["item_built"]);
    world({ documents: {} });
    const unmapped = await run(
      addModule(
        { name: "Accélérateur", level: 1 },
        { catalogId: "knight.module.accelerateur.l1" },
      ),
    );
    expect(unmapped.warnings).toEqual(["item_built"]);
    expect(items()[0].type).toBe("module");
  });

  /** Pair the backend as USER_ID and give the world Item and every pack the
   * service user's view: `visible` decides what it may observe. */
  function liveWorld(source: Record<string, unknown>, visible: boolean) {
    world(
      { documents: { "world.mods": { [WORLD_ITEM]: source } } },
      {
        [WORLD_ITEM]: source,
      },
    );
    pairCompanion(USER_ID);
    const game = (globalThis as unknown as { game: Record<string, any> }).game;
    const see = (user: { id?: string }, level: string) =>
      visible && user?.id === USER_ID && level === "OBSERVER";
    vi.stubGlobal("game", {
      ...game,
      items: {
        get: (id: string) => {
          const doc = game.items.get(id);
          return doc && { ...doc, testUserPermission: see };
        },
      },
      packs: {
        get: (pack: string) => {
          const p = game.packs.get(pack);
          return (
            p && { ...p, metadata: { type: "Item" }, testUserPermission: see }
          );
        },
      },
    });
  }

  it("copies a live world Item or pack document, and builds when it is gone", async () => {
    const source = {
      _id: WORLD_ITEM,
      name: "Monde",
      type: "module",
      folder: "f",
      system: moduleSystem(),
    };
    liveWorld(source, true);
    expect(
      (
        await run(
          addModule(
            { name: "Monde" },
            { live: { pack: "", docId: WORLD_ITEM } },
          ),
        )
      ).warnings,
    ).toEqual([]);
    expect(items()[0].folder).toBeUndefined();
    liveWorld(source, true);
    expect(
      (
        await run(
          addModule(
            { name: "Monde" },
            { live: { pack: "world.mods", docId: WORLD_ITEM } },
          ),
        )
      ).warnings,
    ).toEqual([]);
    world();
    expect(
      (
        await run(
          addModule(
            { name: "Monde" },
            { live: { pack: "", docId: WORLD_ITEM } },
          ),
        )
      ).warnings,
    ).toEqual(["item_built"]);
  });

  it("never copies a live Item or pack the paired service user cannot observe", async () => {
    const hidden = {
      _id: WORLD_ITEM,
      name: "Secret du MJ",
      type: "module",
      system: { ...moduleSystem(), description: "<p>GM only</p>" },
    };
    for (const pack of ["", "world.mods"]) {
      liveWorld(hidden, false);
      const result = await run(
        addModule({ name: "Monde" }, { live: { pack, docId: WORLD_ITEM } }),
      );
      expect(result.warnings).toEqual(["item_built"]);
      expect(items()[0].name).toBe("Monde");
      expect(sys(items()[0]).description).not.toContain("GM only");
    }
    // Unpaired: nothing is observable.
    world(
      { documents: { "world.mods": { [WORLD_ITEM]: hidden } } },
      {
        [WORLD_ITEM]: hidden,
      },
    );
    expect(
      (
        await run(
          addModule(
            { name: "Monde" },
            { live: { pack: "", docId: WORLD_ITEM } },
          ),
        )
      ).warnings,
    ).toEqual(["item_built"]);
  });

  it("refuses an add whose flagged Item is of the other kind", async () => {
    world();
    ownModule("aB3dE5fG7hJ9kL1m", {
      type: "arme",
      flags: { [MODULE_ID]: { entryId: ENTRY } },
    });
    await refused(addModule({ name: "Saut" }), "item_conflict");
  });
});

describe("actor.items.v1 charges", () => {
  const ID = "aB3dE5fG7hJ9kL1m";
  const charge = async (level: ReturnType<typeof levelDetails>) => {
    world();
    const item = ownModule(ID, {}, moduleSystem({ n1: level }));
    const result = await run({
      update: {
        itemId: ID,
        kind: "module",
        item: { chargesCurrent: 2, chargesMax: 4 },
        expected: { chargesCurrent: 4, chargesMax: 4 },
      },
    });
    return { result, item };
  };

  it("writes the current charges of a single chargeur, never the maximum", async () => {
    const { result, item } = await charge(levelDetails(["chargeur 4"]));
    expect(result.warnings).toEqual([]);
    expect(item.update).toHaveBeenCalledWith({
      "system.niveau.details.n1.arme.effets.chargeur": 2,
    });
  });

  it("leaves charges app-side with none, two, or ammunition options", async () => {
    for (const level of [
      levelDetails([]),
      levelDetails(["chargeur 4", "chargeur 2"]),
      (() => {
        const l = levelDetails(["chargeur 4"]);
        l.arme.optionsmunitions.has = true;
        return l;
      })(),
    ]) {
      world();
      const item = ownModule(
        ID,
        { flags: { [MODULE_ID]: { entryId: ENTRY } } },
        moduleSystem({ n1: level }),
      );
      // A re-sent add updates without a compare: the charges stay app-side.
      const result = await run(
        addModule({
          name: "Saut",
          active: true,
          chargesCurrent: 2,
          chargesMax: 4,
        }),
      );
      expect(result.warnings).toEqual(["charges_unmapped"]);
      expect(item.update).toHaveBeenCalledWith({
        name: "Saut",
        "system.active.base": true,
      });
      // Unmapped charges read back absent: an expected value cannot match.
      await refused(
        {
          update: {
            itemId: ID,
            kind: "module",
            item: { chargesCurrent: 1, chargesMax: 4 },
            expected: { chargesCurrent: 4, chargesMax: 4 },
          },
        },
        "item_conflict",
      );
    }
    world();
    const add = await run(
      addModule({ name: "Saut", chargesCurrent: 1, chargesMax: 3 }),
    );
    expect(add.warnings).toEqual(["item_built", "charges_unmapped"]);
    expect(sys(items()[0]).niveau.details.n1.arme.effets.chargeur).toBeNull();
  });
});

describe("actor.items.v1 update and remove", () => {
  const ID = "aB3dE5fG7hJ9kL1m";
  beforeEach(() => world());

  it("compares every expected field, then writes the moved ones", async () => {
    const item = ownModule(ID);
    await run({
      update: {
        itemId: ID,
        kind: "module",
        item: { name: "Saut II", level: 2, slots: SLOTS, energy: 2 },
        expected: {
          name: "Saut",
          level: 1,
          slots: { ...SLOTS, torse: 0, bras_gauche: 0, bras_droit: 0 },
          energy: 0,
        },
      },
    });
    expect(item.name).toBe("Saut II");
    expect(sys(item).niveau.value).toBe(2);
    expect(sys(item).niveau.details.n2.energie.tour.value).toBe(2);
    expect(sys(item).slots.brasGauche).toBe(1);
  });

  it("answers item_conflict when Foundry moved a field first, writing nothing", async () => {
    const item = ownModule(ID, { name: "Saut renommé" });
    await refused(
      {
        update: {
          itemId: ID,
          kind: "module",
          item: { name: "Saut II" },
          expected: { name: "Saut" },
        },
      },
      "item_conflict",
    );
    await refused(
      {
        update: {
          itemId: ID,
          kind: "weapon",
          item: { name: "X" },
          expected: { name: "Saut renommé" },
        },
      },
      "item_conflict",
    );
    expect(item.update).not.toHaveBeenCalled();
  });

  it("answers item_missing for an absent Item", async () => {
    await refused(
      {
        update: {
          itemId: ID,
          kind: "module",
          item: { active: true },
          expected: { active: false },
        },
      },
      "item_missing",
    );
  });

  it("compares names after NFC on both sides; a blank Item name matches any", async () => {
    const nfd = "Cafe\u0301";
    const nfc = "Caf\u00e9";
    const item = ownModule(ID, { name: nfd });
    // Already equal after NFC: applied, nothing written.
    await run({
      update: {
        itemId: ID,
        kind: "module",
        item: { name: nfc },
        expected: { name: "Ancien" },
      },
    });
    expect(item.update).not.toHaveBeenCalled();
    // The expected name matches after NFC: the update lands.
    await run({
      update: {
        itemId: ID,
        kind: "module",
        item: { name: "Neuf" },
        expected: { name: nfc },
      },
    });
    expect(item.name).toBe("Neuf");
    item.name = nfd;
    await run({ remove: { itemId: ID, kind: "module", expectedName: nfc } });
    expect(items()).toHaveLength(0);
    const blank = ownModule(ID, { name: " " });
    await run({
      update: {
        itemId: ID,
        kind: "module",
        item: { name: "Neuf" },
        expected: { name: "Peu importe" },
      },
    });
    expect(blank.name).toBe("Neuf");
    blank.name = "";
    await run({
      remove: { itemId: ID, kind: "module", expectedName: "Peu importe" },
    });
    expect(items()).toHaveLength(0);
  });

  it("re-sent add targets the lowest id among Items sharing the entry id", async () => {
    const flagged = { flags: { [MODULE_ID]: { entryId: ENTRY } } };
    const later = ownModule("zZ3dE5fG7hJ9kL1m", flagged);
    const lowest = ownModule("aB3dE5fG7hJ9kL1m", flagged);
    const upper = ownModule("Ab3dE5fG7hJ9kL1m", flagged);
    const result = await run(addModule({ name: "Saut", active: true }));
    // Codepoint order: uppercase sorts before lowercase.
    expect(result.itemId).toBe("Ab3dE5fG7hJ9kL1m");
    expect(upper.update).toHaveBeenCalled();
    expect(lowest.update).not.toHaveBeenCalled();
    expect(later.update).not.toHaveBeenCalled();
    expect(items()).toHaveLength(3);
  });

  it("answers applied when the update already landed, before comparing expected", async () => {
    const item = ownModule(ID, {
      flags: { [MODULE_ID]: { entryId: ENTRY } },
    });
    const landed = {
      update: {
        itemId: ID,
        kind: "module",
        item: { name: "Saut", active: false },
        expected: { name: "Ancien", active: true },
        entryId: ENTRY,
      },
    };
    expect(await run(landed)).toMatchObject({ itemId: ID, warnings: [] });
    expect(item.update).not.toHaveBeenCalled();
    // One field still to move: the stale expected value is a conflict.
    await refused(
      {
        update: {
          ...landed.update,
          item: { name: "Saut", active: true },
        },
      },
      "item_conflict",
    );
    // Landed fields with a missing stamp: only the stamp is written.
    (item.flags as Record<string, unknown>)[MODULE_ID] = {};
    await run(landed);
    expect(item.update).toHaveBeenCalledWith({
      [`flags.${MODULE_ID}.entryId`]: ENTRY,
    });
  });

  it("adopts a linked Item by stamping only its entry id", async () => {
    const item = ownModule(ID);
    const result = await run({
      update: {
        itemId: ID,
        kind: "module",
        item: {},
        expected: {},
        entryId: ENTRY,
      },
    });
    expect(result.itemId).toBe(ID);
    expect(item.update).toHaveBeenCalledWith({
      [`flags.${MODULE_ID}.entryId`]: ENTRY,
    });
  });

  it("removes a named Item, applies a missing one, refuses a renamed one", async () => {
    ownModule(ID, { name: "Saut renommé" });
    await refused(
      { remove: { itemId: ID, kind: "module", expectedName: "Saut" } },
      "item_conflict",
    );
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    await run({
      remove: { itemId: ID, kind: "module", expectedName: "Saut renommé" },
    });
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", [ID]);
    expect(items()).toHaveLength(0);
    const again = await run({
      remove: { itemId: ID, kind: "module", expectedName: "Saut renommé" },
    });
    expect(again).toMatchObject({ itemId: ID, warnings: [] });
  });

  it("targets the unbound Actor the app names, and nothing else", async () => {
    actor.flags = {};
    ownModule(ID);
    await run({
      update: {
        itemId: ID,
        kind: "module",
        item: { active: true },
        expected: { active: false },
      },
    });
    actor.flags[MODULE_ID] = {
      binding: {
        schemaVersion: 1,
        worldId: "world-1",
        tableId: "table-1",
        characterId: "someone-else",
      },
    };
    await refused(
      { remove: { itemId: ID, kind: "module", expectedName: "Saut" } },
      "binding_conflict",
    );
  });
});

describe("actor.items.v1 weapons", () => {
  const addWeapon = (profiles: AttackProfileV1[], name = "Fusil d'assaut") => ({
    add: {
      entryId: ENTRY,
      kind: "weapon",
      source: { custom: true },
      item: { name, profiles },
    },
  });

  it.each<[string, AttackProfileV1[]]>([
    [
      "one profile",
      [
        {
          id: "primary",
          name: "Fusil d'assaut",
          range: "Moyenne",
          damage: { count: 3, faces: 6, flat: 3 },
          violence: { count: 2, faces: 6, flat: 0 },
        },
      ],
    ],
    [
      "one and two hands",
      [
        {
          id: "1main",
          name: "Une main",
          range: "Contact",
          damage: { count: 2, faces: 6, flat: 6 },
        },
        {
          id: "2main",
          name: "Deux mains",
          range: "Contact",
          damage: { count: 3, faces: 6, flat: 6 },
          violence: { count: 1, faces: 6, flat: 0 },
        },
      ],
    ],
    [
      "ammunition",
      [
        {
          id: "munition-0",
          name: "Standard",
          range: "Longue",
          damage: { count: 3, faces: 6, flat: 0 },
        },
        {
          id: "munition-1",
          name: "Perforante",
          range: "Longue",
          violence: { count: 0, faces: 6, flat: 2 },
        },
      ],
    ],
  ])("built from %s, reads back to the same attacks", async (_, profiles) => {
    world();
    const result = await run(addWeapon(profiles));
    expect(result.warnings).toEqual(["item_built"]);
    const item = items()[0];
    expect(item.type).toBe("arme");
    expect(readWeaponAttacks(item.system, item.name as string)).toEqual(
      profiles,
    );
    // The read-back is what an update compares against.
    await run({
      update: {
        itemId: item.id,
        kind: "weapon",
        item: { name: "Renommé" },
        expected: { name: "Fusil d'assaut" },
      },
    });
    await refused(
      {
        update: {
          itemId: item.id,
          kind: "weapon",
          item: { profiles: [] },
          expected: { profiles: [{ id: "primary", name: "X" }] },
        },
      },
      "item_conflict",
    );
  });

  it("holds a lone attack as the flat profile, whatever its id and name", async () => {
    world();
    const lone: AttackProfileV1 = {
      id: "contact",
      name: "Frappe",
      range: "Contact",
      damage: { count: 3, faces: 6, flat: 6 },
    };
    await run(addWeapon([lone]));
    const item = items()[0];
    const update = item.update as ReturnType<typeof vi.fn>;
    const writes = update.mock.calls.length;
    const retried = {
      update: {
        itemId: item.id,
        kind: "weapon",
        item: { profiles: [lone] },
        expected: { profiles: [{ id: "primary", name: "Ancien" }] },
      },
    };
    expect(await run(retried)).toMatchObject({ itemId: item.id });
    expect(update.mock.calls.length).toBe(writes);
    // A lone attack whose dice differ has not landed: the stale expected conflicts.
    await refused(
      {
        update: {
          ...retried.update,
          item: {
            profiles: [{ ...lone, damage: { count: 4, faces: 6, flat: 6 } }],
          },
        },
      },
      "item_conflict",
    );
  });

  it("replaces a copied weapon's ammunition, keeping the effects of one it keeps", async () => {
    world();
    const item = ownModule("nP2qR4sT6uV8wX0y", {
      type: "arme",
      name: "Fusil",
      system: {
        type: "distance",
        portee: "longue",
        optionsmunitions: {
          has: true,
          actuel: "2",
          liste: {
            "0": { nom: "A", degats: { dice: 1, fixe: 0 }, raw: ["perce 2"] },
            "2": { nom: "B", degats: { dice: 2, fixe: 0 }, raw: [] },
          },
        },
      },
    });
    const expected = readWeaponAttacks(item.system, "Fusil");
    await run({
      update: {
        itemId: item.id,
        kind: "weapon",
        item: {
          profiles: [
            {
              id: "munition-0",
              name: "A+",
              range: "Longue",
              damage: { count: 4, faces: 6, flat: 0 },
            },
          ],
        },
        expected: { profiles: expected },
      },
    });
    const patch = (item.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(patch).toMatchObject({
      "system.optionsmunitions.liste.0.nom": "A+",
      "system.optionsmunitions.liste.0.degats.dice": 4,
      "system.optionsmunitions.liste.-=2": null,
      "system.optionsmunitions.actuel": "0",
      "system.optionsmunitions.value": 1,
    });
    expect(sys(item).optionsmunitions.liste["0"].raw).toEqual(["perce 2"]);
  });
});
