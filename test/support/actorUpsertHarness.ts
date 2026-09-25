import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { KnightActorUpsertV1 } from "../../src/procedures/actorUpsert.js";
import { MODULE_ID } from "../../src/constants.js";
import { KNIGHT_COMPENDIUM_VERSION } from "../../src/refdata/knightCompendiumCrosswalkV14_0_1.js";

// Shared harness for the actor.upsert.v1 suites: a complete approved request, a
// fake Knight Actor that records every update, and a stubbed Foundry world
// (game, Actor.implementation, an optional Knight Compendium). Callers own
// `afterEach(() => vi.unstubAllGlobals())`.

export const USER_ID = "user000000000001";
export const ACTOR_ID = "actor00000000001";
export const CATALOG_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export interface KnightSchemaFixture {
  foundryGeneration: number;
  knightSystemVersion: string;
  actorCreateAPI: string;
  actor: { system: Record<string, unknown> };
  minorMotivationItem: { type: string; system: { description: string } };
}

export const KNIGHT_SCHEMA_FIXTURES = [13, 14].map(
  (generation) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../fixtures/knight-3.58.33-foundry${generation}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as KnightSchemaFixture,
);

export function approved(
  overrides: Partial<KnightActorUpsertV1> = {},
): KnightActorUpsertV1 {
  return {
    schemaVersion: 1,
    actorType: "knight",
    state: "approved",
    worldId: "world-1",
    tableId: "table-1",
    characterId: "character-1",
    approvedRevision: 1,
    name: "Lancelot",
    foundryUserId: USER_ID,
    profile: {
      description: "Chevalier solaire",
      limitedDescription: "Une silhouette d'or",
      history: "Ancien pilote",
      origin: "Europe",
      age: "32",
      archetype: "Héros",
      metaArmour: "Warrior",
      coatOfArms: "Lion",
      nickname: "Sol",
      section: "Dragon",
      highFeat: "Survivant",
      majorMotivation: "Protéger l'humanité",
      minorMotivations: [
        "Respecter le blason",
        "Tenir parole",
        "Protéger les faibles",
      ],
    },
    ai: { code: "AUBE", nickname: "Lux", personality: "Curieuse" },
    aspects: { chair: 3, bete: 2, machine: 4, dame: 3, masque: 2 },
    characteristics: {
      chair: { deplacement: 2, force: 3, endurance: 2 },
      bete: { combat: 3, hargne: 2, instinct: 1 },
      machine: { tir: 4, savoir: 2, technique: 3 },
      dame: { aura: 2, parole: 2, sangFroid: 3 },
      masque: { discretion: 1, dexterite: 2, perception: 3 },
    },
    resources: { health: 40, hope: 10, armour: 25, energy: 15, contact: 2 },
    equipment: {
      selections: [
        {
          catalogId: "knight.weapon.railgun",
          quantity: 1,
          slotAlternativeId: "handheld",
        },
      ],
    },
    characterCreation: {
      schemaVersion: 1,
      creationCatalogDigest: CATALOG_DIGEST,
      tarotCatalogDigest: CATALOG_DIGEST,
      richCatalogDigest: CATALOG_DIGEST,
      publicMetadata: {
        heroTarot: {
          cardIds: ["card-1", "card-2", "card-3", "card-4", "card-5"],
          advantageSourceIds: ["card-1", "card-2"],
          disadvantageSourceId: "card-3",
          roleplayLine: "Un passé public sans secret du MJ.",
        },
        derivedSources: {
          defense: "combat",
          reaction: "tir",
          initiative: "perception",
          health: "endurance",
          contact: "aura",
        },
      },
    },
    ...overrides,
  };
}

export function setPath(
  root: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== "object" || cursor[part] === null)
      cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

export function hasFixturePath(root: unknown, dotted: string): boolean {
  let cursor = root;
  for (const part of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null || !(part in cursor))
      return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return true;
}

export interface FakeActor {
  id: string;
  name: string;
  type: string;
  flags: Record<string, unknown>;
  ownership: Record<string, unknown>;
  system: Record<string, unknown>;
  items: { contents: Array<Record<string, unknown>> };
  updates: Array<Record<string, unknown>>;
  events: string[];
  update(changes: Record<string, unknown>): Promise<void>;
  prepareData(): void;
  createEmbeddedDocuments: ReturnType<typeof vi.fn>;
  deleteEmbeddedDocuments: ReturnType<typeof vi.fn>;
}

export function fakeActor(id = ACTOR_ID, name = "Existing"): FakeActor {
  const actor: FakeActor = {
    id,
    name,
    type: "knight",
    flags: {},
    ownership: {},
    system: {
      sante: { value: 1 },
      espoir: { value: 1 },
      contacts: { actuel: 1, value: 1 },
      equipements: { armure: { armure: { value: 1 }, energie: { value: 1 } } },
    },
    items: {
      contents: [{ name: "Foreign item", flags: { other: { owned: true } } }],
    },
    updates: [],
    events: [],
    update: async (changes) => {
      actor.events.push("update");
      actor.updates.push(changes);
      for (const [key, value] of Object.entries(changes)) {
        if (key === "name") actor.name = String(value);
        else if (key.startsWith("flags."))
          setPath(actor as unknown as Record<string, unknown>, key, value);
        else if (key === "ownership") {
          for (const [ownershipKey, level] of Object.entries(
            value as Record<string, unknown>,
          )) {
            if (ownershipKey.startsWith("-="))
              delete actor.ownership[ownershipKey.slice(2)];
            else actor.ownership[ownershipKey] = level;
          }
        } else if (key.startsWith("ownership."))
          setPath(actor as unknown as Record<string, unknown>, key, value);
        else if (key.startsWith("system."))
          setPath(actor as unknown as Record<string, unknown>, key, value);
      }
    },
    prepareData: () => actor.events.push("prepare"),
    createEmbeddedDocuments: vi.fn(
      async (_type, data: Record<string, unknown>[]) => {
        for (const source of data) {
          const item: Record<string, unknown> = {
            ...source,
            id: `item${String(actor.items.contents.length).padStart(12, "0")}`,
          };
          item.update = vi.fn(async (changes: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(changes))
              setPath(item, key, value);
          });
          actor.items.contents.push(item);
        }
      },
    ),
    deleteEmbeddedDocuments: vi.fn(async (_type, ids: string[]) => {
      actor.items.contents = actor.items.contents.filter(
        (item) => !ids.includes(String(item.id ?? item._id ?? "")),
      );
    }),
  };
  return actor;
}

export function binding(actor: FakeActor, req: KnightActorUpsertV1): void {
  actor.flags[MODULE_ID] = {
    binding: {
      schemaVersion: 1,
      worldId: req.worldId,
      tableId: req.tableId,
      characterId: req.characterId,
    },
  };
}

export interface StubCompendium {
  active?: boolean;
  version?: string;
  documents: Record<string, Record<string, Record<string, unknown>>>;
}

export function stubFoundry(
  actors: FakeActor[],
  create?: ReturnType<typeof vi.fn>,
  generation = 13,
  compendium?: StubCompendium,
): void {
  const collection = {
    contents: actors,
    get: (id: string) => actors.find((actor) => actor.id === id),
  };
  vi.stubGlobal("game", {
    user: { id: "gm", isGM: true },
    users: { get: (id: string) => (id === USER_ID ? { id } : undefined) },
    actors: collection,
    modules: {
      get: (id: string) =>
        id === "knight-compendium" && compendium
          ? {
              active: compendium.active ?? true,
              version: compendium.version ?? KNIGHT_COMPENDIUM_VERSION,
            }
          : undefined,
    },
    packs: {
      get: (pack: string) => {
        const documents = compendium?.documents[pack];
        if (!documents) return undefined;
        return {
          getDocument: async (id: string) => {
            const source = documents[id];
            return source
              ? { toObject: () => structuredClone(source) }
              : undefined;
          },
        };
      },
    },
    system: { id: "knight", version: "3.58.33" },
    release: { generation },
  });
  vi.stubGlobal("Actor", {
    implementation: {
      create:
        create ??
        vi.fn(async () => {
          const actor = fakeActor();
          actors.push(actor);
          return actor;
        }),
    },
  });
}
