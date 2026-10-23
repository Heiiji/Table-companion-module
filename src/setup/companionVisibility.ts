import {
  foundryGame,
  gameActors,
  gameUsers,
  type ActorLike,
  type UserLike,
} from "../foundry/runtime.js";
import { allActors } from "../procedures/upsertShared.js";
import { findCompanionUser } from "./companion-user.js";

/** Foundry's OBSERVER ownership level (CONST.DOCUMENT_OWNERSHIP_LEVELS). */
export const OWNERSHIP_OBSERVER = 2;

/** Which player characters the Companion user can read. The backend reads the
 * world as that user, so a character it cannot observe never reaches the app. */
export interface CompanionVisibility {
  companion: UserLike & { id: string };
  /** Actors a player owns: a user who is neither a GM nor the Companion user. */
  total: number;
  /** Those the Companion user cannot observe, in collection order. */
  unseen: ActorLike[];
}

function can(
  actor: ActorLike,
  user: UserLike,
  permission: "OBSERVER" | "OWNER",
): boolean {
  return actor.testUserPermission?.(user, permission) === true;
}

/** Null when there is no Companion user or no actor collection to count. */
export function companionVisibility(): CompanionVisibility | null {
  const companion = findCompanionUser() as UserLike | undefined;
  const actors = gameActors();
  if (!companion?.id || !actors) return null;
  const players = (gameUsers()?.contents ?? []).filter(
    (user) => !user.isGM && user.id !== companion.id,
  );
  const characters = allActors(actors).filter((actor) =>
    players.some((user) => can(actor, user, "OWNER")),
  );
  return {
    companion: companion as UserLike & { id: string },
    total: characters.length,
    unseen: characters.filter((actor) => !can(actor, companion, "OBSERVER")),
  };
}

/**
 * GM only: give the Companion user OBSERVER on the unseen player characters of
 * `visibility`, and on nothing else. Each actor is re-tested just before its
 * update, so one that became observable meanwhile (an OWNER grant, say) is left
 * alone: no existing level is ever lowered. Returns how many actors changed.
 */
export async function shareUnseenWithCompanion(
  visibility: CompanionVisibility,
): Promise<number> {
  if (!foundryGame()?.user?.isGM)
    throw new Error("only a Gamemaster can share characters with Companion");
  const { companion } = visibility;
  let changed = 0;
  for (const actor of visibility.unseen) {
    if (can(actor, companion, "OBSERVER")) continue;
    await actor.update({ [`ownership.${companion.id}`]: OWNERSHIP_OBSERVER });
    changed += 1;
  }
  return changed;
}
