import {
  foundryGame,
  gameActors,
  gameUsers,
  type ActorLike,
  type UserLike,
} from "../foundry/runtime.js";
import {
  OWNERSHIP_OBSERVER,
  actorID,
  allActors,
} from "../procedures/upsertShared.js";
import { log } from "../util/log.js";
import { companionAnchorId, pairedAgentUserId, userById } from "./identity.js";

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

/** Null when there is no Companion user or no actor collection to count. The
 * Companion user comes only from the GM-written identity settings (the paired
 * user, else the one this module created), never from a flag or a name a
 * player could copy: Share grants it access to other players' characters. */
export function companionVisibility(): CompanionVisibility | null {
  const companion = userById(pairedAgentUserId() || companionAnchorId());
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
 * GM only: give the Companion user OBSERVER on the player characters the GM
 * confirmed (`confirmed.unseen`) that are, now, still in the world, still
 * player-owned and still unseen — the world is re-read after the confirmation,
 * and each actor is re-tested just before its update, so a level raised
 * meanwhile is never lowered and no other actor is touched. One failed update
 * (an actor deleted mid-way) is logged and skipped. Returns how many changed.
 */
export async function shareUnseenWithCompanion(
  confirmed: CompanionVisibility,
): Promise<number> {
  if (!foundryGame()?.user?.isGM)
    throw new Error("only a Gamemaster can share characters with Companion");
  const now = companionVisibility();
  if (!now || now.companion.id !== confirmed.companion.id) return 0;
  const ids = new Set(confirmed.unseen.map(actorID));
  const { companion } = now;
  let changed = 0;
  for (const actor of now.unseen) {
    if (!ids.has(actorID(actor)) || can(actor, companion, "OBSERVER")) continue;
    try {
      await actor.update({ [`ownership.${companion.id}`]: OWNERSHIP_OBSERVER });
      changed += 1;
    } catch (err) {
      log.warn(`could not share actor ${actorID(actor)} with Companion`, err);
    }
  }
  return changed;
}
