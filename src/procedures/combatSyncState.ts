import type { Channel } from "../rpc/channel.js";
import type { Procedure } from "../rpc/registry.js";
import {
  foundryHooks,
  gameCombats,
  type CombatLike,
  type CombatantLike,
} from "../foundry/runtime.js";
import { isResponder } from "../setup/election.js";
import { pairedAgentUserId } from "../setup/identity.js";
import { supportsCombatSyncV1Runtime } from "./combatSync.js";
import {
  FLAG_KEYS,
  bindingId,
  contentsOf,
  docId,
  documentId,
  flagValue,
  type Dict,
} from "./upsertShared.js";

/**
 * The way back of the combat mirror: every Combat of the world as the
 * companion apps read it (`combat.state.v1`), in Foundry's own turn order with
 * the active combatant named, and our flags (the app combat a Combat mirrors,
 * the last sequence applied, the app entry a combatant mirrors). The elected
 * responder pushes it as the `combat.state` event on every Combat or Combatant
 * change; the backend also reads it after each handshake.
 */

/** Event name the snapshot is pushed under. */
export const COMBAT_STATE_EVENT = "combat.state";

const MAX_COMBATS = 16;
const MAX_COMBATANTS = 64;
const MAX_NAME = 120;
const MAX_ROUND = 9999;
const MAX_INITIATIVE = 1_000_000;
const DEBOUNCE_MS = 250;

interface CombatantStateV1 {
  id: string;
  actorId: string | null;
  name: string;
  initiative: number | null;
  hidden: boolean;
  appKey: string | null;
}

interface CombatStateEntryV1 {
  id: string;
  active: boolean;
  round: number;
  activeCombatantId: string | null;
  appCombatId: string | null;
  appliedSequence: number | null;
  combatants: CombatantStateV1[];
}

export interface CombatStateV1 {
  schemaVersion: 1;
  truncated: boolean;
  combats: CombatStateEntryV1[];
}

const idOrNull = (value: unknown, pattern: RegExp): string | null =>
  typeof value === "string" && pattern.test(value) ? value : null;

function combatantState(c: CombatantLike): CombatantStateV1 | null {
  const id = idOrNull(docId(c), documentId);
  if (!id) return null;
  const init = c.initiative;
  return {
    id,
    actorId: idOrNull(c.actorId, documentId),
    name: [...String(c.name ?? "").replaceAll("\0", "")]
      .slice(0, MAX_NAME)
      .join(""),
    initiative:
      typeof init === "number" && Number.isFinite(init)
        ? Math.max(-MAX_INITIATIVE, Math.min(MAX_INITIATIVE, init))
        : null,
    hidden: c.hidden === true,
    appKey: idOrNull(flagValue(c, FLAG_KEYS.combatantKey), bindingId),
  };
}

function combatState(
  combat: CombatLike,
  cut: () => void,
): CombatStateEntryV1 | null {
  const id = idOrNull(docId(combat), documentId);
  if (!id) return null;
  const flag = flagValue(combat, FLAG_KEYS.combatSync);
  const sync = typeof flag === "object" && flag !== null ? (flag as Dict) : {};
  const round = Number.isInteger(combat.round)
    ? Math.max(0, Math.min(MAX_ROUND, combat.round as number))
    : 0;
  // Foundry's turn order; a Combat whose turns were never set up yet falls
  // back to its collection order.
  const ordered = combat.turns?.length
    ? combat.turns
    : contentsOf(combat.combatants);
  const combatants = ordered
    .map(combatantState)
    .filter((c): c is CombatantStateV1 => c !== null);
  if (combatants.length > MAX_COMBATANTS) {
    combatants.length = MAX_COMBATANTS;
    cut();
  }
  const current =
    combat.combatant ??
    (combat.turn != null ? combat.turns?.[combat.turn] : undefined);
  const sequence = sync.appliedRevision;
  return {
    id,
    active: combat.active === true,
    round,
    activeCombatantId:
      round >= 1 ? idOrNull(docId(current ?? undefined), documentId) : null,
    appCombatId: idOrNull(sync.combatId, bindingId),
    appliedSequence:
      Number.isSafeInteger(sequence) && (sequence as number) >= 1
        ? (sequence as number)
        : null,
    combatants,
  };
}

/** Flagged first, then started, then active, then by id: the caps never cut
 * the combat the app shares. */
function rank(a: CombatStateEntryV1, b: CombatStateEntryV1): number {
  return (
    Number(b.appCombatId !== null) - Number(a.appCombatId !== null) ||
    Number(b.round >= 1) - Number(a.round >= 1) ||
    Number(b.active) - Number(a.active) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The snapshot of every Combat of the world. */
export function combatStateV1Snapshot(): CombatStateV1 {
  let truncated = false;
  const cut = () => (truncated = true);
  const combats = contentsOf(gameCombats())
    .map((c) => combatState(c, cut))
    .filter((c): c is CombatStateEntryV1 => c !== null)
    .sort(rank);
  if (combats.length > MAX_COMBATS) {
    combats.length = MAX_COMBATS;
    truncated = true;
  }
  return { schemaVersion: 1, truncated, combats };
}

/** `combat.state.v1`: the snapshot, on demand (a read; no argument). */
export const combatStateV1: Procedure = () => combatStateV1Snapshot();

const COMBAT_HOOKS = [
  "createCombat",
  "updateCombat",
  "deleteCombat",
  "createCombatant",
  "updateCombatant",
  "deleteCombatant",
];

/**
 * Push the snapshot to the backend on every Combat or Combatant change, from
 * the elected responder only and once paired (players' browsers never get
 * it). The hooks fire on every client for every change of the world, whatever
 * scene this tab views, so one responder sees them all. Debounced: a mirror
 * write or a combat start is several document writes. Also pushed shortly
 * after start, so a backend already connected learns the current state.
 */
export function startCombatStateWatcher(channel: Channel): void {
  if (!supportsCombatSyncV1Runtime()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    timer = undefined;
    if (!isResponder() || !pairedAgentUserId()) return;
    channel.emitEvent(COMBAT_STATE_EVENT, combatStateV1Snapshot());
  };
  const schedule = (delay = DEBOUNCE_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(publish, delay);
  };
  const hooks = foundryHooks();
  for (const hook of COMBAT_HOOKS) hooks?.on(hook, () => schedule());
  // A tab that becomes the responder (a GM joined or left) says it too.
  hooks?.on("userConnected", () => schedule(1000));
  schedule(1000);
}
