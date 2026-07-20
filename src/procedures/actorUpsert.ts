import { MODULE_ID } from "../constants.js";
import { RpcError } from "../rpc/errors.js";
import { canonicalize } from "../rpc/responseSigning.js";
import type { Procedure } from "../rpc/registry.js";
import {
  KNIGHT_COMPENDIUM_MODULE_ID,
  KNIGHT_COMPENDIUM_VERSION,
  KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1,
  type KnightEquipmentCrosswalkDocumentV1,
} from "../refdata/knightCompendiumCrosswalkV14_0_1.js";
import { supportsKnightActorUpsertV1Runtime } from "./foundry.js";

const SCHEMA_VERSION = 1;
const ACTOR_TYPE = "knight";
const OWNER_LEVEL = 3;
const NONE_LEVEL = 0;
const utf8 = new TextEncoder();

type Dict = Record<string, unknown>;
type State = "draft" | "approved";
type Outcome = "created" | "adopted" | "updated";
type EquipmentCompleteness = "not_requested" | "complete" | "partial";

interface ProfileV1 {
  description: string;
  limitedDescription: string;
  history: string;
  origin: string;
  age: string;
  archetype: string;
  metaArmour: string;
  coatOfArms: string;
  nickname: string;
  section: string;
  highFeat: string;
  majorMotivation: string;
  minorMotivations: string[];
}

interface AIV1 {
  code: string;
  nickname: string;
  personality: string;
}

interface AspectsV1 {
  chair: number;
  bete: number;
  machine: number;
  dame: number;
  masque: number;
}

interface CharacteristicsV1 {
  chair: { deplacement: number; force: number; endurance: number };
  bete: { combat: number; hargne: number; instinct: number };
  machine: { tir: number; savoir: number; technique: number };
  dame: { aura: number; parole: number; sangFroid: number };
  masque: { discretion: number; dexterite: number; perception: number };
}

interface CurrentResourcesV1 {
  health?: number;
  hope?: number;
  armour?: number;
  energy?: number;
  contact?: number;
}

interface CharacterCreationV1 {
  schemaVersion: 1;
  creationCatalogDigest: string;
  tarotCatalogDigest: string;
  richCatalogDigest: string;
  publicMetadata: {
    heroTarot: {
      cardIds: string[];
      advantageSourceIds: string[];
      disadvantageSourceId?: string;
      roleplayLine: string;
    };
    derivedSources: {
      defense: string;
      reaction: string;
      initiative: string;
      health: string;
      contact: string;
    };
  };
}

interface EquipmentSelectionV1 {
  catalogId: string;
  quantity: number;
  slotAlternativeId?: string;
  parentCatalogId?: string;
}

interface EquipmentV1 {
  selections: EquipmentSelectionV1[];
}

interface StoredCharacterCreationV1 extends CharacterCreationV1 {
  approvedRevision: number;
}

export interface KnightActorUpsertV1 {
  schemaVersion: 1;
  actorType: "knight";
  state: State;
  worldId: string;
  tableId: string;
  characterId: string;
  approvedRevision: number;
  name: string;
  foundryUserId?: string;
  assignedActorId?: string;
  expectedActorId?: string;
  profile?: ProfileV1;
  ai?: AIV1;
  aspects?: AspectsV1;
  characteristics?: CharacteristicsV1;
  resources?: CurrentResourcesV1;
  equipment?: EquipmentV1;
  characterCreation?: CharacterCreationV1;
}

export interface ActorUpsertResultV1 {
  schemaVersion: 1;
  resultDocId: string;
  outcome: Outcome;
  appliedRevision: number;
  appliedDigest: string;
  equipmentCompleteness: EquipmentCompleteness;
  warnings: string[];
}

interface BindingV1 {
  schemaVersion: 1;
  worldId: string;
  tableId: string;
  characterId: string;
}

interface SyncV1 extends ActorUpsertResultV1 {
  state: State;
}

interface ActorLike {
  id?: string;
  _id?: string;
  name?: string;
  type?: string;
  flags?: Dict;
  ownership?: Dict;
  system?: unknown;
  items?: { contents?: ActorItemLike[] } | Iterable<ActorItemLike>;
  getFlag?(namespace: string, key: string): unknown;
  update(changes: Dict): Promise<unknown>;
  prepareData?(): void;
  createEmbeddedDocuments?(type: "Item", data: Dict[]): Promise<unknown>;
  deleteEmbeddedDocuments?(type: "Item", ids: string[]): Promise<unknown>;
}

interface ActorItemLike {
  id?: string;
  _id?: string;
  type?: string;
  system?: unknown;
  getFlag?(namespace: string, key: string): unknown;
  flags?: Dict;
  update?(changes: Dict): Promise<unknown>;
}

interface ActorsLike {
  contents?: ActorLike[];
  get(id: string): ActorLike | undefined;
  [Symbol.iterator]?(): Iterator<ActorLike>;
}

interface UserCollectionLike {
  get(id: string): unknown;
}

interface PackLike {
  getDocument(id: string): Promise<{ toObject(): unknown } | null | undefined>;
}

interface PacksLike {
  get(id: string): PackLike | undefined;
}

interface ModuleLike {
  active?: boolean;
  version?: string;
}

interface ModulesLike {
  get(id: string): ModuleLike | undefined;
}

interface EquipmentCatalogSourceV1 {
  schemaVersion: 1;
  pack: string;
  documentId: string;
  compendiumVersion: string;
  knightSystemVersion: string;
}

interface EquipmentCatalogVariantV1 {
  schemaVersion: 1;
  catalogIds: string[];
  quantity: number;
  instanceIndex: number;
  slotAlternativeId?: string;
  parentCatalogId?: string;
  moduleLevel?: 1 | 2 | 3;
}

function invalid(message: string): never {
  throw new RpcError("invalid_args", message);
}

function record(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Dict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object`);
  }
  const out = value as Dict;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(out)) {
    if (!allowedSet.has(key)) invalid(`${path}.${key} is not allowed`);
  }
  return out;
}

function text(
  value: unknown,
  path: string,
  max: number,
  required = false,
): string {
  if (typeof value !== "string") return invalid(`${path} must be a string`);
  if (
    value.includes("\0") ||
    [...value].length > max ||
    (required && value.trim() === "")
  ) {
    return invalid(`${path} is empty, too long, or contains NUL`);
  }
  return value;
}

function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    return invalid(`${path} must be an integer in ${min}-${max}`);
  }
  return value as number;
}

function identifier(value: unknown, path: string, pattern: RegExp): string {
  const id = text(value, path, 128, true);
  if (!pattern.test(id))
    return invalid(`${path} has an invalid identifier shape`);
  return id;
}

const bindingId = /^[A-Za-z0-9._-]{1,128}$/;
const foundryId = /^[A-Za-z0-9_-]{1,64}$/;
const catalogId = /^[A-Za-z0-9._:-]{1,128}$/;
const catalogDigest = /^sha256:[0-9a-f]{64}$/;

function optionalFoundryId(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : identifier(value, path, foundryId);
}

function parseProfile(value: unknown): ProfileV1 {
  const keys = [
    "description",
    "limitedDescription",
    "history",
    "origin",
    "age",
    "archetype",
    "metaArmour",
    "coatOfArms",
    "nickname",
    "section",
    "highFeat",
    "majorMotivation",
    "minorMotivations",
  ] as const;
  const p = record(value, "profile", keys);
  return {
    description: text(p.description, "profile.description", 8_000),
    limitedDescription: text(
      p.limitedDescription,
      "profile.limitedDescription",
      2_000,
    ),
    history: text(p.history, "profile.history", 8_000),
    origin: text(p.origin, "profile.origin", 200),
    age: text(p.age, "profile.age", 100),
    archetype: text(p.archetype, "profile.archetype", 200),
    metaArmour: text(p.metaArmour, "profile.metaArmour", 200),
    coatOfArms: text(p.coatOfArms, "profile.coatOfArms", 200),
    nickname: text(p.nickname, "profile.nickname", 200),
    section: text(p.section, "profile.section", 200),
    highFeat: text(p.highFeat, "profile.highFeat", 200),
    majorMotivation: text(p.majorMotivation, "profile.majorMotivation", 2_000),
    minorMotivations: (() => {
      if (!Array.isArray(p.minorMotivations) || p.minorMotivations.length > 5)
        return invalid(
          "profile.minorMotivations must contain at most five entries",
        );
      return p.minorMotivations.map((motivation, index) =>
        text(motivation, `profile.minorMotivations[${index}]`, 2_000, true),
      );
    })(),
  };
}

function parseCharacterCreation(value: unknown): CharacterCreationV1 {
  const p = record(value, "characterCreation", [
    "schemaVersion",
    "creationCatalogDigest",
    "tarotCatalogDigest",
    "richCatalogDigest",
    "publicMetadata",
  ]);
  if (p.schemaVersion !== 1)
    invalid("characterCreation.schemaVersion must be 1");
  const digest = (
    key: "creationCatalogDigest" | "tarotCatalogDigest" | "richCatalogDigest",
  ) => {
    const value = text(p[key], `characterCreation.${key}`, 71, true);
    if (!catalogDigest.test(value))
      invalid(`characterCreation.${key} must be sha256:<64 lowercase hex>`);
    return value;
  };
  const metadata = record(
    p.publicMetadata,
    "characterCreation.publicMetadata",
    ["heroTarot", "derivedSources"],
  );
  const hero = record(
    metadata.heroTarot,
    "characterCreation.publicMetadata.heroTarot",
    ["cardIds", "advantageSourceIds", "disadvantageSourceId", "roleplayLine"],
  );
  const parseIDs = (value: unknown, path: string, count: number): string[] => {
    if (!Array.isArray(value) || value.length !== count)
      return invalid(`${path} must contain exactly ${count} entries`);
    const ids = value.map((entry, index) =>
      identifier(entry, `${path}[${index}]`, catalogId),
    );
    if (new Set(ids).size !== ids.length)
      invalid(`${path} contains duplicates`);
    return ids;
  };
  const cardIds = parseIDs(
    hero.cardIds,
    "characterCreation.publicMetadata.heroTarot.cardIds",
    5,
  );
  if (
    !Array.isArray(hero.advantageSourceIds) ||
    hero.advantageSourceIds.length > 2
  )
    invalid(
      "characterCreation.publicMetadata.heroTarot.advantageSourceIds must contain at most two public entries",
    );
  const advantageSourceIds = hero.advantageSourceIds.map((entry, index) =>
    identifier(
      entry,
      `characterCreation.publicMetadata.heroTarot.advantageSourceIds[${index}]`,
      catalogId,
    ),
  );
  if (new Set(advantageSourceIds).size !== advantageSourceIds.length)
    invalid(
      "characterCreation.publicMetadata.heroTarot.advantageSourceIds contains duplicates",
    );
  const disadvantageSourceId =
    hero.disadvantageSourceId === undefined || hero.disadvantageSourceId === ""
      ? undefined
      : identifier(
          hero.disadvantageSourceId,
          "characterCreation.publicMetadata.heroTarot.disadvantageSourceId",
          catalogId,
        );
  const dealt = new Set(cardIds);
  for (const id of [
    ...advantageSourceIds,
    ...(disadvantageSourceId ? [disadvantageSourceId] : []),
  ]) {
    if (!dealt.has(id))
      invalid(
        "public Hero Tarot selection must come from the five dealt cards",
      );
  }
  const derived = record(
    metadata.derivedSources,
    "characterCreation.publicMetadata.derivedSources",
    ["defense", "reaction", "initiative", "health", "contact"],
  );
  const source = (
    key: "defense" | "reaction" | "initiative" | "health" | "contact",
  ) =>
    identifier(
      derived[key],
      `characterCreation.publicMetadata.derivedSources.${key}`,
      catalogId,
    );
  return {
    schemaVersion: 1,
    creationCatalogDigest: digest("creationCatalogDigest"),
    tarotCatalogDigest: digest("tarotCatalogDigest"),
    richCatalogDigest: digest("richCatalogDigest"),
    publicMetadata: {
      heroTarot: {
        cardIds,
        advantageSourceIds,
        ...(disadvantageSourceId ? { disadvantageSourceId } : {}),
        roleplayLine: (() => {
          const line = text(
            hero.roleplayLine,
            "characterCreation.publicMetadata.heroTarot.roleplayLine",
            4_000,
          );
          return line;
        })(),
      },
      derivedSources: {
        defense: source("defense"),
        reaction: source("reaction"),
        initiative: source("initiative"),
        health: source("health"),
        contact: source("contact"),
      },
    },
  };
}

function parseAI(value: unknown): AIV1 {
  const p = record(value, "ai", ["code", "nickname", "personality"]);
  return {
    code: text(p.code, "ai.code", 200),
    nickname: text(p.nickname, "ai.nickname", 200),
    personality: text(p.personality, "ai.personality", 2_000),
  };
}

function base(value: unknown, path: string): number {
  return integer(value, path, 0, 20);
}

function parseAspects(value: unknown): AspectsV1 {
  const p = record(value, "aspects", [
    "chair",
    "bete",
    "machine",
    "dame",
    "masque",
  ]);
  return {
    chair: base(p.chair, "aspects.chair"),
    bete: base(p.bete, "aspects.bete"),
    machine: base(p.machine, "aspects.machine"),
    dame: base(p.dame, "aspects.dame"),
    masque: base(p.masque, "aspects.masque"),
  };
}

function parseCharacteristics(value: unknown): CharacteristicsV1 {
  const p = record(value, "characteristics", [
    "chair",
    "bete",
    "machine",
    "dame",
    "masque",
  ]);
  const chair = record(p.chair, "characteristics.chair", [
    "deplacement",
    "force",
    "endurance",
  ]);
  const bete = record(p.bete, "characteristics.bete", [
    "combat",
    "hargne",
    "instinct",
  ]);
  const machine = record(p.machine, "characteristics.machine", [
    "tir",
    "savoir",
    "technique",
  ]);
  const dame = record(p.dame, "characteristics.dame", [
    "aura",
    "parole",
    "sangFroid",
  ]);
  const masque = record(p.masque, "characteristics.masque", [
    "discretion",
    "dexterite",
    "perception",
  ]);
  return {
    chair: {
      deplacement: base(chair.deplacement, "characteristics.chair.deplacement"),
      force: base(chair.force, "characteristics.chair.force"),
      endurance: base(chair.endurance, "characteristics.chair.endurance"),
    },
    bete: {
      combat: base(bete.combat, "characteristics.bete.combat"),
      hargne: base(bete.hargne, "characteristics.bete.hargne"),
      instinct: base(bete.instinct, "characteristics.bete.instinct"),
    },
    machine: {
      tir: base(machine.tir, "characteristics.machine.tir"),
      savoir: base(machine.savoir, "characteristics.machine.savoir"),
      technique: base(machine.technique, "characteristics.machine.technique"),
    },
    dame: {
      aura: base(dame.aura, "characteristics.dame.aura"),
      parole: base(dame.parole, "characteristics.dame.parole"),
      sangFroid: base(dame.sangFroid, "characteristics.dame.sangFroid"),
    },
    masque: {
      discretion: base(masque.discretion, "characteristics.masque.discretion"),
      dexterite: base(masque.dexterite, "characteristics.masque.dexterite"),
      perception: base(masque.perception, "characteristics.masque.perception"),
    },
  };
}

function parseResources(value: unknown): CurrentResourcesV1 {
  const p = record(value, "resources", [
    "health",
    "hope",
    "armour",
    "energy",
    "contact",
  ]);
  const out: CurrentResourcesV1 = {};
  for (const key of [
    "health",
    "hope",
    "armour",
    "energy",
    "contact",
  ] as const) {
    if (p[key] !== undefined)
      out[key] = integer(p[key], `resources.${key}`, 0, 100_000);
  }
  return out;
}

const canonicalSlotOrder = [
  "tete",
  "bras_gauche",
  "bras_droit",
  "torse",
  "jambe_gauche",
  "jambe_droite",
] as const;

function canonicalSlotAlternative(value: unknown, path: string): string {
  const raw = text(value, path, 256, true);
  if (raw === "handheld") return raw;
  let previous = -1;
  for (const part of raw.split("+")) {
    const match = /^([a-z_]+)=([1-9][0-9]*)$/.exec(part);
    if (!match) invalid(`${path} is not a canonical slot allocation`);
    const position = canonicalSlotOrder.indexOf(
      match[1] as (typeof canonicalSlotOrder)[number],
    );
    const quantity = Number(match[2]);
    if (
      position <= previous ||
      position < 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity > 99 ||
      String(quantity) !== match[2]
    )
      invalid(`${path} is not a canonical slot allocation`);
    previous = position;
  }
  return raw;
}

function parseEquipment(value: unknown): EquipmentV1 {
  const p = record(value, "equipment", ["selections"]);
  if (!Array.isArray(p.selections) || p.selections.length > 64) {
    return invalid(
      "equipment.selections must be an array with at most 64 entries",
    );
  }
  let totalQuantity = 0;
  const seen = new Set<string>();
  const selections = p.selections.map((value, index) => {
    const path = `equipment.selections[${index}]`;
    const row = record(value, path, [
      "catalogId",
      "quantity",
      "slotAlternativeId",
      "parentCatalogId",
    ]);
    const selection: EquipmentSelectionV1 = {
      catalogId: identifier(row.catalogId, `${path}.catalogId`, catalogId),
      quantity: integer(row.quantity, `${path}.quantity`, 1, 10),
      slotAlternativeId:
        row.slotAlternativeId === undefined
          ? undefined
          : canonicalSlotAlternative(
              row.slotAlternativeId,
              `${path}.slotAlternativeId`,
            ),
      parentCatalogId:
        row.parentCatalogId === undefined
          ? undefined
          : identifier(
              row.parentCatalogId,
              `${path}.parentCatalogId`,
              catalogId,
            ),
    };
    totalQuantity += selection.quantity;
    const key = [
      selection.catalogId,
      selection.slotAlternativeId ?? "",
      selection.parentCatalogId ?? "",
    ].join("|");
    if (seen.has(key)) invalid("equipment.selections contains duplicates");
    seen.add(key);
    return selection;
  });
  if (totalQuantity > 64)
    invalid("equipment.selections total quantity exceeds 64");
  return { selections };
}

export function validateKnightActorUpsertV1(
  payload: unknown,
): KnightActorUpsertV1 {
  const keys = [
    "schemaVersion",
    "actorType",
    "state",
    "worldId",
    "tableId",
    "characterId",
    "approvedRevision",
    "name",
    "foundryUserId",
    "assignedActorId",
    "expectedActorId",
    "profile",
    "ai",
    "aspects",
    "characteristics",
    "resources",
    "equipment",
    "characterCreation",
  ] as const;
  const p = record(payload, "actorUpsert", keys);
  if (p.schemaVersion !== SCHEMA_VERSION) invalid("schemaVersion must be 1");
  if (p.actorType !== ACTOR_TYPE) invalid("actorType must be knight");
  if (p.state !== "draft" && p.state !== "approved")
    invalid("state must be draft or approved");
  const state = p.state as State;
  const approvedRevision = integer(
    p.approvedRevision,
    "approvedRevision",
    0,
    2_147_483_647,
  );
  if (state === "approved" && approvedRevision < 1)
    invalid("approved state requires revision >= 1");
  const assignedActorId = optionalFoundryId(
    p.assignedActorId,
    "assignedActorId",
  );
  const expectedActorId = optionalFoundryId(
    p.expectedActorId,
    "expectedActorId",
  );
  const foundryUserId = optionalFoundryId(p.foundryUserId, "foundryUserId");
  if (foundryUserId === "default")
    invalid("foundryUserId cannot be the reserved ownership key default");
  if (
    assignedActorId &&
    expectedActorId &&
    assignedActorId !== expectedActorId
  ) {
    invalid("assignedActorId cannot replace a different expectedActorId");
  }
  if (
    state === "approved" &&
    (p.profile === undefined ||
      p.aspects === undefined ||
      p.characteristics === undefined ||
      p.characterCreation === undefined)
  ) {
    invalid(
      "approved actors require profile, aspects, characteristics, and characterCreation",
    );
  }
  const profile = p.profile === undefined ? undefined : parseProfile(p.profile);
  if (state === "approved" && profile!.minorMotivations.length === 0)
    invalid(
      "approved profile.minorMotivations must contain at least one entry",
    );
  return {
    schemaVersion: 1,
    actorType: "knight",
    state,
    worldId: identifier(p.worldId, "worldId", bindingId),
    tableId: identifier(p.tableId, "tableId", bindingId),
    characterId: identifier(p.characterId, "characterId", bindingId),
    approvedRevision,
    name: text(p.name, "name", 200, true),
    foundryUserId,
    assignedActorId,
    expectedActorId,
    profile,
    ai: p.ai === undefined ? undefined : parseAI(p.ai),
    aspects: p.aspects === undefined ? undefined : parseAspects(p.aspects),
    characteristics:
      p.characteristics === undefined
        ? undefined
        : parseCharacteristics(p.characteristics),
    resources:
      p.resources === undefined ? undefined : parseResources(p.resources),
    equipment:
      p.equipment === undefined ? undefined : parseEquipment(p.equipment),
    characterCreation:
      p.characterCreation === undefined
        ? undefined
        : parseCharacterCreation(p.characterCreation),
  };
}

function currentGame(): {
  user?: { isGM?: boolean };
  users?: UserCollectionLike;
  actors?: ActorsLike;
  packs?: PacksLike;
  modules?: ModulesLike;
  system?: { id?: string };
  release?: { generation?: number };
  version?: string;
} {
  return (
    (globalThis as unknown as { game?: ReturnType<typeof currentGame> }).game ??
    {}
  );
}

function assertRuntimeAndAuthority(req: KnightActorUpsertV1): void {
  const g = currentGame();
  if (!g.user?.isGM)
    throw new RpcError(
      "permission_denied",
      "actor.upsert.v1 requires a GM responder",
    );
  if (!supportsKnightActorUpsertV1Runtime()) {
    throw new RpcError(
      "unsupported_runtime",
      "actor.upsert.v1 requires Knight 3.58.33 on Foundry 13 or 14",
    );
  }
  if (req.foundryUserId && !g.users?.get(req.foundryUserId))
    invalid("foundryUserId is not a User in this world");
}

function actorCollection(): ActorsLike {
  const actors = currentGame().actors;
  if (!actors)
    throw new RpcError(
      "unsupported_runtime",
      "Foundry game.actors is unavailable",
    );
  return actors;
}

function allActors(collection: ActorsLike): ActorLike[] {
  if (Array.isArray(collection.contents)) return collection.contents;
  const iterator = collection[Symbol.iterator];
  if (iterator)
    return [
      ...({
        [Symbol.iterator]: iterator.bind(collection),
      } as Iterable<ActorLike>),
    ];
  return [];
}

function actorID(actor: ActorLike): string {
  return actor.id ?? actor._id ?? "";
}

function flagValue(actor: ActorLike | ActorItemLike, key: string): unknown {
  if (typeof actor.getFlag === "function") return actor.getFlag(MODULE_ID, key);
  const namespace = actor.flags?.[MODULE_ID];
  return typeof namespace === "object" && namespace !== null
    ? (namespace as Dict)[key]
    : undefined;
}

function bindingOf(actor: ActorLike): BindingV1 | null {
  const value = flagValue(actor, "binding");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    typeof p.worldId !== "string" ||
    typeof p.tableId !== "string" ||
    typeof p.characterId !== "string"
  )
    return null;
  return {
    schemaVersion: 1,
    worldId: p.worldId,
    tableId: p.tableId,
    characterId: p.characterId,
  };
}

function syncOf(actor: ActorLike): SyncV1 | null {
  const value = flagValue(actor, "actorUpsertV1");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    (p.state !== "draft" && p.state !== "approved") ||
    !Number.isSafeInteger(p.appliedRevision) ||
    typeof p.appliedDigest !== "string" ||
    !["created", "adopted", "updated"].includes(String(p.outcome)) ||
    !["not_requested", "complete", "partial"].includes(
      String(p.equipmentCompleteness),
    ) ||
    !Array.isArray(p.warnings) ||
    !p.warnings.every((w) => typeof w === "string")
  )
    return null;
  return {
    schemaVersion: 1,
    state: p.state,
    resultDocId: actorID(actor),
    outcome: p.outcome as Outcome,
    appliedRevision: p.appliedRevision as number,
    appliedDigest: p.appliedDigest,
    equipmentCompleteness: p.equipmentCompleteness as EquipmentCompleteness,
    warnings: p.warnings as string[],
  };
}

async function canonicalDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8.encode(canonicalize(value)),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createActor(
  req: KnightActorUpsertV1,
  binding: BindingV1,
): Promise<ActorLike> {
  const factory = (
    globalThis as unknown as {
      Actor?: {
        implementation?: {
          create(data: Dict, options?: Dict): Promise<unknown>;
        };
      };
    }
  ).Actor?.implementation;
  if (!factory?.create)
    throw new RpcError(
      "unsupported_runtime",
      "Actor.implementation.create is unavailable",
    );
  const created = await factory.create(
    {
      name: req.name,
      type: ACTOR_TYPE,
      flags: { [MODULE_ID]: { binding } },
      ownership: normalizedOwnership(req.foundryUserId),
    },
    { renderSheet: false },
  );
  const actor = Array.isArray(created) ? created[0] : created;
  if (
    typeof actor !== "object" ||
    actor === null ||
    typeof (actor as ActorLike).update !== "function"
  ) {
    throw new Error("Foundry did not return the created Actor");
  }
  return actor as ActorLike;
}

function normalizedOwnership(foundryUserId: string | undefined): Dict {
  return foundryUserId
    ? { default: NONE_LEVEL, [foundryUserId]: OWNER_LEVEL }
    : { default: NONE_LEVEL };
}

// Foundry merges object updates recursively. Deletion directives are therefore required when an
// adopted/bound Actor already carries explicit grants; merely sending the desired object would
// leave stale owners behind. Actor.create receives the plain normalized map, while Actor.update
// receives this merge-safe shape and ends with exactly default:NONE plus, when supplied, one OWNER.
function normalizedOwnershipUpdate(
  actor: ActorLike,
  foundryUserId: string | undefined,
): Dict {
  const update: Dict = { default: NONE_LEVEL };
  for (const key of Object.keys(actor.ownership ?? {})) {
    if (key !== "default" && key !== foundryUserId) update[`-=${key}`] = null;
  }
  if (foundryUserId) update[foundryUserId] = OWNER_LEVEL;
  return update;
}

function storedCharacterCreation(
  req: KnightActorUpsertV1,
): StoredCharacterCreationV1 | undefined {
  if (!req.characterCreation) return undefined;
  return {
    ...req.characterCreation,
    approvedRevision: req.approvedRevision,
  };
}

function authoredPatch(
  actor: ActorLike,
  req: KnightActorUpsertV1,
  binding: BindingV1,
): Dict {
  const patch: Dict = {
    name: req.name,
    ownership: normalizedOwnershipUpdate(actor, req.foundryUserId),
    [`flags.${MODULE_ID}.binding`]: binding,
  };
  const creation = storedCharacterCreation(req);
  if (creation) patch[`flags.${MODULE_ID}.characterCreationV1`] = creation;
  if (req.state !== "approved") return patch;
  const p = req.profile!;
  const aspects = req.aspects!;
  const chars = req.characteristics!;
  Object.assign(patch, {
    "system.description": p.description,
    "system.descriptionLimitee": p.limitedDescription,
    "system.histoire": p.history,
    "system.origin": p.origin,
    "system.age": p.age,
    "system.archetype": p.archetype,
    "system.metaarmure": p.metaArmour,
    "system.blason": p.coatOfArms,
    "system.surnom": p.nickname,
    "system.section": p.section,
    "system.hautFait": p.highFeat,
    "system.motivations.majeure": p.majorMotivation,
  });
  if (req.ai) {
    patch["system.equipements.ia.code"] = req.ai.code;
    patch["system.equipements.ia.surnom"] = req.ai.nickname;
    patch["system.equipements.ia.caractere"] = req.ai.personality;
  }
  for (const aspect of [
    "chair",
    "bete",
    "machine",
    "dame",
    "masque",
  ] as const) {
    patch[`system.aspects.${aspect}.base`] = aspects[aspect];
  }
  const characteristicGroups: Record<string, Record<string, number>> = {
    chair: chars.chair,
    bete: chars.bete,
    machine: chars.machine,
    dame: chars.dame,
    masque: chars.masque,
  };
  for (const [aspect, group] of Object.entries(characteristicGroups)) {
    for (const [characteristic, value] of Object.entries(group)) {
      patch[
        `system.aspects.${aspect}.caracteristiques.${characteristic}.base`
      ] = value;
    }
  }
  return patch;
}

interface MinorMotivationFlagV1 {
  schemaVersion: 1;
  index: number;
}

function minorMotivationFlag(
  item: ActorItemLike,
): MinorMotivationFlagV1 | null {
  const value = flagValue(item, "actorUpsertMinorMotivationV1");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (p.schemaVersion !== 1 || !Number.isSafeInteger(p.index)) return null;
  return { schemaVersion: 1, index: p.index as number };
}

async function applyMinorMotivations(
  actor: ActorLike,
  motivations: string[],
): Promise<string[]> {
  const warnings: string[] = [];
  const managed = actorItems(actor).filter(
    (item) =>
      item.type === "motivationMineure" && minorMotivationFlag(item) !== null,
  );
  const retained = new Map<number, ActorItemLike>();
  const remove: ActorItemLike[] = [];
  for (const item of managed) {
    const index = minorMotivationFlag(item)!.index;
    if (index < 0 || index >= motivations.length) {
      remove.push(item);
      continue;
    }
    if (retained.has(index)) {
      warnings.push(`minor_motivation_collision:${index}`);
      remove.push(item);
      continue;
    }
    retained.set(index, item);
  }
  if (remove.length > 0) {
    const valid = remove.filter((item) => foundryId.test(itemID(item)));
    for (const item of remove.filter(
      (candidate) => !foundryId.test(itemID(candidate)),
    ))
      warnings.push(
        `minor_motivation_delete_unavailable:${minorMotivationFlag(item)!.index}`,
      );
    if (valid.length > 0) {
      if (typeof actor.deleteEmbeddedDocuments === "function")
        await actor.deleteEmbeddedDocuments("Item", valid.map(itemID));
      else
        for (const item of valid)
          warnings.push(
            `minor_motivation_delete_unavailable:${minorMotivationFlag(item)!.index}`,
          );
    }
  }

  for (const [index, motivation] of motivations.entries()) {
    const flag: MinorMotivationFlagV1 = { schemaVersion: 1, index };
    const existing = retained.get(index);
    if (existing?.update) {
      await existing.update({
        name: `Motivation mineure ${index + 1}`,
        "system.description": motivation,
        [`flags.${MODULE_ID}.actorUpsertMinorMotivationV1`]: flag,
      });
      continue;
    }
    if (existing) {
      warnings.push(`minor_motivation_unavailable:${index}`);
      continue;
    }
    if (typeof actor.createEmbeddedDocuments !== "function") {
      warnings.push(`minor_motivation_unavailable:${index}`);
      continue;
    }
    await actor.createEmbeddedDocuments("Item", [
      {
        name: `Motivation mineure ${index + 1}`,
        type: "motivationMineure",
        system: { description: motivation },
        flags: {
          [MODULE_ID]: { actorUpsertMinorMotivationV1: flag },
        },
      },
    ]);
  }
  return warnings;
}

function hasPath(root: unknown, path: string): boolean {
  let current = root;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || !(key in current))
      return false;
    current = (current as Dict)[key];
  }
  return true;
}

async function applyCurrentResources(
  actor: ActorLike,
  resources: CurrentResourcesV1 | undefined,
): Promise<string[]> {
  if (!resources) return [];
  const specs: Array<[keyof CurrentResourcesV1, string]> = [
    ["health", "sante.value"],
    ["hope", "espoir.value"],
    ["armour", "equipements.armure.armure.value"],
    ["energy", "equipements.armure.energie.value"],
    ["contact", "contacts.actuel"],
  ];
  const patch: Dict = {};
  const warnings: string[] = [];
  for (const [key, path] of specs) {
    const value = resources[key];
    if (value === undefined) continue;
    if (!hasPath(actor.system, path)) {
      warnings.push(`resource_unavailable:${key}`);
      continue;
    }
    patch[`system.${path}`] = value;
  }
  if (Object.keys(patch).length > 0) await actor.update(patch);
  return warnings;
}

function itemCatalogVariant(
  item: ActorItemLike,
): EquipmentCatalogVariantV1 | null {
  const value = flagValue(item, "equipmentCatalogVariantV1");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    !Array.isArray(p.catalogIds) ||
    p.catalogIds.length === 0 ||
    !p.catalogIds.every((id) => typeof id === "string" && catalogId.test(id)) ||
    new Set(p.catalogIds).size !== p.catalogIds.length ||
    !Number.isSafeInteger(p.quantity) ||
    (p.quantity as number) < 1 ||
    (p.quantity as number) > 10 ||
    !Number.isSafeInteger(p.instanceIndex) ||
    (p.instanceIndex as number) < 0 ||
    (p.instanceIndex as number) >= (p.quantity as number) ||
    (p.slotAlternativeId !== undefined &&
      typeof p.slotAlternativeId !== "string") ||
    (p.parentCatalogId !== undefined &&
      (typeof p.parentCatalogId !== "string" ||
        !catalogId.test(p.parentCatalogId))) ||
    (p.moduleLevel !== undefined && ![1, 2, 3].includes(Number(p.moduleLevel)))
  )
    return null;
  if (p.slotAlternativeId !== undefined) {
    try {
      canonicalSlotAlternative(
        p.slotAlternativeId,
        "equipmentCatalogVariantV1.slotAlternativeId",
      );
    } catch {
      return null;
    }
  }
  return {
    schemaVersion: 1,
    catalogIds: [...p.catalogIds].sort(),
    quantity: p.quantity as number,
    instanceIndex: p.instanceIndex as number,
    slotAlternativeId: p.slotAlternativeId as string | undefined,
    parentCatalogId: p.parentCatalogId as string | undefined,
    moduleLevel: p.moduleLevel as 1 | 2 | 3 | undefined,
  };
}

function itemCatalogIDs(item: ActorItemLike): string[] {
  const variant = itemCatalogVariant(item);
  if (variant) return variant.catalogIds;
  const value = flagValue(item, "equipmentCatalogId");
  return typeof value === "string" && catalogId.test(value) ? [value] : [];
}

function itemCatalogID(item: ActorItemLike): string {
  return itemCatalogIDs(item).at(-1) ?? "";
}

function itemID(item: ActorItemLike): string {
  return item.id ?? item._id ?? "";
}

function itemCatalogSource(
  item: ActorItemLike,
): EquipmentCatalogSourceV1 | null {
  const value = flagValue(item, "equipmentCatalogSourceV1");
  if (typeof value !== "object" || value === null) return null;
  const p = value as Dict;
  if (
    p.schemaVersion !== 1 ||
    typeof p.pack !== "string" ||
    typeof p.documentId !== "string" ||
    p.compendiumVersion !== KNIGHT_COMPENDIUM_VERSION ||
    p.knightSystemVersion !== "3.58.33"
  )
    return null;
  return {
    schemaVersion: 1,
    pack: p.pack,
    documentId: p.documentId,
    compendiumVersion: p.compendiumVersion,
    knightSystemVersion: p.knightSystemVersion,
  };
}

async function deleteManagedEquipment(
  actor: ActorLike,
  items: ActorItemLike[],
  warnings: string[],
): Promise<boolean> {
  if (items.length === 0) return true;
  const ids = items.map(itemID);
  if (
    ids.some((id) => !foundryId.test(id)) ||
    typeof actor.deleteEmbeddedDocuments !== "function"
  ) {
    for (const item of items)
      warnings.push(`equipment_delete_unavailable:${itemCatalogID(item)}`);
    return false;
  }
  await actor.deleteEmbeddedDocuments("Item", ids);
  return true;
}

function actorItems(actor: ActorLike): ActorItemLike[] {
  const items = actor.items;
  if (!items) return [];
  if ("contents" in items && Array.isArray(items.contents))
    return items.contents;
  if (Symbol.iterator in items) return [...(items as Iterable<ActorItemLike>)];
  return [];
}

interface DesiredEquipmentItem {
  catalogIds: string[];
  mapped: KnightEquipmentCrosswalkDocumentV1;
  quantity: number;
  instanceIndex: number;
  slotAlternativeId?: string;
  parentCatalogId?: string;
  moduleLevel?: 1 | 2 | 3;
}

function desiredEquipment(
  selections: EquipmentSelectionV1[],
  warnings: string[],
): DesiredEquipmentItem[] {
  const desired: DesiredEquipmentItem[] = [];
  const moduleFamilies = new Map<
    string,
    Omit<DesiredEquipmentItem, "instanceIndex">
  >();
  for (const selection of selections) {
    const documents = KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1[selection.catalogId];
    if (!documents) {
      warnings.push(`equipment_unmapped:${selection.catalogId}`);
      continue;
    }
    for (const mapped of documents) {
      if (mapped.moduleFamilyId && mapped.moduleLevel) {
        if (
          !selection.slotAlternativeId ||
          selection.slotAlternativeId === "handheld" ||
          selection.parentCatalogId
        )
          invalid(
            `equipment module ${selection.catalogId} has invalid placement`,
          );
        const existing = moduleFamilies.get(mapped.moduleFamilyId);
        if (!existing) {
          moduleFamilies.set(mapped.moduleFamilyId, {
            catalogIds: [selection.catalogId],
            mapped,
            quantity: selection.quantity,
            slotAlternativeId: selection.slotAlternativeId,
            moduleLevel: mapped.moduleLevel,
          });
        } else {
          if (
            existing.quantity !== selection.quantity ||
            existing.slotAlternativeId !== selection.slotAlternativeId
          )
            invalid(
              `equipment module family ${mapped.moduleFamilyId} must share quantity and placement`,
            );
          existing.catalogIds.push(selection.catalogId);
          if (mapped.moduleLevel > (existing.moduleLevel ?? 0)) {
            existing.mapped = mapped;
            existing.moduleLevel = mapped.moduleLevel;
          }
        }
      } else {
        if (mapped.itemType === "armure") {
          if (
            selection.quantity !== 1 ||
            selection.slotAlternativeId ||
            selection.parentCatalogId
          )
            invalid(
              `equipment armour ${selection.catalogId} has invalid semantics`,
            );
        } else if (
          mapped.itemType === "arme" &&
          (selection.slotAlternativeId !== "handheld" ||
            selection.parentCatalogId)
        ) {
          invalid(`equipment weapon ${selection.catalogId} must be handheld`);
        }
        for (
          let instanceIndex = 0;
          instanceIndex < selection.quantity;
          instanceIndex += 1
        ) {
          desired.push({
            catalogIds: [selection.catalogId],
            mapped,
            quantity: selection.quantity,
            instanceIndex,
            slotAlternativeId: selection.slotAlternativeId,
            parentCatalogId: selection.parentCatalogId,
          });
        }
      }
    }
  }
  for (const family of moduleFamilies.values()) {
    for (
      let instanceIndex = 0;
      instanceIndex < family.quantity;
      instanceIndex += 1
    )
      desired.push({ ...family, instanceIndex });
  }
  for (const item of desired) item.catalogIds.sort();
  return desired.sort((a, b) =>
    desiredEquipmentKey(a).localeCompare(desiredEquipmentKey(b)),
  );
}

function desiredEquipmentKey(item: DesiredEquipmentItem): string {
  return [
    item.catalogIds.join(","),
    item.mapped.pack,
    item.mapped.documentId,
    item.quantity,
    item.instanceIndex,
    item.slotAlternativeId ?? "",
    item.parentCatalogId ?? "",
    item.moduleLevel ?? 0,
  ].join("|");
}

function managedEquipmentKey(item: ActorItemLike): string | null {
  const source = itemCatalogSource(item);
  const ids = itemCatalogIDs(item);
  const variant = itemCatalogVariant(item);
  if (!source || ids.length === 0 || !variant) return null;
  return [
    ids.join(","),
    source.pack,
    source.documentId,
    variant.quantity,
    variant.instanceIndex,
    variant.slotAlternativeId ?? "",
    variant.parentCatalogId ?? "",
    variant.moduleLevel ?? 0,
  ].join("|");
}

function compendiumAvailabilityWarning(): string | null {
  const module = currentGame().modules?.get(KNIGHT_COMPENDIUM_MODULE_ID);
  if (!module?.active) return "equipment_compendium_missing";
  if (module.version !== KNIGHT_COMPENDIUM_VERSION)
    return `equipment_compendium_unsupported:${module.version ?? "unknown"}`;
  return null;
}

function applyModuleLevel(source: Dict, level: 1 | 2 | 3): boolean {
  if (
    typeof source.system !== "object" ||
    source.system === null ||
    Array.isArray(source.system)
  )
    return false;
  const system = { ...(source.system as Dict) };
  if (
    typeof system.niveau !== "object" ||
    system.niveau === null ||
    Array.isArray(system.niveau)
  )
    return false;
  const niveau = { ...(system.niveau as Dict) };
  const details = niveau.details;
  if (
    !Number.isSafeInteger(niveau.max) ||
    (niveau.max as number) < level ||
    !Array.isArray(niveau.liste) ||
    !niveau.liste.includes(level) ||
    typeof details !== "object" ||
    details === null ||
    !(`n${level}` in details)
  )
    return false;
  niveau.value = String(level);
  system.niveau = niveau;
  source.system = system;
  return true;
}

function applyModuleSlots(source: Dict, slotAlternativeId: string): boolean {
  if (
    typeof source.system !== "object" ||
    source.system === null ||
    Array.isArray(source.system)
  )
    return false;
  const system = { ...(source.system as Dict) };
  if (
    typeof system.slots !== "object" ||
    system.slots === null ||
    Array.isArray(system.slots)
  )
    return false;
  const foundryKeys = {
    tete: "tete",
    bras_gauche: "brasGauche",
    bras_droit: "brasDroit",
    torse: "torse",
    jambe_gauche: "jambeGauche",
    jambe_droite: "jambeDroite",
  } as const;
  const slots = { ...(system.slots as Dict) };
  if (Object.values(foundryKeys).some((key) => !(key in slots))) return false;
  for (const key of Object.values(foundryKeys)) slots[key] = 0;
  for (const part of slotAlternativeId.split("+")) {
    const [canonical, rawQuantity] = part.split("=");
    const foundry = foundryKeys[canonical as keyof typeof foundryKeys];
    const quantity = Number(rawQuantity);
    if (!foundry || !Number.isSafeInteger(quantity) || quantity < 1)
      return false;
    slots[foundry] = quantity;
  }
  system.slots = slots;
  source.system = system;
  return true;
}

async function applyEquipment(
  actor: ActorLike,
  selections: EquipmentSelectionV1[] | undefined,
): Promise<{
  equipmentCompleteness: EquipmentCompleteness;
  warnings: string[];
}> {
  if (selections === undefined)
    return { equipmentCompleteness: "not_requested", warnings: [] };
  const warnings: string[] = [];
  const requested = new Set(selections.map((selection) => selection.catalogId));
  const desired = desiredEquipment(selections, warnings);
  const desiredByKey = new Map(
    desired.map((item) => [desiredEquipmentKey(item), item]),
  );
  const retainedKeys = new Set<string>();
  const unmappedRequested = new Set(
    selections
      .map((selection) => selection.catalogId)
      .filter((id) => KNIGHT_EQUIPMENT_CROSSWALK_V14_0_1[id] === undefined),
  );
  const managed = actorItems(actor).filter(
    (item) => itemCatalogIDs(item).length > 0,
  );
  const stale: ActorItemLike[] = [];
  for (const item of managed) {
    const itemIDs = itemCatalogIDs(item);
    if (
      itemIDs.length > 0 &&
      itemIDs.every((id) => requested.has(id)) &&
      itemIDs.some((id) => unmappedRequested.has(id))
    ) {
      // A previous release may have managed an identity this exact fixture does
      // not know. Preserve it while requested; never guess a replacement.
      continue;
    }
    const key = managedEquipmentKey(item);
    if (key && desiredByKey.has(key) && !retainedKeys.has(key)) {
      retainedKeys.add(key);
      continue;
    }
    stale.push(item);
  }
  if (!(await deleteManagedEquipment(actor, stale, warnings))) {
    return { equipmentCompleteness: "partial", warnings };
  }

  const compendiumWarning =
    desired.length === 0 ? null : compendiumAvailabilityWarning();
  if (compendiumWarning) warnings.push(compendiumWarning);
  const packs = currentGame().packs;
  for (const item of desired) {
    const key = desiredEquipmentKey(item);
    if (retainedKeys.has(key) || compendiumWarning) continue;
    const pack = packs?.get(item.mapped.pack);
    const document = await pack?.getDocument(item.mapped.documentId);
    const raw = document?.toObject();
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      (raw as Dict).type !== item.mapped.itemType ||
      typeof actor.createEmbeddedDocuments !== "function"
    ) {
      warnings.push(`equipment_unavailable:${item.catalogIds.join("+")}`);
      continue;
    }
    const source = { ...(raw as Dict) };
    if (item.moduleLevel) {
      if (
        !applyModuleLevel(source, item.moduleLevel) ||
        !item.slotAlternativeId ||
        !applyModuleSlots(source, item.slotAlternativeId)
      ) {
        warnings.push(`equipment_unavailable:${item.catalogIds.join("+")}`);
        continue;
      }
    }
    delete source._id;
    delete source._stats;
    delete source.folder;
    delete source.ownership;
    const sourceFlags =
      typeof source.flags === "object" && source.flags !== null
        ? { ...(source.flags as Dict) }
        : {};
    const tcFlags =
      typeof sourceFlags[MODULE_ID] === "object" &&
      sourceFlags[MODULE_ID] !== null
        ? { ...(sourceFlags[MODULE_ID] as Dict) }
        : {};
    tcFlags.equipmentCatalogId = item.catalogIds.at(-1)!;
    tcFlags.equipmentCatalogVariantV1 = {
      schemaVersion: 1,
      catalogIds: item.catalogIds,
      quantity: item.quantity,
      instanceIndex: item.instanceIndex,
      ...(item.slotAlternativeId === undefined
        ? {}
        : { slotAlternativeId: item.slotAlternativeId }),
      ...(item.parentCatalogId === undefined
        ? {}
        : { parentCatalogId: item.parentCatalogId }),
      ...(item.moduleLevel === undefined
        ? {}
        : { moduleLevel: item.moduleLevel }),
    } satisfies EquipmentCatalogVariantV1;
    tcFlags.equipmentCatalogSourceV1 = {
      schemaVersion: 1,
      pack: item.mapped.pack,
      documentId: item.mapped.documentId,
      compendiumVersion: KNIGHT_COMPENDIUM_VERSION,
      knightSystemVersion: "3.58.33",
    } satisfies EquipmentCatalogSourceV1;
    sourceFlags[MODULE_ID] = tcFlags;
    source.flags = sourceFlags;
    await actor.createEmbeddedDocuments("Item", [source]);
  }
  return {
    equipmentCompleteness: warnings.length === 0 ? "complete" : "partial",
    warnings,
  };
}

function exactBinding(binding: BindingV1 | null, expected: BindingV1): boolean {
  return (
    binding?.schemaVersion === 1 &&
    binding.worldId === expected.worldId &&
    binding.tableId === expected.tableId &&
    binding.characterId === expected.characterId
  );
}

/**
 * Durable Knight actor provisioning. Lookup is exclusively by the unique Table
 * Companion binding (or an explicit unbound assignedActorId); names are never a
 * key. Drafts write only name/flags/ownership. Approved requests add a fixed
 * allowlist of authored Knight source fields, then current resources in a
 * post-prepare pass. No caller-controlled Foundry paths are accepted.
 */
export const actorUpsertV1: Procedure = async (payload) => {
  const req = validateKnightActorUpsertV1(payload);
  assertRuntimeAndAuthority(req);
  const digest = await canonicalDigest(req);
  const binding: BindingV1 = {
    schemaVersion: 1,
    worldId: req.worldId,
    tableId: req.tableId,
    characterId: req.characterId,
  };
  const collection = actorCollection();
  const matches = allActors(collection).filter((actor) =>
    exactBinding(bindingOf(actor), binding),
  );
  if (matches.length > 1)
    throw new RpcError(
      "binding_collision",
      "multiple Actors carry this Table Companion binding",
    );

  let actor: ActorLike | undefined = matches[0];
  let outcome: Outcome = "updated";
  if (req.expectedActorId) {
    if (!actor)
      throw new RpcError(
        "deleted_link",
        "the previously linked Actor no longer exists",
      );
    if (actorID(actor) !== req.expectedActorId)
      throw new RpcError(
        "binding_conflict",
        "the binding points at a different Actor",
      );
  }
  if (actor && req.assignedActorId && actorID(actor) !== req.assignedActorId) {
    throw new RpcError(
      "binding_conflict",
      "assignedActorId differs from the bound Actor",
    );
  }

  if (!actor && req.assignedActorId) {
    actor = collection.get(req.assignedActorId);
    if (!actor)
      throw new RpcError("actor_not_found", "assignedActorId does not exist");
    if (actor.type !== ACTOR_TYPE)
      invalid("assignedActorId must identify a Knight actor");
    if (bindingOf(actor))
      throw new RpcError(
        "binding_conflict",
        "assignedActorId is already bound to another character",
      );
    outcome = "adopted";
  } else if (!actor) {
    actor = await createActor(req, binding);
    outcome = "created";
  }
  if (actor.type !== ACTOR_TYPE) invalid("bound Actor is not a Knight actor");
  const id = actorID(actor);
  if (!foundryId.test(id))
    throw new Error("Foundry returned an invalid Actor id");

  const previous = syncOf(actor);
  if (previous) {
    if (previous.appliedRevision > req.approvedRevision) {
      throw new RpcError(
        "stale_revision",
        "Actor has a newer approved revision",
      );
    }
    if (previous.appliedRevision === req.approvedRevision) {
      if (previous.appliedDigest !== digest) {
        throw new RpcError(
          "revision_conflict",
          "the same approved revision carries different content",
        );
      }
      return {
        schemaVersion: 1,
        resultDocId: id,
        outcome: previous.outcome,
        appliedRevision: previous.appliedRevision,
        appliedDigest: previous.appliedDigest,
        equipmentCompleteness: previous.equipmentCompleteness,
        warnings: [...previous.warnings],
      } satisfies ActorUpsertResultV1;
    }
  }

  await actor.update(authoredPatch(actor, req, binding));
  const motivationWarnings =
    req.state === "approved"
      ? await applyMinorMotivations(actor, req.profile!.minorMotivations)
      : [];
  actor.prepareData?.();
  const resourceWarnings =
    req.state === "approved"
      ? await applyCurrentResources(actor, req.resources)
      : [];
  const equipment =
    req.state === "approved"
      ? await applyEquipment(actor, req.equipment?.selections)
      : {
          equipmentCompleteness: "not_requested" as const,
          warnings: req.equipment?.selections.length
            ? ["equipment_deferred_until_approved"]
            : [],
        };
  const result: ActorUpsertResultV1 = {
    schemaVersion: 1,
    resultDocId: id,
    outcome,
    appliedRevision: req.approvedRevision,
    appliedDigest: digest,
    equipmentCompleteness: equipment.equipmentCompleteness,
    warnings: [
      ...(req.foundryUserId ? [] : ["assign_foundry_user"]),
      ...motivationWarnings,
      ...resourceWarnings,
      ...equipment.warnings,
    ],
  };
  const sync: SyncV1 = { ...result, state: req.state };
  await actor.update({ [`flags.${MODULE_ID}.actorUpsertV1`]: sync });
  return result;
};
