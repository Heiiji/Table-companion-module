import { afterEach, describe, expect, it, vi } from "vitest";
import { compendiumIndex, compendiumGet } from "../src/procedures/compendium.js";
import { RpcError } from "../src/rpc/errors.js";
import { MAX_ENVELOPE_BYTES } from "../src/constants.js";

interface FakePack {
  collection: string;
  metadata: { id: string; label: string; type: string; system?: string };
  getIndex(): Promise<Array<Record<string, unknown>>>;
  getDocument(id: string): Promise<{ toObject(): unknown } | null>;
}

function setGame(): void {
  const bestiary: FakePack = {
    collection: "pf2e.pathfinder-bestiary",
    metadata: { id: "pathfinder-bestiary", label: "PF2e Bestiary", type: "Actor", system: "pf2e" },
    getIndex: async () => [
      { _id: "abc", name: "Goblin Warrior", img: "icons/goblin.png", type: "npc" },
      { _id: "def", name: "Hobgoblin Soldier", type: "npc" },
    ],
    getDocument: async (id: string) =>
      id === "abc" ? { toObject: () => ({ _id: "abc", name: "Goblin Warrior", type: "npc" }) } : null,
  };
  const spells: FakePack = {
    collection: "pf2e.spells-srd",
    metadata: { id: "spells-srd", label: "Spells", type: "Item", system: "pf2e" },
    getIndex: async () => [{ _id: "s1", name: "Fireball" }],
    getDocument: async () => null,
  };
  const packs: FakePack[] = [bestiary, spells];
  (packs as unknown as { get: (c: string) => FakePack | undefined }).get = (c) =>
    packs.find((p) => p.collection === c);
  vi.stubGlobal("game", { packs });
}

afterEach(() => vi.unstubAllGlobals());

describe("compendium.index", () => {
  it("lists creatures from Actor packs with pack-qualified ids", async () => {
    setGame();
    const result = (await compendiumIndex({ contentType: "creature" }, {} as never)) as {
      entries: Array<{ id: string; name: string; pack: string }>;
    };
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].id).toBe("pf2e.pathfinder-bestiary|abc");
    expect(result.entries.map((e) => e.name)).toContain("Hobgoblin Soldier");
    // The Item pack (spells) is excluded for the creature content type.
    expect(result.entries.every((e) => e.pack === "pf2e.pathfinder-bestiary")).toBe(true);
  });

  it("filters by name query (case-insensitive substring)", async () => {
    setGame();
    const result = (await compendiumIndex({ contentType: "creature", query: "warrior" }, {} as never)) as {
      entries: Array<{ name: string }>;
    };
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].name).toBe("Goblin Warrior");
  });

  it("skips packs whose declared system differs", async () => {
    setGame();
    const result = (await compendiumIndex({ contentType: "creature", system: "dnd5e" }, {} as never)) as {
      entries: unknown[];
    };
    expect(result.entries).toHaveLength(0);
  });
});

function setKnightGame(): void {
  const arsenal: FakePack = {
    collection: "world.knight-arsenal",
    metadata: { id: "knight-arsenal", label: "Knight Arsenal", type: "Item", system: "knight" },
    getIndex: async () => [
      { _id: "m2", name: "Nova", type: "module" },
      { _id: "m1", name: "Accélérateur", type: "module" },
      { _id: "w1", name: "Railgun", type: "arme" },
      { _id: "a1", name: "Warrior", type: "armure" },
      { _id: "x1", name: "Bond", type: "feature" }, // an Item that is NOT a Knight loadout subtype
    ],
    getDocument: async () => null,
  };
  const packs = [arsenal] as unknown as FakePack[] & { get: (c: string) => FakePack | undefined };
  packs.get = (c) => (c === "world.knight-arsenal" ? arsenal : undefined);
  vi.stubGlobal("game", { packs });
}

describe("compendium.index — Knight item subtype (§11.4)", () => {
  it("filters Item entries to the requested subtype", async () => {
    setKnightGame();
    const result = (await compendiumIndex({ contentType: "item", subtype: "module" }, {} as never)) as {
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
    const result = (await compendiumIndex({ contentType: "item" }, {} as never)) as {
      entries: Array<{ name: string }>;
    };
    expect(result.entries.map((e) => e.name)).toEqual(["Accélérateur", "Bond", "Nova", "Railgun", "Warrior"]);
  });

  it("reports total + truncated when the limit caps results", async () => {
    setKnightGame();
    const result = (await compendiumIndex({ contentType: "item", limit: 2 }, {} as never)) as {
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
    const result = (await compendiumGet({ id: "pf2e.pathfinder-bestiary|abc" }, {} as never)) as {
      id: string;
      document: { _id: string };
    };
    expect(result.id).toBe("pf2e.pathfinder-bestiary|abc");
    expect(result.document._id).toBe("abc");
  });

  it("throws on a malformed id", async () => {
    setGame();
    await expect(compendiumGet({ id: "no-separator" }, {} as never)).rejects.toThrow();
  });

  it("rejects an oversized document with payload_too_large", async () => {
    const huge = "x".repeat(MAX_ENVELOPE_BYTES + 1);
    const pack: FakePack = {
      collection: "world.big",
      metadata: { id: "big", label: "Big", type: "Actor" },
      getIndex: async () => [],
      getDocument: async () => ({ toObject: () => ({ _id: "z", blob: huge }) }),
    };
    const packs = [pack] as unknown as FakePack[] & { get: (c: string) => FakePack | undefined };
    packs.get = (c) => (c === "world.big" ? pack : undefined);
    vi.stubGlobal("game", { packs });

    try {
      await compendiumGet({ id: "world.big|z" }, {} as never);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe("payload_too_large");
    }
  });
});
