import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compendiumIndex,
  compendiumGet,
  scheduleCompendiumWarmup,
  warmCompendiumIndexes,
} from "../src/procedures/compendium.js";
import { RpcError } from "../src/rpc/errors.js";
import {
  MAX_ENVELOPE_BYTES,
  MODULE_ID,
  SETTING_AGENT_USER,
} from "../src/constants.js";

interface FakePack {
  collection: string;
  metadata: { id: string; label: string; type: string; system?: string };
  getIndex(): Promise<Array<Record<string, unknown>>>;
  getDocument(id: string): Promise<{ toObject(): unknown } | null>;
  testUserPermission?(user: { id?: string }, permission: string): boolean;
}

/** The paired service user the compendium permission is checked against. */
const AGENT = { id: "agentUser0000001", name: "Companion", isGM: false };

/** A pack the service user may observe (the Foundry default for PLAYER). */
function shared(pack: FakePack): FakePack {
  pack.testUserPermission = (user, permission) =>
    user.id === AGENT.id && permission === "OBSERVER";
  return pack;
}

/** A pack the GM hid from players (ownership below OBSERVER for PLAYER). */
function hidden(pack: FakePack): FakePack {
  pack.testUserPermission = () => false;
  return pack;
}

/** Stub `game` with these packs and the paired service user. `paired: false`
 * models a world whose agent has not paired yet. */
function stubWorld(
  list: FakePack[],
  opts: { paired?: boolean; gm?: boolean } = {},
): void {
  const packs = [...list] as FakePack[] & {
    get: (c: string) => FakePack | undefined;
  };
  packs.get = (c) => list.find((p) => p.collection === c);
  const paired = opts.paired ?? true;
  vi.stubGlobal("game", {
    user: { id: "gm1", isGM: opts.gm ?? true },
    packs,
    users: { get: (id: string) => (id === AGENT.id ? AGENT : undefined) },
    settings: {
      get: (ns: string, key: string) =>
        paired && ns === MODULE_ID && key === SETTING_AGENT_USER
          ? AGENT.id
          : "",
    },
  });
}

function setGame(): void {
  const bestiary: FakePack = {
    collection: "pf2e.pathfinder-bestiary",
    metadata: {
      id: "pathfinder-bestiary",
      label: "PF2e Bestiary",
      type: "Actor",
      system: "pf2e",
    },
    getIndex: async () => [
      {
        _id: "abc",
        name: "Goblin Warrior",
        img: "icons/goblin.png",
        type: "npc",
      },
      { _id: "def", name: "Hobgoblin Soldier", type: "npc" },
    ],
    getDocument: async (id: string) =>
      id === "abc"
        ? {
            toObject: () => ({
              _id: "abc",
              name: "Goblin Warrior",
              type: "npc",
            }),
          }
        : null,
  };
  const spells: FakePack = {
    collection: "pf2e.spells-srd",
    metadata: {
      id: "spells-srd",
      label: "Spells",
      type: "Item",
      system: "pf2e",
    },
    getIndex: async () => [{ _id: "s1", name: "Fireball" }],
    getDocument: async () => null,
  };
  stubWorld([shared(bestiary), shared(spells)]);
}

afterEach(() => vi.unstubAllGlobals());

describe("compendium.index", () => {
  it("lists creatures from Actor packs with pack-qualified ids", async () => {
    setGame();
    const result = (await compendiumIndex(
      { contentType: "creature" },
      {} as never,
    )) as {
      entries: Array<{ id: string; name: string; pack: string }>;
    };
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].id).toBe("pf2e.pathfinder-bestiary|abc");
    expect(result.entries.map((e) => e.name)).toContain("Hobgoblin Soldier");
    // The Item pack (spells) is excluded for the creature content type.
    expect(
      result.entries.every((e) => e.pack === "pf2e.pathfinder-bestiary"),
    ).toBe(true);
  });

  it("reads every pack index concurrently", async () => {
    let calls = 0;
    const releases: Array<() => void> = [];
    const slowPack = (collection: string, name: string): FakePack =>
      shared({
        collection,
        metadata: { id: collection, label: collection, type: "Actor" },
        getIndex: () => {
          calls += 1;
          return new Promise((resolve) =>
            releases.push(() => resolve([{ _id: name, name }])),
          );
        },
        getDocument: async () => null,
      });
    stubWorld([slowPack("world.a", "Alpha"), slowPack("world.b", "Beta")]);

    const pending = compendiumIndex({ contentType: "creature" }, {} as never);
    await Promise.resolve();
    expect(calls).toBe(2); // the second pack is asked before the first answers
    for (const release of releases) release();
    const res = (await pending) as { entries: Array<{ name: string }> };
    expect(res.entries.map((e) => e.name)).toEqual(["Alpha", "Beta"]);
  });

  it("filters by name query (case-insensitive substring)", async () => {
    setGame();
    const result = (await compendiumIndex(
      { contentType: "creature", query: "warrior" },
      {} as never,
    )) as {
      entries: Array<{ name: string }>;
    };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("Goblin Warrior");
  });

  it("skips packs whose declared system differs", async () => {
    setGame();
    const result = (await compendiumIndex(
      { contentType: "creature", system: "dnd5e" },
      {} as never,
    )) as {
      entries: unknown[];
    };
    expect(result.entries).toHaveLength(0);
  });
});

function setKnightGame(): void {
  const arsenal: FakePack = {
    collection: "world.knight-arsenal",
    metadata: {
      id: "knight-arsenal",
      label: "Knight Arsenal",
      type: "Item",
      system: "knight",
    },
    getIndex: async () => [
      { _id: "m2", name: "Nova", type: "module" },
      { _id: "m1", name: "Accélérateur", type: "module" },
      { _id: "w1", name: "Railgun", type: "arme" },
      { _id: "a1", name: "Warrior", type: "armure" },
      { _id: "x1", name: "Bond", type: "feature" }, // an Item that is NOT a Knight loadout subtype
    ],
    getDocument: async () => null,
  };
  stubWorld([shared(arsenal)]);
}

describe("compendium.index — Knight item subtype", () => {
  it("filters Item entries to the requested subtype", async () => {
    setKnightGame();
    const result = (await compendiumIndex(
      { contentType: "item", subtype: "module" },
      {} as never,
    )) as {
      entries: Array<{ name: string; type?: string }>;
      total: number;
      truncated: boolean;
    };
    expect(result.entries.map((e) => e.name)).toEqual(["Accélérateur", "Nova"]); // subtype-filtered + name-sorted
    expect(result.entries.every((e) => e.type === "module")).toBe(true);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("sorts entries stably by name then _id", async () => {
    setKnightGame();
    const result = (await compendiumIndex(
      { contentType: "item" },
      {} as never,
    )) as {
      entries: Array<{ name: string }>;
    };
    expect(result.entries.map((e) => e.name)).toEqual([
      "Accélérateur",
      "Bond",
      "Nova",
      "Railgun",
      "Warrior",
    ]);
  });

  it("reports total + truncated when the limit caps results", async () => {
    setKnightGame();
    const result = (await compendiumIndex(
      { contentType: "item", limit: 2 },
      {} as never,
    )) as {
      entries: unknown[];
      total: number;
      truncated: boolean;
    };
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });
});

describe("compendium.get", () => {
  it("returns the raw document for a pack-qualified id", async () => {
    setGame();
    const result = (await compendiumGet(
      { id: "pf2e.pathfinder-bestiary|abc" },
      {} as never,
    )) as {
      id: string;
      document: { _id: string };
    };
    expect(result.id).toBe("pf2e.pathfinder-bestiary|abc");
    expect(result.document._id).toBe("abc");
  });

  it("throws on a malformed id", async () => {
    setGame();
    await expect(
      compendiumGet({ id: "no-separator" }, {} as never),
    ).rejects.toThrow();
  });

  it("rejects an oversized document with payload_too_large", async () => {
    const huge = "x".repeat(MAX_ENVELOPE_BYTES + 1);
    const pack: FakePack = {
      collection: "world.big",
      metadata: { id: "big", label: "Big", type: "Actor" },
      getIndex: async () => [],
      getDocument: async () => ({ toObject: () => ({ _id: "z", blob: huge }) }),
    };
    stubWorld([shared(pack)]);

    try {
      await compendiumGet({ id: "world.big|z" }, {} as never);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe("payload_too_large");
    }
  });
});

describe("compendium permission gate", () => {
  const secret = (): FakePack => ({
    collection: "world.gm-secrets",
    metadata: { id: "gm-secrets", label: "GM secrets", type: "Actor" },
    getIndex: async () => [
      { _id: "boss", name: "The Real Villain", type: "npc" },
    ],
    getDocument: async () => ({ toObject: () => ({ _id: "boss" }) }),
  });

  it("leaves packs the service user cannot observe out of the index", async () => {
    stubWorld([hidden(secret())]);
    const result = (await compendiumIndex(
      { contentType: "creature" },
      {} as never,
    )) as {
      entries: unknown[];
    };
    expect(result.entries).toEqual([]);
  });

  it("answers a hidden pack exactly like an unknown one", async () => {
    stubWorld([hidden(secret())]);
    const settle = (id: string) =>
      Promise.resolve()
        .then(() => compendiumGet({ id }, {} as never))
        .catch((e: unknown) => e);
    const hiddenErr = await settle("world.gm-secrets|boss");
    const unknownErr = await settle("world.nope|boss");
    expect(hiddenErr).toBeInstanceOf(RpcError);
    expect((hiddenErr as RpcError).code).toBe("not_found");
    expect((hiddenErr as RpcError).message).toBe(
      (unknownErr as RpcError).message,
    );
    expect((unknownErr as RpcError).code).toBe("not_found");
  });

  it("serves only Actor and Item packs, whatever the service user may see", async () => {
    const journal = shared({
      collection: "world.lore",
      metadata: { id: "lore", label: "Lore", type: "JournalEntry" },
      getIndex: async () => [{ _id: "j1", name: "Plot" }],
      getDocument: async () => ({ toObject: () => ({ _id: "j1" }) }),
    });
    stubWorld([journal]);
    await expect(
      compendiumGet({ id: "world.lore|j1" }, {} as never),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("reads nothing before the agent has paired", async () => {
    stubWorld([shared(secret())], { paired: false });
    const result = (await compendiumIndex(
      { contentType: "creature" },
      {} as never,
    )) as {
      entries: unknown[];
    };
    expect(result.entries).toEqual([]);
  });
});

describe("compendium index warm-up", () => {
  /** A pack whose index, like Foundry's, is loaded from the server once and
   * then served from the pack's cache. `release()` answers a pending load. */
  function cachingPack(collection: string, name: string) {
    let index: Array<Record<string, unknown>> | undefined;
    const pending: Array<() => void> = [];
    const pack = shared({
      collection,
      metadata: { id: collection, label: collection, type: "Actor" },
      getIndex: () =>
        index
          ? Promise.resolve(index)
          : new Promise((resolve) =>
              pending.push(() => resolve((index = [{ _id: name, name }]))),
            ),
      getDocument: async () => null,
    });
    return { pack, loads: () => pending.length, release: () => pending[0]() };
  }

  it("loads each readable pack index one after another, so the first search is warm", async () => {
    const a = cachingPack("world.a", "Alpha");
    const b = cachingPack("world.b", "Beta");
    const secret = hidden({
      collection: "world.secret",
      metadata: { id: "secret", label: "Secret", type: "Actor" },
      getIndex: vi.fn(async () => []),
      getDocument: async () => null,
    });
    const broken = shared({
      collection: "world.broken",
      metadata: { id: "broken", label: "Broken", type: "Item" },
      getIndex: () => Promise.reject(new Error("server said no")),
      getDocument: async () => null,
    });
    stubWorld([broken, a.pack, secret, b.pack]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const warming = warmCompendiumIndexes();
      await vi.waitFor(() => expect(a.loads()).toBe(1));
      expect(b.loads()).toBe(0); // one pack at a time
      a.release();
      await vi.waitFor(() => expect(b.loads()).toBe(1));
      b.release();
      await warming;
      expect(secret.getIndex).not.toHaveBeenCalled(); // never a hidden pack
      expect(warn).toHaveBeenCalledTimes(1); // a failing pack is skipped

      // The request now reads the cache: no new load, same answer.
      const res = (await compendiumIndex(
        { contentType: "creature" },
        {} as never,
      )) as { entries: Array<{ name: string }> };
      expect(a.loads() + b.loads()).toBe(2);
      expect(res.entries.map((e) => e.name)).toEqual(["Alpha", "Beta"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("starts 15 s after ready, on a Gamemaster's browser only", () => {
    vi.useFakeTimers();
    try {
      const getIndex = vi.fn(async () => []);
      const pack = (): FakePack =>
        shared({
          collection: "world.a",
          metadata: { id: "a", label: "A", type: "Actor" },
          getIndex,
          getDocument: async () => null,
        });
      stubWorld([pack()], { gm: false });
      scheduleCompendiumWarmup();
      vi.advanceTimersByTime(60_000);
      expect(getIndex).not.toHaveBeenCalled();

      stubWorld([pack()]);
      scheduleCompendiumWarmup();
      vi.advanceTimersByTime(14_999);
      expect(getIndex).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(getIndex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
