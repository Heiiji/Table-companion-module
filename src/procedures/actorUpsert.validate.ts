import {
  SCHEMA_VERSION,
  bindingId,
  foundryId,
  identifier,
  integer,
  invalid,
  parseAspectScores,
  record,
  text,
} from "./upsertShared.js";
import {
  ACTOR_TYPE,
  catalogDigest,
  catalogId,
  type AIV1,
  type CharacterCreationV1,
  type CharacteristicsV1,
  type CurrentResourcesV1,
  type EquipmentSelectionV1,
  type EquipmentV1,
  type KnightActorUpsertV1,
  type ProfileV1,
  type State,
} from "./actorUpsert.types.js";

/**
 * Strict parsing of the `actor.upsert.v1` request. Every object is checked
 * against an exact key list, so anything the DTO does not name (raw document
 * paths, caller ownership or flags, secret Tarot, prepared/derived/max values,
 * arbitrary equipment) is refused before the procedure touches the world.
 */

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

export function canonicalSlotAlternative(value: unknown, path: string): string {
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
    aspects: p.aspects === undefined ? undefined : parseAspectScores(p.aspects),
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
