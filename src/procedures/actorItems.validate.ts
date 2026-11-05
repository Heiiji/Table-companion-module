import { MAX_ROLL_DICE } from "./rollExecute.js";
import { catalogId as catalogIdShape } from "./actorUpsert.types.js";
import {
  LIVE_HEADER_KEYS,
  bindingId,
  documentId,
  identifier,
  integer,
  invalid,
  liveHeader,
  record,
  text,
  uuid,
  type LiveHeaderV1,
} from "./upsertShared.js";

export const ACTOR_TYPE = "knight";
export const PROCEDURE = "actor.items.v1";
const MAX_NAME = 200;
const MAX_DESCRIPTION_BYTES = 8192;
const MAX_PROFILES = 8;
/** The weapon snapshot envelope's own ceiling bounds every profile string. */
const MAX_PROFILE_TEXT = 4096;

export type ItemKind = "module" | "weapon";
export const FOUNDRY_TYPE: Record<ItemKind, string> = {
  module: "module",
  weapon: "arme",
};

/** The app's slot keys → the Knight `module` schema's. */
export const SLOTS = {
  tete: "tete",
  torse: "torse",
  bras_gauche: "brasGauche",
  bras_droit: "brasDroit",
  jambe_gauche: "jambeGauche",
  jambe_droite: "jambeDroite",
} as const;
export type SlotKey = keyof typeof SLOTS;
export const SLOT_KEYS = Object.keys(SLOTS) as SlotKey[];

export const PRINTED_RANGES: Record<string, string> = {
  personnelle: "Personnelle",
  contact: "Contact",
  courte: "Courte",
  moyenne: "Moyenne",
  longue: "Longue",
  lointaine: "Lointaine",
};

export interface DiceV1 {
  count: number;
  faces: number;
  flat: number;
  expr?: string;
}

/** One attack of the app's weapon snapshot. */
export interface AttackProfileV1 {
  id: string;
  name: string;
  range?: string;
  damage?: DiceV1;
  violence?: DiceV1;
}

export interface ItemFieldsV1 {
  name?: string;
  level?: number;
  energy?: number;
  slots?: Record<SlotKey, number>;
  active?: boolean;
  chargesCurrent?: number;
  chargesMax?: number;
  profiles?: AttackProfileV1[];
  description?: string;
}

export type ItemSourceV1 =
  | { live: { pack: string; docId: string } }
  | { catalogId: string }
  | { custom: true };

export type ActorItemsOpV1 =
  | {
      add: {
        entryId: string;
        kind: ItemKind;
        source: ItemSourceV1;
        item: ItemFieldsV1;
      };
    }
  | {
      update: {
        itemId: string;
        kind: ItemKind;
        item: ItemFieldsV1;
        expected: ItemFieldsV1;
        entryId?: string;
      };
    }
  | { remove: { itemId: string; kind: ItemKind; expectedName: string } };

export interface KnightActorItemsV1 extends LiveHeaderV1<"knight"> {
  op: ActorItemsOpV1;
}

export interface ActorItemsResultV1 {
  schemaVersion: 1;
  resultDocId: string;
  outcome: "updated";
  appliedDigest: string;
  warnings: string[];
  itemId: string;
}

// ---------------------------------------------------------------- validation

const MODULE_KEYS = [
  "name",
  "level",
  "energy",
  "slots",
  "active",
  "chargesCurrent",
  "chargesMax",
];

function itemKind(value: unknown, path: string): ItemKind {
  if (value !== "module" && value !== "weapon")
    invalid(`${path} must be module or weapon`);
  return value;
}

/** The dice an attack may carry: Knight rolls `count` d6 for damage and
 * violence, so a count is bounded like `roll.execute`'s dice budget (zero is
 * a flat-only attack) and faces like a real die. */
const MAX_DICE_FACES = 1000;

function dice(value: unknown, path: string): DiceV1 {
  const d = record(value, path, ["count", "faces", "flat", "expr"]);
  return {
    count: integer(d.count, `${path}.count`, 0, MAX_ROLL_DICE),
    faces: integer(d.faces, `${path}.faces`, 1, MAX_DICE_FACES),
    flat: integer(
      d.flat,
      `${path}.flat`,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(d.expr === undefined
      ? {}
      : { expr: text(d.expr, `${path}.expr`, MAX_PROFILE_TEXT, true) }),
  };
}

function profiles(value: unknown, path: string): AttackProfileV1[] {
  if (!Array.isArray(value) || value.length > MAX_PROFILES)
    invalid(`${path} must be an array of at most ${MAX_PROFILES} attacks`);
  const out = value.map((raw, i): AttackProfileV1 => {
    const at = `${path}[${i}]`;
    const a = record(raw, at, ["id", "name", "range", "damage", "violence"]);
    return {
      id: text(a.id, `${at}.id`, MAX_PROFILE_TEXT, true),
      name: text(a.name, `${at}.name`, MAX_PROFILE_TEXT),
      ...(a.range === undefined
        ? {}
        : { range: text(a.range, `${at}.range`, MAX_PROFILE_TEXT, true) }),
      ...(a.damage === undefined
        ? {}
        : { damage: dice(a.damage, `${at}.damage`) }),
      ...(a.violence === undefined
        ? {}
        : { violence: dice(a.violence, `${at}.violence`) }),
    };
  });
  if (new Set(out.map((a) => a.id)).size !== out.length)
    invalid(`${path} ids must be unique`);
  return out;
}

function itemFields(
  value: unknown,
  path: string,
  kind: ItemKind,
  options: { requireName: boolean; description: boolean },
): ItemFieldsV1 {
  const allowed =
    kind === "weapon"
      ? ["name", "profiles"]
      : options.description
        ? [...MODULE_KEYS, "description"]
        : MODULE_KEYS;
  const p = record(value, path, allowed);
  const out: ItemFieldsV1 = {};
  if (p.name !== undefined)
    out.name = text(p.name, `${path}.name`, MAX_NAME, true);
  else if (options.requireName) invalid(`${path}.name is required`);
  if (p.level !== undefined)
    out.level = integer(p.level, `${path}.level`, 1, 5);
  if (p.energy !== undefined)
    out.energy = integer(p.energy, `${path}.energy`, 0, 20);
  if (p.slots !== undefined) {
    const s = record(p.slots, `${path}.slots`, SLOT_KEYS);
    out.slots = Object.fromEntries(
      SLOT_KEYS.map((k) => [k, integer(s[k], `${path}.slots.${k}`, 0, 9)]),
    ) as Record<SlotKey, number>;
  }
  if (p.active !== undefined) {
    if (typeof p.active !== "boolean") invalid(`${path}.active must be a bool`);
    out.active = p.active;
  }
  if ((p.chargesCurrent === undefined) !== (p.chargesMax === undefined))
    invalid(`${path}.chargesCurrent and chargesMax go together`);
  if (p.chargesCurrent !== undefined) {
    out.chargesCurrent = integer(
      p.chargesCurrent,
      `${path}.chargesCurrent`,
      0,
      99,
    );
    out.chargesMax = integer(p.chargesMax, `${path}.chargesMax`, 0, 99);
    if (out.chargesCurrent > out.chargesMax)
      invalid(`${path}.chargesCurrent must not exceed chargesMax`);
  }
  if (p.profiles !== undefined)
    out.profiles = profiles(p.profiles, `${path}.profiles`);
  if (p.description !== undefined) {
    if (
      typeof p.description !== "string" ||
      new TextEncoder().encode(p.description).length > MAX_DESCRIPTION_BYTES
    )
      invalid(
        `${path}.description must be text of at most ${MAX_DESCRIPTION_BYTES} bytes`,
      );
    out.description = p.description;
  }
  return out;
}

function itemSource(value: unknown, path: string): ItemSourceV1 {
  const s = record(value, path, ["live", "catalogId", "custom"]);
  if (Object.keys(s).length !== 1)
    invalid(`${path} must carry exactly one of live, catalogId, custom`);
  if (s.live !== undefined) {
    const l = record(s.live, `${path}.live`, ["pack", "docId"]);
    if (l.pack !== "") identifier(l.pack, `${path}.live.pack`, bindingId);
    return {
      live: {
        pack: l.pack as string,
        docId: identifier(l.docId, `${path}.live.docId`, documentId),
      },
    };
  }
  if (s.catalogId !== undefined)
    return {
      catalogId: identifier(s.catalogId, `${path}.catalogId`, catalogIdShape),
    };
  if (s.custom !== true) invalid(`${path}.custom must be true`);
  return { custom: true };
}

function itemsOp(value: unknown): ActorItemsOpV1 {
  const o = record(value, "op", ["add", "update", "remove"]);
  if (Object.keys(o).length !== 1)
    invalid("op must carry exactly one of add, update, remove");
  if (o.add !== undefined) {
    const a = record(o.add, "op.add", ["entryId", "kind", "source", "item"]);
    const kind = itemKind(a.kind, "op.add.kind");
    const source = itemSource(a.source, "op.add.source");
    return {
      add: {
        entryId: identifier(a.entryId, "op.add.entryId", uuid),
        kind,
        source,
        // A copied document keeps its own description.
        item: itemFields(a.item, "op.add.item", kind, {
          requireName: true,
          description: !("live" in source),
        }),
      },
    };
  }
  if (o.update !== undefined) {
    const u = record(o.update, "op.update", [
      "itemId",
      "kind",
      "item",
      "expected",
      "entryId",
    ]);
    const kind = itemKind(u.kind, "op.update.kind");
    const options = { requireName: false, description: false };
    const item = itemFields(u.item, "op.update.item", kind, options);
    const expected = itemFields(
      u.expected,
      "op.update.expected",
      kind,
      options,
    );
    const keys = Object.keys(item).sort().join();
    if (keys !== Object.keys(expected).sort().join())
      invalid("op.update.item and op.update.expected must carry the same keys");
    if (keys === "" && u.entryId === undefined)
      invalid("op.update needs a field or an entryId");
    return {
      update: {
        itemId: identifier(u.itemId, "op.update.itemId", documentId),
        kind,
        item,
        expected,
        ...(u.entryId === undefined
          ? {}
          : {
              entryId: identifier(u.entryId, "op.update.entryId", uuid),
            }),
      },
    };
  }
  const r = record(o.remove, "op.remove", ["itemId", "kind", "expectedName"]);
  return {
    remove: {
      itemId: identifier(r.itemId, "op.remove.itemId", documentId),
      kind: itemKind(r.kind, "op.remove.kind"),
      expectedName: text(
        r.expectedName,
        "op.remove.expectedName",
        MAX_NAME,
        true,
      ),
    },
  };
}

export function validateKnightActorItemsV1(
  payload: unknown,
): KnightActorItemsV1 {
  const p = record(payload, "actorItems", [...LIVE_HEADER_KEYS, "op"]);
  return { ...liveHeader(p, ACTOR_TYPE), op: itemsOp(p.op) };
}
