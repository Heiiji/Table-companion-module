import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorItemsV1 } from "../src/procedures/actorItems.js";
import { readWeaponAttacks } from "../src/procedures/actorItems.read.js";
import {
  validateKnightActorItemsV1,
  type AttackProfileV1,
} from "../src/procedures/actorItems.validate.js";
import { KNIGHT_WEAPON_CROSSWALK_V14_0_1 } from "../src/refdata/knightWeaponCrosswalkV14_0_1.js";
import { MODULE_ID } from "../src/constants.js";
import {
  ACTOR_ID,
  fakeActor,
  stubFoundry,
  applyUpdate,
  type FakeActor,
  type StubCompendium,
} from "./support/actorUpsertHarness.js";

/**
 * Every catalog weapon of the app (73), with the profiles an app sends under
 * `actorItemsWeaponDetailsV1` and, for the 71 the Knight Compendium 14.0.1
 * holds, the shape of the document the crosswalk names (prose omitted).
 */
interface FixtureWeapon {
  catalogId: string;
  name: string;
  rarity: string;
  cost: number;
  profiles: AttackProfileV1[];
  document: null | {
    pack: string;
    documentId: string;
    documentCount: number;
    source: Record<string, any>;
  };
}
const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/knight-weapons-14.0.1.json", import.meta.url),
    "utf8",
  ),
) as { effectKeys: string[]; weapons: FixtureWeapon[] };
const WEAPONS = FIXTURE.weapons;

afterEach(() => vi.unstubAllGlobals());

const ENTRY = "6f1c0a52-8a43-4c9e-9b41-0a1e5d7c2b01";
type Item = Record<string, any> & { id: string };
let actor: FakeActor;

/** A bound Knight PC; the compendium holds every fixture document unless
 * `compendium` is false; the system knows the fixture's effect keys. */
function world(compendium = true, keys = FIXTURE.effectKeys): void {
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
  const documents: StubCompendium["documents"] = {};
  for (const w of WEAPONS)
    if (w.document)
      (documents[w.document.pack] ??= {})[w.document.documentId] =
        w.document.source;
  stubFoundry(
    [actor],
    undefined,
    14,
    compendium ? { documents } : undefined,
    "3.58.37",
  );
  vi.stubGlobal("CONFIG", {
    KNIGHT: { effets: Object.fromEntries(keys.map((k) => [k, {}])) },
  });
}

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

async function run(op: unknown) {
  return (await actorItemsV1(request(op), {} as never)) as Record<
    string,
    unknown
  >;
}

const add = (w: FixtureWeapon, over: Record<string, unknown> = {}) => ({
  add: {
    entryId: ENTRY,
    kind: "weapon",
    source: { catalogId: w.catalogId },
    item: {
      name: w.name,
      profiles: w.profiles,
      rarity: w.rarity,
      cost: w.cost,
      description: "Une arme.\n\nDeux paragraphes.",
      ...over,
    },
  },
});

const items = () => actor.items.contents as Item[];
const weapon = (id: string) => WEAPONS.find((w) => w.catalogId === id)!;
const sets = (profiles: AttackProfileV1[]) =>
  profiles.map((p) => ({ ...p, effects: [...new Set(p.effects)].sort() }));
const empty = (d: any) => !d?.dice && !d?.fixe;

/** How many attacks a Knight `arme` source holds. */
function modes(system: Record<string, any>): number {
  if (system.type === "contact" && system.options2mains.has) return 2;
  if (system.type === "distance" && system.optionsmunitions.has)
    return Object.keys(system.optionsmunitions.liste).length;
  return 1;
}

describe("the weapon crosswalk", () => {
  it("names one document for each of the 71 compendium weapons, and none for the 2 it lacks", () => {
    expect(WEAPONS).toHaveLength(73);
    const expected = Object.fromEntries(
      WEAPONS.filter((w) => w.document).map((w) => [
        w.catalogId,
        { pack: w.document!.pack, documentId: w.document!.documentId },
      ]),
    );
    expect(KNIGHT_WEAPON_CROSSWALK_V14_0_1).toEqual(expected);
    expect(Object.keys(expected)).toHaveLength(71);
    expect(WEAPONS.filter((w) => !w.document).map((w) => w.catalogId)).toEqual([
      "knight.weapon.grenade-intelligente",
      "knight.weapon.fusil-longbow",
    ]);
    expect(
      WEAPONS.filter((w) => w.document?.documentCount === 2).map(
        (w) => w.catalogId.split(".")[2],
      ),
    ).toEqual([
      "pistolet-de-service",
      "marteau-epieu",
      "bouclier-amovible",
      "targe-amovible",
      "pavois",
      "ceste-shotgun",
    ]);
  });

  it("maps a two-document weapon to the document of its first attack", () => {
    for (const w of WEAPONS.filter((x) => x.document?.documentCount === 2))
      expect(w.document!.source.system.portee, w.catalogId).toBe(
        w.profiles[0].range!.toLowerCase(),
      );
  });

  it("every effect token the app sends is a key the Knight system knows", () => {
    const keys = new Set(FIXTURE.effectKeys);
    for (const w of WEAPONS)
      for (const p of w.profiles)
        for (const t of p.effects!)
          expect(keys.has(t.split(" ")[0]), `${w.catalogId} ${t}`).toBe(true);
  });
});

describe("actor.items.v1 weapon details validation", () => {
  const refuse = (op: unknown) =>
    expect(() => validateKnightActorItemsV1(request(op))).toThrow();

  it("accepts every fixture weapon's add, and rarity, cost and effects on an update", () => {
    for (const w of WEAPONS)
      expect(() => validateKnightActorItemsV1(request(add(w)))).not.toThrow();
    const fields = { rarity: "rare", cost: 70, profiles: [] };
    expect(() =>
      validateKnightActorItemsV1(
        request({
          update: {
            itemId: "aB3dE5fG7hJ9kL1m",
            kind: "weapon",
            item: fields,
            expected: fields,
          },
        }),
      ),
    ).not.toThrow();
  });

  it("bounds the effects, rarity and cost, and keeps the description off live sources and updates", () => {
    const w = weapon("knight.weapon.fusil-dassaut");
    const p = w.profiles[0];
    for (const effects of [
      ["Choc 2"],
      ["choc  2"],
      ["choc 2", "choc 2"],
      ["a<script>"],
      Array.from({ length: 33 }, (_, i) => `e${i}`),
      "choc 2",
    ])
      refuse(add(w, { profiles: [{ ...p, effects }] }));
    refuse(add(w, { rarity: "advanced" }));
    refuse(add(w, { cost: 10000 }));
    refuse(add(w, { cost: -1 }));
    refuse({
      add: {
        ...add(w).add,
        source: { live: { pack: "", docId: "worldItem0000001" } },
      },
    });
    refuse({
      update: {
        itemId: "aB3dE5fG7hJ9kL1m",
        kind: "weapon",
        item: { description: "x" },
        expected: { description: "x" },
      },
    });
    refuse({
      add: {
        entryId: ENTRY,
        kind: "module",
        source: { custom: true },
        item: { name: "Saut", rarity: "rare" },
      },
    });
  });
});

describe("actor.items.v1 weapons copied from the compendium", () => {
  it.each(WEAPONS.filter((w) => w.document).map((w) => [w.catalogId, w]))(
    "%s: Foundry's copy wins, the catalog fills only what it lacks",
    async (_, w) => {
      world();
      const result = await run(add(w));
      const [item] = items();
      const doc = w.document!.source;
      expect(item.name).toBe(w.name);
      expect(item.img).toBe(doc.img);
      expect(flagsOf(item)).toEqual({ entryId: ENTRY });
      const sy = item.system;
      // Never rewritten to the app's shape.
      for (const key of [
        "type",
        "portee",
        "rarete",
        "prix",
        "options2mains",
        "optionsmunitions",
        "effets2mains",
      ])
        expect(sy[key], key).toEqual(
          key === "options2mains" || key === "optionsmunitions"
            ? fillHands(doc.system, w)[key]
            : doc.system[key],
        );
      expect(sy.description).toBe(doc.system.description);
      // A flat pair the compendium leaves empty takes the catalog's.
      const first = w.profiles[0];
      for (const [pair, ours] of [
        ["degats", first.damage],
        ["violence", first.violence],
      ] as const)
        expect(sy[pair], pair).toEqual(
          modes(doc.system) === 1 && empty(doc.system[pair]) && ours
            ? { dice: ours.count, fixe: ours.flat }
            : doc.system[pair],
        );
      expect(sy.effets.raw).toEqual(doc.system.effets.raw);
      expect(result.warnings).toEqual(
        w.profiles.length > modes(doc.system) ? ["profiles_dropped"] : [],
      );
    },
  );

  it("lands Typhon and Canon Nova with the catalog's dice over the compendium's empty ones", async () => {
    for (const [id, damage, violence] of [
      ["knight.weapon.marteau-cinetique-typhon", [12, 0], [6, 6]],
      ["knight.weapon.canon-nova", [10, 6], [10, 6]],
    ] as const) {
      world();
      await run(add(weapon(id)));
      const sy = items()[0].system;
      expect([sy.degats.dice, sy.degats.fixe]).toEqual(damage);
      expect([sy.violence.dice, sy.violence.fixe]).toEqual(violence);
      expect(sy.effets.raw.length).toBeGreaterThan(0);
    }
  });

  it("keeps a two-handed copy's hands and an ammunition copy's every mode", async () => {
    world();
    await run(add(weapon("knight.weapon.epee-batarde")));
    expect(readWeaponAttacks(items()[0].system, "Épée bâtarde", true)).toEqual([
      expect.objectContaining({ id: "1main", effects: ["orfevrerie"] }),
      expect.objectContaining({ id: "2main", effects: ["deuxmains", "leste"] }),
    ]);
    world();
    await run(add(weapon("knight.weapon.lance-grenade-lourd")));
    expect(
      readWeaponAttacks(items()[0].system, "x", true).map((a) => a.name),
    ).toEqual([
      "Grenade adhésive",
      "Grenade anti-blindage",
      "Grenade explosive",
      "Grenade incendiaire",
    ]);
  });

  it("re-sent, fills the flagged copy and never writes over a Foundry edit", async () => {
    world();
    const w = weapon("knight.weapon.fusil-dassaut");
    await run(add(w));
    const [item] = items();
    applyUpdate(item, { "system.degats.dice": 9, "system.effets.raw": [] });
    await run(add(w));
    expect(items()).toHaveLength(1);
    expect(item.system.degats.dice).toBe(9);
    expect(item.system.effets.raw).toEqual([
      "barrage 2",
      "deuxmains",
      "ultraviolence",
    ]);
  });

  it("builds instead when the compendium is absent", async () => {
    world(false);
    const result = await run(add(weapon("knight.weapon.fusil-dassaut")));
    expect(result.warnings).toEqual(["item_built"]);
    expect(items()[0].img).toBeUndefined();
  });
});

describe("actor.items.v1 weapons built from the app", () => {
  it.each(WEAPONS.map((w) => [w.catalogId, w]))(
    "%s: created whole with every mode Foundry can hold, its effects, rarity, cost and description",
    async (_, w) => {
      world(false);
      const result = await run(add(w));
      const created = actor.createEmbeddedDocuments as ReturnType<typeof vi.fn>;
      expect(created).toHaveBeenCalledTimes(1);
      const [item] = items();
      expect((item.update as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
      expect(item.type).toBe("arme");
      expect(item.system.rarete).toBe(w.rarity);
      expect(item.system.prix).toBe(w.cost);
      expect(item.system.description).toBe(
        "<p>Une arme.</p><p>Deux paragraphes.</p>",
      );
      const kept =
        w.profiles.length > 1 && !isShaped(w) ? 1 : w.profiles.length;
      const read = readWeaponAttacks(item.system, w.name, true);
      const stats = (p: AttackProfileV1) => ({ ...p, id: "", name: "" });
      expect(read.map(stats)).toEqual(
        sets(w.profiles.slice(0, kept)).map(stats),
      );
      expect(result.warnings).toEqual(
        kept < w.profiles.length
          ? ["item_built", "profiles_dropped"]
          : ["item_built"],
      );
    },
  );

  it("splits ammunition effects into the weapon's shared list and each ammunition's own", async () => {
    world(false);
    await run(add(weapon("knight.weapon.lance-missile")));
    const sy = items()[0].system;
    expect(sy.effets.raw).toEqual(["assistanceattaque", "deuxmains", "lourd"]);
    expect(sy.optionsmunitions.liste["0"].raw).toEqual([
      "antivehicule",
      "artillerie",
    ]);
    expect(sy.optionsmunitions.actuel).toBe("0");
  });

  it("drops a token the running system does not know, with a warning", async () => {
    world(
      false,
      FIXTURE.effectKeys.filter((k) => k !== "barrage"),
    );
    const result = await run(add(weapon("knight.weapon.fusil-dassaut")));
    expect(items()[0].system.effets.raw).toEqual([
      "deuxmains",
      "ultraviolence",
    ]);
    expect(result.warnings).toEqual(["item_built", "effects_unmapped"]);
  });
});

describe("actor.items.v1 weapon updates with effects", () => {
  it("heals a weapon an older module built poor, then holds it", async () => {
    world(false);
    const w = weapon("knight.weapon.lance-missile");
    // What an older module made: the first attack, flat, no effects.
    await run({
      add: {
        entryId: ENTRY,
        kind: "weapon",
        source: { custom: true },
        item: {
          name: w.name,
          profiles: [{ ...w.profiles[0], id: "a1", effects: undefined }],
        },
      },
    });
    const [item] = items();
    const expected = readWeaponAttacks(item.system, w.name);
    const heal = {
      update: {
        itemId: item.id,
        kind: "weapon",
        item: { profiles: w.profiles, rarity: w.rarity, cost: w.cost },
        expected: { profiles: expected, rarity: "standard", cost: 0 },
      },
    };
    item.system.rarete = "standard";
    item.system.prix = 0;
    await run(heal);
    expect(readWeaponAttacks(item.system, w.name, true)).toEqual(
      sets(w.profiles),
    );
    expect([item.system.rarete, item.system.prix]).toEqual([w.rarity, w.cost]);
    // Landed: the same update again writes nothing.
    const update = item.update as ReturnType<typeof vi.fn>;
    const writes = update.mock.calls.length;
    await run(heal);
    expect(update.mock.calls.length).toBe(writes);
  });

  it("an update without effects compares and writes as before", async () => {
    world(false);
    const w = weapon("knight.weapon.fusil-dassaut");
    await run(add(w));
    const [item] = items();
    const bare = readWeaponAttacks(item.system, w.name);
    const update = item.update as ReturnType<typeof vi.fn>;
    await run({
      update: {
        itemId: item.id,
        kind: "weapon",
        item: { profiles: bare },
        expected: { profiles: bare },
      },
    });
    expect(update.mock.calls).toEqual([]);
    expect(item.system.effets.raw).toEqual([
      "barrage 2",
      "deuxmains",
      "ultraviolence",
    ]);
  });
});

function flagsOf(item: Item) {
  return (item.flags as Record<string, unknown>)[MODULE_ID];
}

/** Whether Foundry holds every profile of `w` as one Item (hands or
 * ammunition). */
function isShaped(w: FixtureWeapon): boolean {
  const ids = w.profiles.map((p) => p.id);
  return ids[0] === "1main" || ids.every((id) => id.startsWith("munition-"));
}

/** The copy's hands after the fill: an empty hand pair takes the app's. */
function fillHands(system: Record<string, any>, w: FixtureWeapon) {
  if (!(system.type === "contact" && system.options2mains.has)) return system;
  const hands = structuredClone(system.options2mains);
  for (const hand of ["1main", "2main"]) {
    const p = w.profiles.find((x) => x.id === hand);
    for (const [pair, ours] of [
      ["degats", p?.damage],
      ["violence", p?.violence],
    ] as const)
      if (empty(hands[hand][pair]) && ours)
        hands[hand][pair] = { dice: ours.count, fixe: ours.flat };
  }
  return { ...system, options2mains: hands };
}
