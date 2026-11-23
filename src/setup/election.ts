import { isServiceUserId } from "./identity.js";

/** GM election.
 *
 * Many clients may have the module loaded, but exactly one should answer the
 * agent (reply to `hello`, run `roll.execute`, ...) to avoid duplicate work.
 * Follow Foundry's active GM when eligible. Otherwise let Foundry elect among
 * active human GMs using the same role and ID ordering. Every client still
 * *listens* for status display — election only gates who *responds*.
 */
export function isResponder(): boolean {
  const me = game.user;
  if (!me?.isGM) return false;
  // Defense-in-depth: the Companion service user is created non-GM, but if a GM
  // ever elevated it, it must still never elect itself as the responder. By id,
  // never by name: a human GM may be called anything.
  if (isServiceUserId(me.id)) return false;

  const users = game.users;
  const active = users?.activeGM;
  if (active && !isServiceUserId(active.id)) return active.id === me.id;

  const fallback = users?.getDesignatedUser(
    (user) => user.isGM && user.active && !isServiceUserId(user.id),
  );
  return fallback != null && fallback.id === me.id;
}
