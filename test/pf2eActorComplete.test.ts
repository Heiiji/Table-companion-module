import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULE_ID, SETTING_AGENT_USER } from "../src/constants.js";
import {
  pf2eActorCompleteV1,
  validatePf2eActorCompleteV1,
  type Pf2eActorCompleteResultV1,
  type Pf2eActorCompleteV1,
} from "../src/procedures/pf2eActorComplete.js";
import {
  fakeActor,
  setPath,
  USER_ID,
  type FakeActor,
} from "./support/actorUpsertHarness.js";

// SYNTHETIC, shape-only: the pf2e paths these fakes carry are source-derived
// (pf2e 8.6.1), not captured from a live world. The fakes model only what the
// procedure reads: `game.packs` indexes with `system.slug`, a `fromCompendium`
// that clones, an Actor whose update applies dotted keys, embedded ABC items
// with their boost slots, and a createEmbeddedDocuments that returns the
// created documents with their new ids.

const COMPANION_ID = "companion0000001";
const GM_ID = "gamemaster000001";
const ACTOR_ID = "actor00000000001";

afterEach(() => vi.unstubAllGlobals());

function run(payload: unknown): Promise<Pf2eActorCompleteResultV1> {
  return Promise.resolve(
    pf2eActorCompleteV1(payload, {} as never),
  ) as Promise<Pf2eActorCompleteResultV1>;
}

function request(
  overrides: Partial<Pf2eActorCompleteV1> = {},
): Pf2eActorCompleteV1 {
  return {
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    actorId: ACTOR_ID,
    foundryUserId: USER_ID,
    memberId: "member-1",
    completionRevision: 1,
    level: 3,
    boosts: { "1": ["str", "dex", "con", "wis"] },
    boostSelections: { ancestry: ["str", "con"], background: ["str"] },
    keyAbility: "str",
    skills: { athletics: 2, intimidation: 1, acrobatics: 0 },
    lores: [{ name: "Warfare Lore", rank: 1 }],
    feats: [
      { slug: "sudden-charge", location: "class-1" },
      {
        slug: "assurance",
        location: "skill-2",
        choices: { assurance: "athletics" },
      },
    ],
    spellcasting: [
      {
        slug: "primal-innate",
        tradition: "primal",
        kind: "innate",
        spells: [
          { slug: "tanglefoot", rank: 1 },
          { slug: "heal", rank: 2 },
        ],
      },
    ],
    equipment: [{ slug: "greataxe", quantity: 2 }],
    ...overrides,
  };
}

type Packs = Record<
  string,
  Array<{ _id: string; source: Record<string, unknown> }>
>;

function entry(
  slug: string,
  type: string,
  system: Record<string, unknown> = {},
) {
  return {
    _id: `${slug.replace(/-/g, "").slice(0, 10).padEnd(10, "x")}000001`,
    source: { name: slug, type, system: { slug, rules: [], ...system } },
  };
}

function packs(): Packs {
  return {
    "pf2e.feats-srd": [
      entry("sudden-charge", "feat"),
      entry("assurance", "feat", {
        rules: [
          {
            key: "ChoiceSet",
            flag: "assurance",
            choices: [{ value: "athletics" }, { value: "acrobatics" }],
          },
        ],
      }),
    ],
    "pf2e.spells-srd": [
      entry("tanglefoot", "spell", { level: { value: 1 } }),
      entry("heal", "spell", { level: { value: 1 } }),
    ],
    "pf2e.equipment-srd": [entry("greataxe", "weapon")],
  };
}

function item(source: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...structuredClone(source) };
  doc.update = vi.fn(async (changes: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(changes))
      setPath(doc, key, value);
  });
  return doc;
}

function character(): FakeActor {
  const actor = fakeActor(ACTOR_ID, "Amiri");
  actor.type = "character";
  actor.system = {
    details: { level: { value: 3 } },
    skills: { athletics: { rank: 1 }, acrobatics: { rank: 2 } },
    build: { attributes: { boosts: {} } },
  };
  actor.ownership = { default: 0, [USER_ID]: 3, [COMPANION_ID]: 2 };
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: "world-1",
      tableId: "table-1",
      characterId: "character-1",
    },
    pf2eUpsertCreatedV1: true,
  };
  const all = ["str", "dex", "con", "int", "wis", "cha"];
  actor.items.contents = [
    item({
      id: "ancestry00000001",
      type: "ancestry",
      system: {
        slug: "human",
        boosts: { "0": { value: all }, "1": { value: all } },
      },
    }),
    item({
      id: "background000001",
      type: "background",
      system: {
        slug: "barkeep",
        boosts: { "0": { value: ["str", "con"] }, "1": { value: all } },
      },
    }),
    item({
      id: "class00000000001",
      type: "class",
      system: { slug: "barbarian", keyAbility: { value: ["str"] } },
    }),
  ];
  actor.createEmbeddedDocuments = vi.fn(
    async (_type: string, data: Array<Record<string, unknown>>) => {
      actor.events.push(`create:${data.length}`);
      return data.map((source) => {
        const doc = item({
          ...source,
          id: `item${String(actor.items.contents.length).padStart(12, "0")}`,
        });
        actor.items.contents.push(doc);
        return doc;
      });
    },
  );
  return actor;
}

/** The packs each document request went to, in order. */
const requests: string[] = [];

function stubWorld(
  actors: FakeActor[],
  options: {
    packs?: Packs;
    version?: string;
    isGM?: boolean;
  } = {},
): { fromCompendium: ReturnType<typeof vi.fn> } {
  const content = options.packs ?? packs();
  requests.length = 0;
  const fromCompendium = vi.fn(
    (doc: { toObject(): Record<string, unknown> }) => ({
      ...doc.toObject(),
      _stats: { compendiumSource: "Compendium.pf2e.test.Item.x" },
    }),
  );
  const users: Record<string, { id: string; isGM: boolean }> = {
    [USER_ID]: { id: USER_ID, isGM: false },
    [COMPANION_ID]: { id: COMPANION_ID, isGM: false },
    [GM_ID]: { id: GM_ID, isGM: true },
  };
  vi.stubGlobal("game", {
    user: { id: GM_ID, isGM: options.isGM ?? true },
    users: { get: (id: string) => users[id] },
    actors: {
      contents: actors,
      get: (id: string) => actors.find((a) => a.id === id),
    },
    packs: {
      get: (id: string) => {
        const entries = content[id];
        if (!entries) return undefined;
        return {
          getIndex: async () =>
            entries.map((e) => ({
              _id: e._id,
              system: { slug: (e.source.system as { slug: string }).slug },
            })),
          getDocuments: async ({ _id__in }: { _id__in: string[] }) => {
            requests.push(id);
            return entries
              .filter((x) => _id__in.includes(x._id))
              .map((e) => ({
                _id: e._id,
                toObject: () => structuredClone(e.source),
              }));
          },
        };
      },
    },
    items: { fromCompendium },
    settings: {
      get: (scope: string, key: string) =>
        scope === MODULE_ID && key === SETTING_AGENT_USER ? COMPANION_ID : "",
    },
    system: { id: "pf2e", version: options.version ?? "8.6.1" },
    release: { generation: 14 },
  });
  return { fromCompendium };
}

function created(actor: FakeActor): Array<Record<string, unknown>> {
  return actor.createEmbeddedDocuments.mock.calls.flatMap(
    (call) => call[1] as Array<Record<string, unknown>>,
  );
}

function createdSlugs(actor: FakeActor): string[] {
  return created(actor).map((i) =>
    String((i.system as { slug?: string }).slug),
  );
}

function byId(actor: FakeActor, id: string): Record<string, unknown> {
  return actor.items.contents.find((i) => i.id === id)!;
}

function storedFlag(actor: FakeActor): Record<string, unknown> | undefined {
  return (actor.flags[MODULE_ID] as Record<string, unknown>).pf2eCompleteV1 as
    Record<string, unknown> | undefined;
}

function nothingWritten(actor: FakeActor): void {
  expect(actor.updates).toEqual([]);
  expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  for (const i of actor.items.contents)
    expect(i.update as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
}

describe("pf2e.actor.complete.v1 validation", () => {
  it("accepts a full request and a minimal one", () => {
    expect(validatePf2eActorCompleteV1(request())).toEqual(request());
    const bare = request({
      boosts: {},
      boostSelections: {},
      skills: {},
      lores: [],
      feats: [],
      spellcasting: [],
      equipment: [],
    });
    delete bare.keyAbility;
    expect(validatePf2eActorCompleteV1(bare)).toEqual(bare);
  });

  const feat = (patch: Record<string, unknown>) => ({
    feats: [{ slug: "sudden-charge", location: "class-1", ...patch }],
  });
  const spells = (n: number) =>
    Array.from({ length: n }, () => ({ slug: "heal", rank: 1 }));

  it.each([
    ["unknown top-level key", { extra: 1 }],
    ["missing memberId", { memberId: undefined }],
    ["missing feats", { feats: undefined }],
    ["default as user", { foundryUserId: "default" }],
    ["bad user id", { foundryUserId: "user/1" }],
    ["bad actor id", { actorId: "actor 1" }],
    ["revision 0", { completionRevision: 0 }],
    ["fractional revision", { completionRevision: 1.5 }],
    ["level 0", { level: 0 }],
    ["level 21", { level: 21 }],
    ["boost level 2", { boosts: { "2": ["str"] } }],
    ["unknown attribute", { boosts: { "1": ["luck"] } }],
    ["repeated attribute", { boosts: { "1": ["str", "str"] } }],
    ["five boosts", { boosts: { "1": ["str", "dex", "con", "int", "wis"] } }],
    ["unknown ABC kind", { boostSelections: { heritage: ["str"] } }],
    ["bad key ability", { keyAbility: "luck" }],
    ["unknown skill", { skills: { lore: 1 } }],
    ["skill rank 5", { skills: { athletics: 5 } }],
    ["lore rank 0", { lores: [{ name: "Warfare Lore", rank: 0 }] }],
    ["lore name of 65", { lores: [{ name: "a".repeat(65), rank: 1 }] }],
    ["unknown lore key", { lores: [{ name: "A", rank: 1, mod: 2 }] }],
    [
      "17 lores",
      { lores: Array.from({ length: 17 }, () => ({ name: "A", rank: 1 })) },
    ],
    ["unknown feat key", feat({ system: {} })],
    ["feat location without level", feat({ location: "class" })],
    ["feat location level 21", feat({ location: "class-21" })],
    ["uppercase slug", feat({ slug: "Sudden-Charge" })],
    ["slug over 64 bytes", feat({ slug: "a".repeat(65) })],
    ["choices as array", feat({ choices: ["athletics"] })],
    ["choice flag with a dot", feat({ choices: { "a.b": "x" } })],
    ["choice value as number", feat({ choices: { a: 1 } })],
    [
      "65 feats",
      {
        feats: Array.from({ length: 65 }, () => ({
          slug: "a",
          location: "class-1",
        })),
      },
    ],
    [
      "unknown spellcasting key",
      {
        spellcasting: [
          { tradition: "arcane", kind: "prepared", spells: [], dc: 1 },
        ],
      },
    ],
    [
      "unknown tradition",
      {
        spellcasting: [{ tradition: "elemental", kind: "innate", spells: [] }],
      },
    ],
    [
      "unknown casting kind",
      { spellcasting: [{ tradition: "arcane", kind: "ritual", spells: [] }] },
    ],
    [
      "unknown spell key",
      {
        spellcasting: [
          {
            tradition: "arcane",
            kind: "innate",
            spells: [{ slug: "heal", rank: 1, uses: 1 }],
          },
        ],
      },
    ],
    [
      "spell rank 11",
      {
        spellcasting: [
          {
            tradition: "arcane",
            kind: "innate",
            spells: [{ slug: "heal", rank: 11 }],
          },
        ],
      },
    ],
    [
      "301 spells across entries",
      {
        spellcasting: [
          { tradition: "arcane", kind: "prepared", spells: spells(150) },
          { tradition: "divine", kind: "prepared", spells: spells(151) },
        ],
      },
    ],
    ["quantity 0", { equipment: [{ slug: "greataxe", quantity: 0 }] }],
    [
      "quantity 1 000 000",
      { equipment: [{ slug: "greataxe", quantity: 1_000_000 }] },
    ],
    [
      "201 equipment entries",
      {
        equipment: Array.from({ length: 201 }, () => ({
          slug: "a",
          quantity: 1,
        })),
      },
    ],
    [
      "a body over 40 KiB, otherwise valid",
      {
        feats: Array.from({ length: 64 }, () => ({
          slug: "assurance",
          location: "skill-2",
          choices: {
            a: "x".repeat(256),
            b: "x".repeat(256),
            c: "x".repeat(256),
          },
        })),
      },
    ],
  ])("refuses %s", (_label, patch) => {
    const payload: Record<string, unknown> = { ...request(), ...patch };
    for (const [key, value] of Object.entries(patch))
      if (value === undefined) delete payload[key];
    expect(() => validatePf2eActorCompleteV1(payload)).toThrowError(
      expect.objectContaining({ code: "invalid_args" }),
    );
  });

  it("refuses a non-object payload", () => {
    expect(() => validatePf2eActorCompleteV1([])).toThrowError(
      expect.objectContaining({ code: "invalid_args" }),
    );
  });
});

describe("pf2e.actor.complete.v1 gates", () => {
  it("refuses a non-GM responder before validating or touching the world", async () => {
    const actor = character();
    stubWorld([actor], { isGM: false });
    await expect(run({ junk: true })).rejects.toMatchObject({
      code: "permission_denied",
    });
    nothingWritten(actor);
  });

  it("refuses a pf2e below the floor", async () => {
    const actor = character();
    stubWorld([actor], { version: "8.6.0" });
    await expect(run(request())).rejects.toMatchObject({
      code: "unsupported_runtime",
      message:
        "pf2e.actor.complete.v1 requires pf2e 8.6.1 or later on Foundry 14",
    });
    nothingWritten(actor);
  });

  it.each([
    [
      "a missing Actor",
      (a: FakeActor): void => {
        a.id = "other00000000001";
      },
      "actor_not_found",
    ],
    [
      "a non-character Actor",
      (a: FakeActor): void => {
        a.type = "npc";
      },
      "binding_conflict",
    ],
    [
      "an unbound Actor",
      (a: FakeActor): void => {
        delete (a.flags[MODULE_ID] as Record<string, unknown>).binding;
      },
      "binding_conflict",
    ],
    [
      "an Actor bound to another character",
      (a: FakeActor) =>
        setPath(a.flags, `${MODULE_ID}.binding.characterId`, "character-2"),
      "binding_conflict",
    ],
    [
      "an adopted Actor the app did not create",
      (a: FakeActor) => {
        const flags = a.flags[MODULE_ID] as Record<string, unknown>;
        delete flags.pf2eUpsertCreatedV1;
        flags.pf2eUpsertV1 = {
          schemaVersion: 1,
          outcome: "adopted",
          appliedRevision: 1,
          appliedDigest: "d",
          warnings: [],
          equipmentCompleteness: "not_requested",
        };
      },
      "binding_conflict",
    ],
  ] as const)("refuses %s", async (_label, mutate, code) => {
    const actor = character();
    mutate(actor);
    stubWorld([actor]);
    await expect(run(request())).rejects.toMatchObject({ code });
    nothingWritten(actor);
  });

  it("accepts an Actor whose draft result records its creation", async () => {
    const actor = character();
    const flags = actor.flags[MODULE_ID] as Record<string, unknown>;
    delete flags.pf2eUpsertCreatedV1;
    flags.pf2eUpsertV1 = {
      schemaVersion: 1,
      outcome: "created",
      appliedRevision: 1,
      appliedDigest: "d",
      warnings: [],
      equipmentCompleteness: "complete",
    };
    stubWorld([actor]);
    await expect(run(request())).resolves.toMatchObject({
      completeness: "full",
    });
  });

  it.each([
    ["an OBSERVER", { [USER_ID]: 2 }, USER_ID],
    ["a user absent from the ownership map", {}, USER_ID],
    ["a GM, even as OWNER", { [GM_ID]: 3 }, GM_ID],
    [
      "the paired service user, even as OWNER",
      { [COMPANION_ID]: 3 },
      COMPANION_ID,
    ],
    ["a user not in the world", { nobody0000000001: 3 }, "nobody0000000001"],
  ])("refuses %s with permission_denied", async (_label, ownership, user) => {
    const actor = character();
    actor.ownership = { default: 3, ...ownership };
    stubWorld([actor]);
    await expect(run(request({ foundryUserId: user }))).rejects.toMatchObject({
      code: "permission_denied",
    });
    nothingWritten(actor);
  });

  it("refuses a level that differs from the Actor's, without writing", async () => {
    const actor = character();
    stubWorld([actor]);
    await expect(run(request({ level: 4 }))).rejects.toMatchObject({
      code: "level_mismatch",
    });
    nothingWritten(actor);
  });
});

describe("pf2e.actor.complete.v1 writes", () => {
  it("completes the build: one actor update, ABC choices, items per family, flag last", async () => {
    const actor = character();
    stubWorld([actor]);
    const result = await run(request());
    expect(result).toEqual({
      completeness: "full",
      warnings: [],
      written: { feats: 2, spells: 2, equipment: 1, lores: 1 },
    });
    // ONE actor update before the items: ranks raised only, level 1 boosts.
    expect(actor.updates[0]).toEqual({
      "system.skills.athletics.rank": 2,
      "system.skills.intimidation.rank": 1,
      "system.build.attributes.boosts.1": ["str", "dex", "con", "wis"],
    });
    expect(byId(actor, "ancestry00000001").update).toHaveBeenCalledWith({
      "system.boosts.0.selected": "str",
      "system.boosts.1.selected": "con",
    });
    // The narrowest open slot offering the attribute (pf2e's builder rule).
    expect(byId(actor, "background000001").update).toHaveBeenCalledWith({
      "system.boosts.0.selected": "str",
    });
    expect(byId(actor, "class00000000001").update).toHaveBeenCalledWith({
      "system.keyAbility.selected": "str",
    });
    // Families in order: feats, entries, spells, equipment, lores.
    const calls = actor.createEmbeddedDocuments.mock.calls.map((c) =>
      (c[1] as Array<{ type: string }>).map((i) => i.type),
    );
    expect(calls).toEqual([
      ["feat", "feat"],
      ["spellcastingEntry"],
      ["spell", "spell"],
      ["weapon"],
      ["lore"],
    ]);
    const items = created(actor);
    expect(items[0].system).toMatchObject({ location: "class-1" });
    expect(items[1].system).toMatchObject({ location: "skill-2" });
    const entryId = actor.items.contents.find(
      (i) => i.type === "spellcastingEntry",
    )!.id;
    expect(items[2]).toMatchObject({
      type: "spellcastingEntry",
      system: {
        slug: "primal-innate",
        tradition: { value: "primal" },
        prepared: { value: "innate" },
      },
    });
    expect(items[3].system).toMatchObject({ location: { value: entryId } });
    expect(
      (items[3].system as { location: Record<string, unknown> }).location,
    ).not.toHaveProperty("heightenedLevel");
    expect(items[4].system).toMatchObject({
      location: { value: entryId, heightenedLevel: 2 },
    });
    expect(items[5].system).toMatchObject({ quantity: 2 });
    expect(items[6]).toEqual({
      name: "Warfare Lore",
      type: "lore",
      system: { proficient: { value: 1 } },
    });
    // The completion flag is the last write, alone.
    expect(actor.events.at(-1)).toBe("update");
    expect(Object.keys(actor.updates.at(-1)!)).toEqual([
      `flags.${MODULE_ID}.pf2eCompleteV1`,
    ]);
    expect(storedFlag(actor)).toEqual({
      schemaVersion: 1,
      revision: 1,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      ...result,
    });
  });

  it("fetches every pack's documents in one request, not one per slug", async () => {
    stubWorld([character()]);
    await run(request());
    expect(requests.sort()).toEqual([
      "pf2e.equipment-srd",
      "pf2e.feats-srd",
      "pf2e.spells-srd",
    ]);
  });

  it("never writes system.abilities, a prepared path, level, HP or the ABC items' identity", async () => {
    const actor = character();
    stubWorld([actor]);
    await run(request());
    const allowed =
      /^(system\.skills\.[a-z]+\.rank|system\.build\.attributes\.boosts\.\d+|flags\.table-companion\.pf2eCompleteV1)$/;
    for (const update of actor.updates)
      for (const key of Object.keys(update)) expect(key).toMatch(allowed);
    for (const id of [
      "ancestry00000001",
      "background000001",
      "class00000000001",
    ])
      for (const [changes] of (
        byId(actor, id).update as ReturnType<typeof vi.fn>
      ).mock.calls)
        for (const key of Object.keys(changes as object))
          expect(key).toMatch(
            /^system\.(boosts\.\d+\.selected|keyAbility\.selected)$/,
          );
    expect(actor.system).not.toHaveProperty("abilities");
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("is additive: an existing feat, lore, item and choice survive untouched", async () => {
    const actor = character();
    actor.system.build = { attributes: { boosts: { "1": ["int", "cha"] } } };
    (
      byId(actor, "ancestry00000001").system as {
        boosts: Record<string, { selected?: string }>;
      }
    ).boosts["0"].selected = "int";
    (
      byId(actor, "class00000000001").system as Record<string, unknown>
    ).keyAbility = { value: ["str", "dex"], selected: "dex" };
    actor.items.contents.push(
      item({
        id: "gmfeat0000000001",
        type: "feat",
        system: { slug: "sudden-charge" },
      }),
      item({
        id: "gmlore0000000001",
        type: "lore",
        name: "warfare lore",
        system: {},
      }),
      item({
        id: "gmaxe00000000001",
        type: "weapon",
        system: { slug: "greataxe" },
      }),
    );
    const before = actor.items.contents.length;
    stubWorld([actor]);
    const result = await run(request());
    expect(result.warnings).toEqual([
      "item_present:sudden-charge",
      "item_present:greataxe",
      "item_present:warfare-lore",
      "boosts_present:1",
      "boost_skipped:ancestry:con",
      "key_ability_skipped:str",
    ]);
    expect(result.completeness).toBe("partial");
    expect(result.written).toEqual({
      feats: 1,
      spells: 2,
      equipment: 0,
      lores: 0,
    });
    expect(createdSlugs(actor)).not.toContain("sudden-charge");
    expect(actor.items.contents.length).toBe(before + 4);
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    // The boosts Foundry already holds are kept; the open ancestry slot only.
    expect(actor.updates[0]).not.toHaveProperty(
      "system.build.attributes.boosts.1",
    );
    expect(byId(actor, "ancestry00000001").update).toHaveBeenCalledWith({
      "system.boosts.1.selected": "str",
    });
    expect(
      (byId(actor, "class00000000001").update as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toEqual([]);
    // A rank Foundry holds higher is never lowered.
    expect(actor.updates[0]).not.toHaveProperty(
      "system.skills.acrobatics.rank",
    );
  });

  it("adds spells to an existing entry with the same slug instead of a second entry", async () => {
    const actor = character();
    actor.items.contents.push(
      item({
        id: "entry00000000001",
        type: "spellcastingEntry",
        system: { slug: "primal-innate" },
      }),
      item({
        id: "spell00000000001",
        type: "spell",
        system: { slug: "tanglefoot", location: { value: "entry00000000001" } },
      }),
    );
    stubWorld([actor]);
    const result = await run(request());
    expect(result.warnings).toEqual(["item_present:tanglefoot"]);
    expect(result.completeness).toBe("full");
    const types = created(actor).map((i) => i.type);
    expect(types).not.toContain("spellcastingEntry");
    expect(
      created(actor).find((i) => i.type === "spell")!.system,
    ).toMatchObject({
      slug: "heal",
      location: { value: "entry00000000001" },
    });
  });

  const unslugged = {
    spellcasting: [
      {
        tradition: "primal" as const,
        kind: "innate" as const,
        spells: [
          { slug: "tanglefoot", rank: 1 },
          { slug: "heal", rank: 2 },
        ],
      },
    ],
  };

  it("keys an entry sent without a slug on tradition-kind: a second completion doubles nothing", async () => {
    const actor = character();
    stubWorld([actor]);
    await run(request(unslugged));
    const second = await run(request({ ...unslugged, completionRevision: 2 }));
    const entries = actor.items.contents.filter(
      (i) => i.type === "spellcastingEntry",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].system).toMatchObject({ slug: "primal-innate" });
    expect(entries[0].name).toBe("primal innate spells");
    const spells = actor.items.contents
      .filter((i) => i.type === "spell")
      .map((i) => (i.system as { slug: string }).slug);
    expect(spells.sort()).toEqual(["heal", "tanglefoot"]);
    expect(second.written.spells).toBe(0);
    expect(second.warnings).toEqual(
      expect.arrayContaining(["item_present:tanglefoot", "item_present:heal"]),
    );
  });

  it("reuses a GM-made entry carrying the tradition-kind slug when the request sends none", async () => {
    const actor = character();
    actor.items.contents.push(
      item({
        id: "entry00000000001",
        type: "spellcastingEntry",
        system: { slug: "primal-innate" },
      }),
    );
    stubWorld([actor]);
    await run(request(unslugged));
    expect(created(actor).map((i) => i.type)).not.toContain(
      "spellcastingEntry",
    );
    expect(
      created(actor)
        .filter((i) => i.type === "spell")
        .map(
          (i) => (i.system as { location: { value: string } }).location.value,
        ),
    ).toEqual(["entry00000000001", "entry00000000001"]);
  });

  it("skips and warns item_not_found for a slug no pack carries", async () => {
    const actor = character();
    stubWorld([actor]);
    const result = await run(
      request({ feats: [{ slug: "no-such-feat", location: "class-1" }] }),
    );
    expect(result.warnings).toEqual(["item_not_found:no-such-feat"]);
    expect(result.completeness).toBe("partial");
    expect(result.written.feats).toBe(0);
  });

  it("skips unplaceable ABC boosts and a missing class with warnings", async () => {
    const actor = character();
    actor.items.contents = actor.items.contents.filter(
      (i) => i.type !== "class",
    );
    stubWorld([actor]);
    const result = await run(
      request({ boostSelections: { background: ["int", "wis"] } }),
    );
    expect(result.warnings).toEqual([
      "boost_skipped:background:wis",
      "abc_missing:class",
    ]);
    expect(byId(actor, "background000001").update).toHaveBeenCalledWith({
      "system.boosts.1.selected": "int",
    });
  });
});

describe("pf2e.actor.complete.v1 ChoiceSet pre-check", () => {
  it("embeds a feat whose ChoiceSet takes the matching preselection", async () => {
    const actor = character();
    stubWorld([actor]);
    await run(request());
    const assurance = created(actor).find(
      (i) => (i.system as { slug: string }).slug === "assurance",
    )!;
    expect((assurance.system as { rules: unknown[] }).rules).toEqual([
      expect.objectContaining({ key: "ChoiceSet", selection: "athletics" }),
    ]);
  });

  it.each([
    ["without a preselection", undefined],
    ["with a preselection not among its choices", { assurance: "thievery" }],
    ["with a preselection for another flag", { other: "athletics" }],
  ])("skips a feat %s and never embeds it", async (_label, choices) => {
    const actor = character();
    stubWorld([actor]);
    const result = await run(
      request({
        feats: [
          {
            slug: "assurance",
            location: "skill-2",
            ...(choices ? { choices } : {}),
          },
        ],
      }),
    );
    expect(result.warnings).toEqual(["item_skipped:assurance"]);
    expect(result.completeness).toBe("partial");
    expect(createdSlugs(actor)).not.toContain("assurance");
  });

  it("uses pf2e's default flag (the slug in dromedary case) when the rule names none", async () => {
    const content = packs();
    content["pf2e.feats-srd"].push(
      entry("natural-ambition", "feat", {
        rules: [{ key: "ChoiceSet", choices: { filter: [] } }],
      }),
    );
    const actor = character();
    stubWorld([actor], { packs: content });
    const result = await run(
      request({
        feats: [
          {
            slug: "natural-ambition",
            location: "ancestry-1",
            choices: { naturalAmbition: "Compendium.pf2e.feats-srd.Item.x" },
          },
        ],
      }),
    );
    expect(result.warnings).toEqual([]);
    expect(created(actor)[0].system).toMatchObject({
      rules: [{ selection: "Compendium.pf2e.feats-srd.Item.x" }],
    });
  });

  it("keeps a selection the pack already stores, and skips a spell or item with an open choice", async () => {
    const content = packs();
    content["pf2e.feats-srd"][0].source.system = {
      slug: "sudden-charge",
      rules: [{ key: "ChoiceSet", flag: "x", selection: "kept" }],
    };
    content["pf2e.equipment-srd"][0].source.system = {
      slug: "greataxe",
      rules: [{ key: "ChoiceSet", flag: "rune", choices: [] }],
    };
    const actor = character();
    stubWorld([actor], { packs: content });
    const result = await run(request());
    expect(result.warnings).toEqual(["item_skipped:greataxe"]);
    expect(created(actor)[0].system).toMatchObject({
      rules: [{ selection: "kept" }],
    });
  });
});

describe("pf2e.actor.complete.v1 replay", () => {
  it("replays the stored result for the same revision and content, writing nothing", async () => {
    const actor = character();
    stubWorld([actor]);
    const first = await run(request());
    const updates = actor.updates.length;
    const calls = actor.createEmbeddedDocuments.mock.calls.length;
    await expect(run(request())).resolves.toEqual(first);
    expect(actor.updates.length).toBe(updates);
    expect(actor.createEmbeddedDocuments.mock.calls.length).toBe(calls);
  });

  it("refuses an older revision as stale and other content at the same one as a conflict", async () => {
    const actor = character();
    stubWorld([actor]);
    await run(request({ completionRevision: 5 }));
    const updates = actor.updates.length;
    await expect(run(request({ completionRevision: 4 }))).rejects.toMatchObject(
      { code: "stale_revision" },
    );
    await expect(
      run(request({ completionRevision: 5, lores: [] })),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(actor.updates.length).toBe(updates);
  });

  it("applies a newer revision additively: nothing already written doubles", async () => {
    const actor = character();
    stubWorld([actor]);
    await run(request());
    const count = actor.items.contents.length;
    const result = await run(request({ completionRevision: 2 }));
    expect(actor.items.contents.length).toBe(count);
    expect(result.written).toEqual({
      feats: 0,
      spells: 0,
      equipment: 0,
      lores: 0,
    });
    expect(storedFlag(actor)).toMatchObject({ revision: 2 });
  });

  it("leaves the revision unrecorded when a write fails, so a re-send applies again", async () => {
    const actor = character();
    stubWorld([actor]);
    const create = actor.createEmbeddedDocuments.getMockImplementation() as (
      type: unknown,
      data: unknown,
    ) => unknown;
    const failing: (type: unknown, data: unknown) => unknown = (type, data) =>
      (data as Array<{ type: string }>)[0]?.type === "lore"
        ? Promise.reject(new Error("socket closed"))
        : create(type, data);
    actor.createEmbeddedDocuments.mockImplementation(failing);
    await expect(run(request())).rejects.toThrow("socket closed");
    expect(storedFlag(actor)).toBeUndefined();
    actor.createEmbeddedDocuments.mockImplementation(create);
    const retry = await run(request());
    expect(retry.written).toEqual({
      feats: 0,
      spells: 0,
      equipment: 0,
      lores: 1,
    });
    expect(storedFlag(actor)).toMatchObject({ revision: 1 });
  });
});
