import { DROP_WARN_INTERVAL_MS } from "../constants.js";
import { log } from "../util/log.js";

/** The backend's event naming who has the Table Companion app open. */
export const APP_PRESENCE_EVENT = "app.presence";

/** Past this age the last snapshot no longer says anything about the players:
 * setup shows their state as unknown. */
export const APP_PRESENCE_STALE_MS = 3 * 60_000;

const MAX_SEATS = 32;
const MAX_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 128;
const STATES = ["inSession", "appOpen", "offline"] as const;

export type AppSeatState = (typeof STATES)[number];

/** One seat of the table, as the backend reports it. */
export interface AppSeat {
  memberId: string;
  /** The Foundry Actor bound to this seat, if any. */
  actorId?: string;
  /** The character's name in the app, if any. */
  label?: string;
  state: AppSeatState;
  /** Unix ms of the seat's last sign of life, if any. */
  lastSeenAt?: number;
}

export interface AppPresence {
  seats: AppSeat[];
  /** Unix ms at which this browser received the snapshot. */
  receivedAt: number;
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An optional string field: absent (undefined / null), or a string of at most
 * `max` characters. Returns false on a violation. */
function optString(v: unknown, max: number): string | undefined | false {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" && v.length <= max ? v : false;
}

/** The seats of a valid `app.presence` payload, or the first violation. Unknown
 * fields are ignored; only the documented ones are copied. */
function parseSeats(payload: unknown): AppSeat[] | string {
  if (!isDict(payload) || payload.v !== 1) return "unsupported payload";
  const raw = payload.seats;
  if (!Array.isArray(raw)) return "seats is not an array";
  if (raw.length > MAX_SEATS) return "too many seats";
  const seats: AppSeat[] = [];
  for (const s of raw) {
    if (!isDict(s)) return "seat is not an object";
    const { memberId, state, lastSeenAt } = s;
    if (
      typeof memberId !== "string" ||
      memberId.length === 0 ||
      memberId.length > MAX_ID_LENGTH
    ) {
      return "invalid memberId";
    }
    if (!STATES.includes(state as AppSeatState)) return "invalid state";
    const actorId = optString(s.actorId, MAX_ID_LENGTH);
    if (actorId === false) return "invalid actorId";
    const label = optString(s.label, MAX_LABEL_LENGTH);
    if (label === false) return "invalid label";
    if (
      lastSeenAt !== undefined &&
      lastSeenAt !== null &&
      !(typeof lastSeenAt === "number" && Number.isFinite(lastSeenAt))
    ) {
      return "invalid lastSeenAt";
    }
    const seat: AppSeat = { memberId, state: state as AppSeatState };
    if (actorId !== undefined) seat.actorId = actorId;
    if (label !== undefined) seat.label = label;
    if (typeof lastSeenAt === "number") seat.lastSeenAt = lastSeenAt;
    seats.push(seat);
  }
  return seats;
}

/** The last valid `app.presence` snapshot the backend pushed, kept in this
 * browser's memory only. Fed by the channel's event listeners, which run only
 * after an event passed the signature, sender and world checks. */
export class AppPresenceStore {
  private last: AppPresence | null = null;
  private lastWarnAt = 0;

  /** The channel event listener: takes `app.presence`, ignores every other
   * event, and drops a malformed snapshot whole (the previous one stays). */
  readonly onEvent = (proc: string, payload: unknown): void => {
    if (proc !== APP_PRESENCE_EVENT) return;
    const seats = parseSeats(payload);
    if (typeof seats === "string") {
      const now = Date.now();
      if (now - this.lastWarnAt >= DROP_WARN_INTERVAL_MS) {
        this.lastWarnAt = now;
        log.warn(`dropped app presence snapshot: ${seats}`);
      }
      return;
    }
    this.last = { seats, receivedAt: Date.now() };
  };

  /** The last valid snapshot, or null when none ever arrived. */
  get(): AppPresence | null {
    return this.last;
  }
}

/** This browser's store (only Gamemaster clients feed it: the backend sends the
 * event to them alone). */
export const appPresence = new AppPresenceStore();
