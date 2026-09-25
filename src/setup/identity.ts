import {
  MODULE_ID,
  SETTING_AGENT_USER,
  SETTING_COMPANION_ANCHOR,
} from "../constants.js";
import {
  gameSettings,
  gameUsers,
  type UserLike,
} from "../foundry/runtime.js";
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

// Registration of these settings happens in module.ts at init.
function read(key: string): string {
  try {
    const v = gameSettings()?.get(MODULE_ID, key);
    return typeof v === "string" ? v : "";
  } catch {
    return ""; // not registered (tests, or before init)
  }
}

async function write(key: string, value: string): Promise<void> {
  try {
    await gameSettings()?.set(MODULE_ID, key, value);
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

/** Look a user up by id in the live world, tolerant of the test harness. */
export function userById(id: string): UserLike | undefined {
  if (!id) return undefined;
  const users = gameUsers();
  return typeof users?.get === "function" ? users.get(id) : undefined;
}

/** The paired agent's Foundry user, if paired and still present. */
export function pairedAgentUser(): UserLike | undefined {
  return userById(pairedAgentUserId());
}
