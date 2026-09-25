import {
  MODULE_ID,
  SETTING_AGENT_USER,
  SETTING_COMPANION_ANCHOR,
} from "../constants.js";
import { log } from "../util/log.js";

/**
 * Which Foundry user the app's service account is, as the module knows it.
 *
 * Two world settings, both written only by a GM client:
 *
 * - **the paired agent user** — the user id the agent was sending as when the
 *   GM paired it. After pairing, the channel accepts agent traffic only from
 *   this user, and compendium reads are checked against its permissions.
 * - **the Companion anchor** — the id of the service user this module created.
 *   A pairing request from exactly this user is trusted without a click; any
 *   other user needs the GM's explicit "Trust".
 *
 * The `companion` flag stamped on the created user is NOT an identity: a player
 * may set flags on their own User, so a flag proves nothing about who created it.
 */

// fvtt-types models settings only for keys it knows; ours are accessed
// structurally at this one boundary. Registration happens in module.ts at init.
type SettingsLike = {
  get(namespace: string, key: string): unknown;
  set(namespace: string, key: string, value: unknown): Promise<unknown>;
};

function settings(): SettingsLike | undefined {
  return (globalThis as { game?: { settings?: unknown } }).game?.settings as
    | SettingsLike
    | undefined;
}

function read(key: string): string {
  try {
    const v = settings()?.get(MODULE_ID, key);
    return typeof v === "string" ? v : "";
  } catch {
    return ""; // not registered (tests, or before init)
  }
}

async function write(key: string, value: string): Promise<void> {
  try {
    await settings()?.set(MODULE_ID, key, value);
  } catch (err) {
    log.warn(`could not persist ${key}`, err);
  }
}

/** The paired agent's Foundry user id, or "" before pairing. */
export function pairedAgentUserId(): string {
  return read(SETTING_AGENT_USER);
}

export function setPairedAgentUserId(id: string): Promise<void> {
  return write(SETTING_AGENT_USER, id);
}

/** The id of the service user this module created, or "". */
export function companionAnchorId(): string {
  return read(SETTING_COMPANION_ANCHOR);
}

export function setCompanionAnchorId(id: string): Promise<void> {
  return write(SETTING_COMPANION_ANCHOR, id);
}

/** Minimal view of a Foundry user for identity decisions. */
export interface UserLike {
  id?: string | null;
  name?: string | null;
  isGM?: boolean;
  active?: boolean;
}

/** Look a user up by id in the live world, tolerant of the test harness. */
export function userById(id: string): UserLike | undefined {
  if (!id) return undefined;
  const users = (
    globalThis as {
      game?: { users?: { get?(id: string): UserLike | undefined } };
    }
  ).game?.users;
  return typeof users?.get === "function" ? users.get(id) : undefined;
}

/** The paired agent's Foundry user, if paired and still present. */
export function pairedAgentUser(): UserLike | undefined {
  return userById(pairedAgentUserId());
}
