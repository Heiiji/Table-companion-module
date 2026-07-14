import { MAX_ENVELOPE_BYTES } from "../constants.js";
import { RpcError, assertPayloadWithinCap } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import {
  actors,
  assertCompanionPermission,
  type PermissionActorLike,
} from "./foundry.js";

/**
 * The first Foundry-backed PF2e advancement boundary deliberately supports one
 * narrow mutation: advancing a character by one level through PF2e's live
 * Actor.update path. PF2e itself then runs its level-change hooks (HP, class
 * features, preparation), whose resulting Actor/Items we observe. That observed
 * output is not a claim that every class/choice requirement is complete. Build
 * decisions remain read-only until each kind has a pinned, fixture-proven PF2e
 * API; they are never translated into arbitrary document patches here.
 */

export const SUPPORTED_PF2E_VERSION = "8.3.0";
export const SUPPORTED_FOUNDRY_MAJOR = 14;
export const MIN_SUPPORTED_FOUNDRY_RELEASE = 361;
export const PF2E_PACK_REVISION = 5;

const OPERATION_JOURNAL_LIMIT = 100;
const MAX_ACTOR_ID_LENGTH = 128;
const MAX_REASON_LENGTH = 500;
const MAX_DECISIONS = 64;
const PERSISTED_OPERATION_LIMIT = 20;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const DECISION_KINDS = new Set([
  "attributeBoost",
  "skillIncrease",
  "feat",
  "spell",
  "language",
  "classFeature",
  "formula",
  "familiar",
  "companion",
  "variant",
]);

type AdvancementMode = "experience" | "milestone";
type OperationStage =
  | "received"
  | "updating"
  | "verifying"
  | "completed"
  | "rejected"
  | "needsReview"
  | "unknown";
type OperationOutcome =
  | "inProgress"
  | "accepted"
  | "rejected"
  | "needsReview"
  | "outcomeUnknown";

interface PF2eItemLike {
  id?: string | null;
  type?: string | null;
}

interface PF2eActorLike extends PermissionActorLike {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  system?: Record<string, unknown>;
  items?: Iterable<PF2eItemLike>;
  flags?: Record<string, unknown>;
  _stats?: { modifiedTime?: string | number | null };
  _source?: { _stats?: { modifiedTime?: string | number | null } };
  getFlag?(scope: string, key: string): unknown;
  update(changes: Record<string, unknown>): Promise<unknown>;
}

interface RuntimeInfo {
  foundryVersion: string;
  systemID: string;
  systemVersion: string;
}

interface Decision {
  slotID: string;
  kind: string;
  selectionID: string;
}

interface AdvancementTransaction {
  operationID: string;
  characterID: string;
  expectedSourceLevel: number;
  targetLevel: number;
  expectedPackRevision: number;
  decisions: Decision[];
  gmOverrideReason?: string;
}

interface PreviewInput {
  actorId: string;
  targetLevel: number;
  expectedPackRevision: number;
  advancementMode: AdvancementMode;
  milestoneReady: boolean;
  gmOverrideReason?: string;
}

interface ApplyInput extends PreviewInput {
  expectedActorRevision: string;
  transaction: AdvancementTransaction;
}

interface XPSnapshot {
  current?: number;
  threshold?: number;
  after?: number;
  ready: boolean;
  deducted: number;
}

interface ActorSnapshot {
  level: number;
  revision?: string;
  xpCurrent?: number;
  xpThreshold?: number;
  hpCurrent?: number;
  hpMax?: number;
  itemIDs: string[];
  itemCount: number;
  itemsValid: boolean;
}

interface AdvancementMarker {
  schemaVersion: 1;
  operationID: string;
  signature: string;
  fromLevel: number;
  targetLevel: number;
  expectedXPAfter?: number;
  requestedAt: number;
}

interface OperationRecord {
  operationID: string;
  actorId: string;
  signature: string;
  fromLevel: number;
  targetLevel: number;
  expectedXPAfter?: number;
  before: ActorSnapshot;
  stage: OperationStage;
  outcome: OperationOutcome;
  updatedAt: number;
  code?: string;
  message?: string;
}

const operationJournal = new Map<string, OperationRecord>();

/** Used only by the unit harness to isolate cases. */
export function clearPF2eAdvancementJournal(): void {
  operationJournal.clear();
}

function runtimeInfo(): RuntimeInfo {
  const g = globalThis as unknown as {
    game?: { version?: string; system?: { id?: string; version?: string } };
  };
  const bounded = (value: string | undefined) =>
    (value ?? "").trim().slice(0, 64);
  return {
    foundryVersion: bounded(g.game?.version),
    systemID: bounded(g.game?.system?.id),
    systemVersion: bounded(g.game?.system?.version),
  };
}

function foundryRelease(
  version: string,
): { major: number; release: number } | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const release = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(release)
    ? { major, release }
    : null;
}

/** Capability-advertisement predicate. Runtime checks are repeated in every handler. */
export function isPF2eAdvancementRuntimeSupported(): boolean {
  const runtime = runtimeInfo();
  const foundry = foundryRelease(runtime.foundryVersion);
  return (
    runtime.systemID === "pf2e" &&
    runtime.systemVersion === SUPPORTED_PF2E_VERSION &&
    foundry?.major === SUPPORTED_FOUNDRY_MAJOR &&
    foundry.release >= MIN_SUPPORTED_FOUNDRY_RELEASE
  );
}

function assertSupportedRuntime(): RuntimeInfo {
  const runtime = runtimeInfo();
  if (!isPF2eAdvancementRuntimeSupported()) {
    throw new RpcError(
      "unsupported_runtime",
      `PF2e advancement requires Foundry ${SUPPORTED_FOUNDRY_MAJOR}.${MIN_SUPPORTED_FOUNDRY_RELEASE}+ ` +
        `(major ${SUPPORTED_FOUNDRY_MAJOR}) and PF2e ${SUPPORTED_PF2E_VERSION}; observed ` +
        `Foundry ${runtime.foundryVersion || "unknown"}, ${runtime.systemID || "unknown"} ` +
        `${runtime.systemVersion || "unknown"}`,
    );
  }
  return runtime;
}

function object(payload: unknown, label = "payload"): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RpcError("invalid_args", `${label} must be a JSON object`);
  }
  return payload as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown)
    throw new RpcError(
      "invalid_args",
      `${label} contains unknown field ${unknown}`,
    );
}

function assertRequestWithinCap(payload: unknown, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new RpcError("invalid_args", `${label} is not JSON-serializable`);
  }
  // Leave headroom for the signed wrapper, procedure metadata, and response.
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_ENVELOPE_BYTES / 2) {
    throw new RpcError("payload_too_large", `${label} payload is too large`);
  }
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  options: { optional: true },
): string | undefined;
function boundedString(
  value: unknown,
  field: string,
  max: number,
  options?: { optional?: false },
): string;
function boundedString(
  value: unknown,
  field: string,
  max: number,
  options: { optional?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.optional) return undefined;
    throw new RpcError("invalid_args", `${field} is required`);
  }
  if (typeof value !== "string")
    throw new RpcError("invalid_args", `${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    throw new RpcError(
      "invalid_args",
      options.optional
        ? `${field} must not be blank when supplied`
        : `${field} is required`,
    );
  }
  if (
    new TextEncoder().encode(normalized).byteLength > max ||
    normalized.includes("\0")
  ) {
    throw new RpcError("invalid_args", `${field} is invalid or too long`);
  }
  return normalized;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RpcError("invalid_args", `${field} must be a safe integer`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw new RpcError("invalid_args", `${field} must be boolean`);
  return value;
}

function parseMode(value: unknown): AdvancementMode {
  if (value === "experience") return "experience";
  if (value === "milestone") return "milestone";
  throw new RpcError(
    "invalid_args",
    "advancementMode is required and must be experience or milestone",
  );
}

function parsePreviewInput(payload: unknown): PreviewInput {
  const value = object(payload);
  exactKeys(
    value,
    [
      "actorId",
      "targetLevel",
      "expectedPackRevision",
      "advancementMode",
      "milestoneReady",
      "gmOverrideReason",
    ],
    "preview payload",
  );
  const reason = boundedString(
    value.gmOverrideReason,
    "gmOverrideReason",
    MAX_REASON_LENGTH,
    {
      optional: true,
    },
  );
  return {
    actorId: boundedString(value.actorId, "actorId", MAX_ACTOR_ID_LENGTH),
    targetLevel: integer(value.targetLevel, "targetLevel"),
    expectedPackRevision: integer(
      value.expectedPackRevision,
      "expectedPackRevision",
    ),
    advancementMode: parseMode(value.advancementMode),
    milestoneReady: optionalBoolean(value.milestoneReady, "milestoneReady"),
    gmOverrideReason: reason,
  };
}

function parseDecision(value: unknown, index: number): Decision {
  const decision = object(value, `decisions[${index}]`);
  const keys = Object.keys(decision).sort();
  if (keys.join(",") !== "kind,selectionID,slotID") {
    throw new RpcError(
      "invalid_args",
      `decisions[${index}] must contain exactly slotID, kind, and selectionID`,
    );
  }
  const kind = boundedString(decision.kind, `decisions[${index}].kind`, 64);
  if (!DECISION_KINDS.has(kind)) {
    throw new RpcError("invalid_args", `decisions[${index}].kind is unknown`);
  }
  return {
    slotID: boundedString(decision.slotID, `decisions[${index}].slotID`, 160),
    kind,
    selectionID: boundedString(
      decision.selectionID,
      `decisions[${index}].selectionID`,
      256,
    ),
  };
}

function parseTransaction(value: unknown): AdvancementTransaction {
  const transaction = object(value, "transaction");
  const required = [
    "characterID",
    "decisions",
    "expectedPackRevision",
    "expectedSourceLevel",
    "operationID",
    "targetLevel",
  ];
  for (const field of required) {
    if (!(field in transaction))
      throw new RpcError("invalid_args", `transaction.${field} is required`);
  }
  const allowed = new Set([...required, "gmOverrideReason"]);
  if (Object.keys(transaction).some((key) => !allowed.has(key))) {
    throw new RpcError("invalid_args", "transaction contains an unknown field");
  }
  const operationID = boundedString(
    transaction.operationID,
    "transaction.operationID",
    36,
  );
  const characterID = boundedString(
    transaction.characterID,
    "transaction.characterID",
    36,
  );
  if (!UUID_RE.test(operationID) || !UUID_RE.test(characterID)) {
    throw new RpcError(
      "invalid_args",
      "transaction operationID and characterID must be UUIDs",
    );
  }
  if (!Array.isArray(transaction.decisions)) {
    throw new RpcError(
      "invalid_args",
      "transaction.decisions must be an array",
    );
  }
  if (transaction.decisions.length > MAX_DECISIONS) {
    throw new RpcError(
      "invalid_args",
      `transaction.decisions exceeds the ${MAX_DECISIONS}-decision limit`,
    );
  }
  const decisions = transaction.decisions.map(parseDecision);
  const seenSlots = new Set<string>();
  for (const decision of decisions) {
    if (seenSlots.has(decision.slotID)) {
      throw new RpcError(
        "invalid_args",
        `duplicate decision slotID ${decision.slotID}`,
      );
    }
    seenSlots.add(decision.slotID);
  }
  return {
    operationID,
    characterID,
    expectedSourceLevel: integer(
      transaction.expectedSourceLevel,
      "transaction.expectedSourceLevel",
    ),
    targetLevel: integer(transaction.targetLevel, "transaction.targetLevel"),
    expectedPackRevision: integer(
      transaction.expectedPackRevision,
      "transaction.expectedPackRevision",
    ),
    decisions,
    gmOverrideReason: boundedString(
      transaction.gmOverrideReason,
      "transaction.gmOverrideReason",
      MAX_REASON_LENGTH,
      { optional: true },
    ),
  };
}

function parseApplyInput(payload: unknown): ApplyInput {
  const value = object(payload);
  exactKeys(
    value,
    [
      "actorId",
      "expectedActorRevision",
      "advancementMode",
      "milestoneReady",
      "transaction",
    ],
    "apply payload",
  );
  const transaction = parseTransaction(value.transaction);
  const preview = parsePreviewInput({
    actorId: value.actorId,
    targetLevel: transaction.targetLevel,
    expectedPackRevision: transaction.expectedPackRevision,
    advancementMode: value.advancementMode,
    milestoneReady: value.milestoneReady,
    gmOverrideReason: transaction.gmOverrideReason,
  });
  return {
    ...preview,
    expectedActorRevision: boundedString(
      value.expectedActorRevision,
      "expectedActorRevision",
      128,
    ),
    transaction,
  };
}

function pathNumber(root: unknown, ...path: string[]): number | undefined {
  let value = root;
  for (const key of path) {
    if (
      !value ||
      typeof value !== "object" ||
      !(key in (value as Record<string, unknown>))
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function revision(actor: PF2eActorLike): string | undefined {
  const raw = actor._stats?.modifiedTime ?? actor._source?._stats?.modifiedTime;
  if (
    (typeof raw === "number" && Number.isFinite(raw)) ||
    typeof raw === "string"
  ) {
    const value = String(raw).trim();
    return value && value.length <= 128 && !value.includes("\0")
      ? value
      : undefined;
  }
  return undefined;
}

function itemIdentity(
  actor: PF2eActorLike,
): Pick<ActorSnapshot, "itemIDs" | "itemCount" | "itemsValid"> {
  const items = [...(actor.items ?? [])];
  const ids = items.map((item) =>
    typeof item.id === "string" ? item.id.trim() : "",
  );
  const safeIDs = ids.filter(
    (id) => id.length > 0 && id.length <= 128 && !id.includes("\0"),
  );
  return {
    itemIDs: safeIDs.sort(),
    itemCount: items.length,
    itemsValid:
      safeIDs.length === items.length &&
      new Set(safeIDs).size === safeIDs.length,
  };
}

function snapshot(actor: PF2eActorLike): ActorSnapshot {
  const level = pathNumber(actor.system, "details", "level", "value");
  if (level === undefined || !Number.isSafeInteger(level)) {
    throw new RpcError(
      "unsupported_actor",
      "PF2e character has no integer source level",
    );
  }
  return {
    level,
    revision: revision(actor),
    xpCurrent: pathNumber(actor.system, "details", "xp", "value"),
    xpThreshold: pathNumber(actor.system, "details", "xp", "max"),
    hpCurrent: pathNumber(actor.system, "attributes", "hp", "value"),
    hpMax: pathNumber(actor.system, "attributes", "hp", "max"),
    ...itemIdentity(actor),
  };
}

function requireCharacter(
  actorId: string,
  permission: "OBSERVER" | "OWNER",
): PF2eActorLike {
  const actor = actors<PF2eActorLike>().get(actorId);
  if (!actor) throw new RpcError("actor_not_found", `unknown actor ${actorId}`);
  assertCompanionPermission(actor, permission, actorId);
  if (actor.type !== "character") {
    throw new RpcError(
      "unsupported_actor",
      "PF2e advancement supports character actors only",
    );
  }
  if (typeof actor.update !== "function") {
    throw new RpcError(
      "unsupported_actor",
      "PF2e character cannot be updated through Actor.update",
    );
  }
  return actor;
}

function xpSnapshot(input: PreviewInput, actor: ActorSnapshot): XPSnapshot {
  const current = actor.xpCurrent;
  const threshold = actor.xpThreshold;
  if (input.advancementMode === "milestone") {
    return {
      current,
      threshold,
      after: current,
      // The signed module channel authenticates the agent, but it does not yet
      // carry a verified app-table GM principal or milestone grant. Never trust
      // the client-supplied boolean as authority.
      ready: false,
      deducted: 0,
    };
  }
  const valid =
    current !== undefined &&
    threshold !== undefined &&
    Number.isSafeInteger(current) &&
    Number.isSafeInteger(threshold) &&
    current >= 0 &&
    threshold > 0;
  const earned = valid && current >= threshold;
  return {
    current,
    threshold,
    after: earned ? current - threshold : current,
    ready: earned,
    deducted: earned ? threshold : 0,
  };
}

function previewFor(input: PreviewInput, permission: "OBSERVER" | "OWNER") {
  const runtime = assertSupportedRuntime();
  const actor = requireCharacter(input.actorId, permission);
  const current = snapshot(actor);
  const xp = xpSnapshot(input, current);
  const blockers: Array<{ code: string; message: string }> = [];
  const warnings: Array<{ code: string; message: string }> = [];

  if (input.expectedPackRevision !== PF2E_PACK_REVISION) {
    blockers.push({
      code: "pack_revision_mismatch",
      message: `expected Pathfinder pack revision ${PF2E_PACK_REVISION}`,
    });
  }
  if (current.level >= 20) {
    blockers.push({
      code: "maximum_level",
      message: "standard PF2e advancement stops at level 20",
    });
  }
  if (
    input.targetLevel !== current.level + 1 ||
    input.targetLevel < 2 ||
    input.targetLevel > 20
  ) {
    blockers.push({
      code: "invalid_level_transition",
      message:
        "targetLevel must be exactly one level above the current level and at most 20",
    });
  }
  if (!current.revision) {
    blockers.push({
      code: "actor_revision_unavailable",
      message: "Foundry did not expose a revision token for this actor",
    });
  }
  if (!hpPolicySatisfied(current, current)) {
    blockers.push({
      code: "hp_snapshot_unavailable",
      message:
        "the PF2e actor did not expose a valid current/maximum HP snapshot",
    });
  }
  if (!current.itemsValid || current.itemCount !== current.itemIDs.length) {
    blockers.push({
      code: "item_identity_invalid",
      message:
        "the PF2e actor contains an embedded Item without a unique bounded id",
    });
  }
  if (!xp.ready) {
    blockers.push({
      code:
        input.advancementMode === "milestone"
          ? "milestone_authority_unavailable"
          : "experience_not_ready",
      message:
        input.advancementMode === "milestone"
          ? "Foundry milestone apply requires a verified GM grant not present on this channel"
          : "the actor has not reached its configured XP threshold",
    });
  }
  if (input.gmOverrideReason) {
    blockers.push({
      code: "gm_override_authority_unavailable",
      message:
        "Foundry override apply requires a verified GM principal not present on this channel",
    });
  }

  const response = {
    schemaVersion: 1,
    runtime,
    actor: {
      actorId: actor.id ?? input.actorId,
      name: (actor.name ?? "").slice(0, 200),
      actorRevision: current.revision,
      currentLevel: current.level,
      targetLevel: input.targetLevel,
    },
    advancementMode: input.advancementMode,
    xp,
    hp: {
      current: current.hpCurrent,
      maximum: current.hpMax,
      policy: "pf2eLevelHookPreservesDamageDeficit",
    },
    automation: {
      mutation: "Actor.update",
      exactSourceLeaves: [
        "system.details.level.value",
        "system.details.xp.value",
      ],
      systemManaged: ["maximumHP", "classFeatures", "preparedStatistics"],
      decisions: "validateOnlyUntilPinnedAPIsExist",
      classAndChoiceCompletion: "notClaimedUntilFixtureProven",
    },
    blockers,
    warnings,
  };
  assertPayloadWithinCap(response);
  return { response, actor, current, xp, blockers };
}

async function signature(input: ApplyInput): Promise<string> {
  const t = input.transaction;
  const canonical = JSON.stringify([
    input.actorId,
    input.advancementMode,
    input.milestoneReady,
    input.expectedActorRevision,
    t.operationID,
    t.characterID,
    t.expectedSourceLevel,
    t.targetLevel,
    t.expectedPackRevision,
    t.decisions.map((d) => [d.slotID, d.kind, d.selectionID]),
    t.gmOverrideReason ?? "",
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseMarker(raw: unknown): AdvancementMarker | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.operationID !== "string" ||
    typeof value.signature !== "string" ||
    !UUID_RE.test(value.operationID) ||
    !SIGNATURE_RE.test(value.signature) ||
    typeof value.fromLevel !== "number" ||
    !Number.isSafeInteger(value.fromLevel) ||
    typeof value.targetLevel !== "number" ||
    !Number.isSafeInteger(value.targetLevel) ||
    value.fromLevel < 1 ||
    value.targetLevel !== value.fromLevel + 1 ||
    value.targetLevel > 20 ||
    typeof value.requestedAt !== "number" ||
    !Number.isSafeInteger(value.requestedAt) ||
    value.requestedAt <= 0 ||
    (value.expectedXPAfter !== undefined &&
      (typeof value.expectedXPAfter !== "number" ||
        !Number.isSafeInteger(value.expectedXPAfter) ||
        value.expectedXPAfter < 0))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    operationID: value.operationID,
    signature: value.signature,
    fromLevel: value.fromLevel,
    targetLevel: value.targetLevel,
    expectedXPAfter:
      typeof value.expectedXPAfter === "number"
        ? value.expectedXPAfter
        : undefined,
    requestedAt: value.requestedAt,
  };
}

function persistedMarkers(actor: PF2eActorLike): AdvancementMarker[] {
  let raw: unknown;
  if (typeof actor.getFlag === "function") {
    raw = actor.getFlag("table-companion", "pf2eAdvancementOperations");
  } else {
    const namespace = actor.flags?.["table-companion"];
    raw =
      namespace && typeof namespace === "object"
        ? (namespace as Record<string, unknown>).pf2eAdvancementOperations
        : undefined;
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-PERSISTED_OPERATION_LIMIT)
    .map(parseMarker)
    .filter((entry): entry is AdvancementMarker => !!entry);
}

function persistedMarker(
  actor: PF2eActorLike,
  operationID: string,
): AdvancementMarker | undefined {
  return persistedMarkers(actor).find(
    (entry) => entry.operationID === operationID,
  );
}

function markerLedgerWith(
  actor: PF2eActorLike,
  next: AdvancementMarker,
): AdvancementMarker[] {
  return [
    ...persistedMarkers(actor).filter(
      (entry) => entry.operationID !== next.operationID,
    ),
    next,
  ].slice(-PERSISTED_OPERATION_LIMIT);
}

function putRecord(record: OperationRecord): void {
  const replacing = operationJournal.has(record.operationID);
  if (
    !replacing &&
    operationJournal.size >= OPERATION_JOURNAL_LIMIT &&
    [...operationJournal.values()].every(
      (entry) => entry.outcome === "inProgress",
    )
  ) {
    throw new RpcError(
      "operation_journal_full",
      "advancement operation journal is full",
    );
  }
  operationJournal.delete(record.operationID);
  operationJournal.set(record.operationID, record);
  while (operationJournal.size > OPERATION_JOURNAL_LIMIT) {
    const oldest = operationJournal.keys().next().value;
    if (oldest === undefined) break;
    const candidate = operationJournal.get(oldest);
    if (candidate?.outcome === "inProgress") {
      // Keep active work. Move it to the tail and inspect the next record.
      operationJournal.delete(oldest);
      operationJournal.set(oldest, candidate);
    } else {
      operationJournal.delete(oldest);
    }
  }
}

function updateRecord(
  record: OperationRecord,
  patch: Partial<OperationRecord>,
): OperationRecord {
  const updated = { ...record, ...patch, updatedAt: Date.now() };
  putRecord(updated);
  return updated;
}

function activeOperation(actorId: string): OperationRecord | undefined {
  return [...operationJournal.values()].find(
    (record) => record.actorId === actorId && record.outcome === "inProgress",
  );
}

function changedItems(before: string[], after: string[]) {
  const oldSet = new Set(before);
  const newSet = new Set(after);
  return {
    added: after.filter((id) => !oldSet.has(id)),
    removed: before.filter((id) => !newSet.has(id)),
  };
}

function sameObservableState(
  before: ActorSnapshot,
  after: ActorSnapshot,
): boolean {
  return (
    before.level === after.level &&
    before.revision === after.revision &&
    before.xpCurrent === after.xpCurrent &&
    before.xpThreshold === after.xpThreshold &&
    before.hpCurrent === after.hpCurrent &&
    before.hpMax === after.hpMax &&
    before.itemCount === after.itemCount &&
    before.itemsValid === after.itemsValid &&
    before.itemIDs.length === after.itemIDs.length &&
    before.itemIDs.every((id, index) => id === after.itemIDs[index])
  );
}

function hpPolicySatisfied(
  before: ActorSnapshot,
  after: ActorSnapshot,
): boolean {
  if (
    before.hpCurrent === undefined ||
    before.hpMax === undefined ||
    after.hpCurrent === undefined ||
    after.hpMax === undefined ||
    !Number.isSafeInteger(before.hpCurrent) ||
    !Number.isSafeInteger(before.hpMax) ||
    !Number.isSafeInteger(after.hpCurrent) ||
    !Number.isSafeInteger(after.hpMax) ||
    before.hpCurrent < 0 ||
    before.hpMax <= 0 ||
    after.hpCurrent < 0 ||
    after.hpMax <= 0 ||
    before.hpCurrent > before.hpMax ||
    after.hpCurrent > after.hpMax
  ) {
    return false;
  }
  if (before.hpCurrent === 0) return after.hpCurrent === 0;
  return before.hpMax - before.hpCurrent === after.hpMax - after.hpCurrent;
}

function receipt(record: OperationRecord, actor?: PF2eActorLike) {
  let observed: ActorSnapshot | undefined;
  try {
    if (actor) observed = snapshot(actor);
  } catch {
    observed = undefined;
  }
  const items = observed
    ? changedItems(record.before.itemIDs, observed.itemIDs)
    : undefined;
  const response = {
    schemaVersion: 1,
    operationID: record.operationID,
    actorId: record.actorId,
    stage: record.stage,
    outcome: record.outcome,
    // Consequential unknown outcomes reconcile through pf2e.operation.status;
    // they are never a cue to blindly replay or fall back to a raw write.
    retryable: false,
    code: record.code,
    message: record.message,
    expected: {
      sourceLevel: record.fromLevel,
      targetLevel: record.targetLevel,
      xpAfter: record.expectedXPAfter,
    },
    observed: observed
      ? {
          actorRevision: observed.revision,
          level: observed.level,
          xpCurrent: observed.xpCurrent,
          hpCurrent: observed.hpCurrent,
          hpMaximum: observed.hpMax,
          itemChanges: items,
        }
      : undefined,
  };
  assertPayloadWithinCap(response);
  return response;
}

function verifyRecord(
  record: OperationRecord,
  actor: PF2eActorLike,
): OperationRecord {
  const observed = snapshot(actor);
  const appliedMarker = persistedMarker(actor, record.operationID);
  const levelOK = observed.level === record.targetLevel;
  const xpOK =
    record.expectedXPAfter === undefined ||
    observed.xpCurrent === record.expectedXPAfter;
  const hpOK = hpPolicySatisfied(record.before, observed);
  // Refetching Items is part of commit verification: Foundry ids must remain a
  // well-formed unique set after PF2e's class-feature grant hooks run. The
  // module reports the exact delta but does not invent an expected class table.
  const itemsOK =
    observed.itemsValid && observed.itemCount === observed.itemIDs.length;
  const markerOK =
    appliedMarker?.operationID === record.operationID &&
    appliedMarker.signature === record.signature;
  if (levelOK && xpOK && hpOK && itemsOK && markerOK) {
    return updateRecord(record, { stage: "completed", outcome: "accepted" });
  }
  return updateRecord(record, {
    stage: "needsReview",
    outcome: "needsReview",
    code: "verification_mismatch",
    message:
      "the refetched PF2e actor/items did not match the requested level, XP, HP policy, item identities, and operation marker",
  });
}

function reject(
  record: OperationRecord,
  code: string,
  message: string,
  actor?: PF2eActorLike,
) {
  const updated = updateRecord(record, {
    stage: "rejected",
    outcome: "rejected",
    code,
    message,
  });
  return receipt(updated, actor);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

export const pf2eAdvancementPreview: Procedure = async (payload) => {
  assertRequestWithinCap(payload, "advancement preview");
  return previewFor(parsePreviewInput(payload), "OBSERVER").response;
};

export const pf2eAdvancementApply: Procedure = async (payload) => {
  assertRequestWithinCap(payload, "advancement apply");
  assertSupportedRuntime();
  const input = parseApplyInput(payload);
  const operationID = input.transaction.operationID;
  const requestSignature = await signature(input);
  // Idempotent lookup is still an authenticated Actor operation: do not expose
  // a prior receipt merely because its operationID is known.
  const actor = requireCharacter(input.actorId, "OWNER");
  const existing = operationJournal.get(operationID);
  if (existing) {
    if (
      existing.signature !== requestSignature ||
      existing.actorId !== input.actorId
    ) {
      throw new RpcError(
        "operation_conflict",
        "operationID was already used for another request",
      );
    }
    const observed = actors<PF2eActorLike>().get(input.actorId);
    return receipt(existing, observed);
  }

  const before = snapshot(actor);
  const foundMarker = persistedMarker(actor, operationID);
  if (foundMarker) {
    if (foundMarker.signature !== requestSignature) {
      throw new RpcError(
        "operation_conflict",
        "operationID marker does not match this request",
      );
    }
    const recovered: OperationRecord = {
      operationID,
      actorId: input.actorId,
      signature: requestSignature,
      fromLevel: foundMarker.fromLevel,
      targetLevel: foundMarker.targetLevel,
      expectedXPAfter: foundMarker.expectedXPAfter,
      before,
      stage: "verifying",
      outcome: "inProgress",
      updatedAt: Date.now(),
    };
    putRecord(recovered);
    return receipt(verifyRecord(recovered, actor), actor);
  }

  const active = activeOperation(input.actorId);
  if (active) {
    throw new RpcError(
      "advancement_in_progress",
      `actor already has an in-progress advancement operation ${active.operationID}`,
    );
  }

  let record: OperationRecord = {
    operationID,
    actorId: input.actorId,
    signature: requestSignature,
    fromLevel: input.transaction.expectedSourceLevel,
    targetLevel: input.transaction.targetLevel,
    before,
    stage: "received",
    outcome: "inProgress",
    updatedAt: Date.now(),
  };
  putRecord(record);

  // The module channel currently proves the paired agent and actor permission,
  // not the originating app-table GM principal. Milestone grants and overrides
  // therefore remain standalone/peer-authoritative and fail closed here.
  if (input.advancementMode !== "experience") {
    return reject(
      record,
      "milestone_authority_unavailable",
      "Foundry milestone apply requires a verified GM grant not present on this channel",
      actor,
    );
  }
  if (input.transaction.gmOverrideReason) {
    return reject(
      record,
      "gm_override_authority_unavailable",
      "Foundry override apply requires a verified GM principal not present on this channel",
      actor,
    );
  }

  if (
    input.transaction.expectedSourceLevel + 1 !==
    input.transaction.targetLevel
  ) {
    return reject(
      record,
      "invalid_level_transition",
      "transaction must advance exactly one level",
      actor,
    );
  }
  if (before.level !== input.transaction.expectedSourceLevel) {
    return reject(
      record,
      "stale_source_level",
      "actor level no longer matches expectedSourceLevel",
      actor,
    );
  }
  if (input.expectedActorRevision !== before.revision) {
    return reject(
      record,
      "stale_actor_revision",
      "actor revision changed since preview",
      actor,
    );
  }
  if (input.transaction.expectedPackRevision !== PF2E_PACK_REVISION) {
    return reject(
      record,
      "pack_revision_mismatch",
      "unsupported Pathfinder pack revision",
      actor,
    );
  }
  // Decisions are parsed and provenance-safe, but no PF2e 8.3.0 API has yet been
  // fixture-proven for applying these heterogeneous choices atomically. Reject
  // instead of silently dropping them or writing broad source subtrees.
  if (input.transaction.decisions.length > 0) {
    return reject(
      record,
      "unsupported_decisions",
      "Foundry decision application is read-only until each decision kind has a pinned PF2e API",
      actor,
    );
  }

  const preview = previewFor(input, "OWNER");
  if (preview.blockers.length > 0) {
    const blocker = preview.blockers[0];
    return reject(
      record,
      blocker?.code ?? "advancement_blocked",
      blocker?.message ?? "blocked",
      actor,
    );
  }

  record.expectedXPAfter = preview.xp.after;
  record = updateRecord(record, { stage: "updating" });
  const operationMarker: AdvancementMarker = {
    schemaVersion: 1,
    operationID,
    signature: requestSignature,
    fromLevel: record.fromLevel,
    targetLevel: record.targetLevel,
    expectedXPAfter: record.expectedXPAfter,
    requestedAt: Date.now(),
  };
  const patch: Record<string, unknown> = {
    "system.details.level.value": record.targetLevel,
    "flags.table-companion.pf2eAdvancementOperations": markerLedgerWith(
      actor,
      operationMarker,
    ),
  };
  if (
    input.advancementMode === "experience" &&
    preview.xp.after !== undefined
  ) {
    patch["system.details.xp.value"] = preview.xp.after;
  }

  try {
    // This is intentionally one exact Actor.update call. PF2e owns the level
    // hook and all automatic Item/HP/preparation side effects.
    await actor.update(patch);
  } catch (error) {
    record = updateRecord(record, { stage: "verifying" });
    const observed = actors<PF2eActorLike>().get(input.actorId);
    if (!observed) {
      record = updateRecord(record, {
        stage: "unknown",
        outcome: "outcomeUnknown",
        code: "actor_unavailable_after_update",
        message:
          "the actor could not be refetched after Actor.update returned an error",
      });
      return receipt(record);
    }
    const now = snapshot(observed);
    if (
      sameObservableState(before, now) &&
      !persistedMarker(observed, operationID)
    ) {
      return reject(
        record,
        "actor_update_failed",
        safeErrorMessage(error),
        observed,
      );
    }
    record = updateRecord(record, {
      stage: "needsReview",
      outcome: "needsReview",
      code: "actor_update_partial",
      message:
        "Actor.update reported an error after observable actor state changed",
    });
    return receipt(record, observed);
  }

  record = updateRecord(record, { stage: "verifying" });
  const observed = actors<PF2eActorLike>().get(input.actorId);
  if (!observed) {
    record = updateRecord(record, {
      stage: "unknown",
      outcome: "outcomeUnknown",
      code: "actor_unavailable_after_update",
      message: "the actor could not be refetched after the level update",
    });
    return receipt(record);
  }
  record = verifyRecord(record, observed);
  return receipt(record, observed);
};

export const pf2eOperationStatus: Procedure = async (payload) => {
  assertRequestWithinCap(payload, "advancement status");
  assertSupportedRuntime();
  const value = object(payload);
  exactKeys(value, ["actorId", "operationID"], "status payload");
  const actorId = boundedString(value.actorId, "actorId", MAX_ACTOR_ID_LENGTH);
  const operationID = boundedString(value.operationID, "operationID", 36);
  if (!UUID_RE.test(operationID))
    throw new RpcError("invalid_args", "operationID must be a UUID");
  const actor = requireCharacter(actorId, "OBSERVER");
  const existing = operationJournal.get(operationID);
  if (existing) {
    if (existing.actorId !== actorId) {
      throw new RpcError(
        "operation_conflict",
        "operationID belongs to another actor",
      );
    }
    return receipt(existing, actor);
  }

  const foundMarker = persistedMarker(actor, operationID);
  if (foundMarker) {
    const recovered: OperationRecord = {
      operationID,
      actorId,
      signature: foundMarker.signature,
      fromLevel: foundMarker.fromLevel,
      targetLevel: foundMarker.targetLevel,
      expectedXPAfter: foundMarker.expectedXPAfter,
      before: snapshot(actor),
      stage: "verifying",
      outcome: "inProgress",
      updatedAt: Date.now(),
    };
    putRecord(recovered);
    return receipt(verifyRecord(recovered, actor), actor);
  }

  const unknown = {
    schemaVersion: 1,
    operationID,
    actorId,
    stage: "unknown",
    outcome: "outcomeUnknown",
    retryable: false,
    code: "operation_not_observed",
    message:
      "this responder has no bounded journal or actor marker for the operation",
  };
  assertPayloadWithinCap(unknown);
  return unknown;
};
