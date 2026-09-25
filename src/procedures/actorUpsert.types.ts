import type { AspectScoresV1, Outcome } from "./upsertShared.js";

/**
 * The `actor.upsert.v1` wire shapes: the semantic request DTO, the result the
 * procedure returns, the sync record it stores on the Actor, and the flags it
 * stamps on imported equipment. Nothing here names a raw Foundry path; the
 * mapping onto the Knight data model lives in actorUpsert.patch.ts and
 * actorUpsert.equipment.ts.
 */

export const ACTOR_TYPE = "knight";

export type State = "draft" | "approved";
export type EquipmentCompleteness = "not_requested" | "complete" | "partial";

export interface ProfileV1 {
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

export interface AIV1 {
  code: string;
  nickname: string;
  personality: string;
}

/** PC aspect bases (the prepared values stay derived in Foundry). */
export type AspectsV1 = AspectScoresV1;

export interface CharacteristicsV1 {
  chair: { deplacement: number; force: number; endurance: number };
  bete: { combat: number; hargne: number; instinct: number };
  machine: { tir: number; savoir: number; technique: number };
  dame: { aura: number; parole: number; sangFroid: number };
  masque: { discretion: number; dexterite: number; perception: number };
}

export interface CurrentResourcesV1 {
  health?: number;
  hope?: number;
  armour?: number;
  energy?: number;
  contact?: number;
}

export interface CharacterCreationV1 {
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

export interface EquipmentSelectionV1 {
  catalogId: string;
  quantity: number;
  slotAlternativeId?: string;
  parentCatalogId?: string;
}

export interface EquipmentV1 {
  selections: EquipmentSelectionV1[];
}

export interface StoredCharacterCreationV1 extends CharacterCreationV1 {
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

export interface SyncV1 extends ActorUpsertResultV1 {
  state: State;
}

export interface EquipmentCatalogSourceV1 {
  schemaVersion: 1;
  pack: string;
  documentId: string;
  compendiumVersion: string;
  knightSystemVersion: string;
}

export interface EquipmentCatalogVariantV1 {
  schemaVersion: 1;
  catalogIds: string[];
  quantity: number;
  instanceIndex: number;
  slotAlternativeId?: string;
  parentCatalogId?: string;
  moduleLevel?: 1 | 2 | 3;
}

/** An id in the app's bundled Knight catalog, e.g. "knight.weapon.railgun". */
export const catalogId = /^[A-Za-z0-9._:-]{1,128}$/;
/** A catalog digest as the app computes it: "sha256:" + 64 lowercase hex. */
export const catalogDigest = /^sha256:[0-9a-f]{64}$/;

/** The three stored equipment outcomes a sync record may carry. */
export const EQUIPMENT_COMPLETENESS: readonly string[] = [
  "not_requested",
  "complete",
  "partial",
];
