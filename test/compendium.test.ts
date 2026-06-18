import { afterEach, describe, expect, it, vi } from "vitest";
import { compendiumIndex, compendiumGet } from "../src/procedures/compendium.js";

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
});
