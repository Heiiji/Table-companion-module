import { isServiceUserId } from "./identity.js";

/** GM election.
 *
 * Many clients may have the module loaded, but exactly one should answer the
 * agent (reply to `hello`, run `roll.execute`, ...) to avoid duplicate work.
 * Follow Foundry's active GM when eligible. Otherwise let Foundry elect among
 * active human GMs using the same role and ID ordering. Every client still
 * *listens* for status display — election only gates who *responds*.
 */
export function responderGM() {
  // Defense-in-depth: the Companion service user is created non-GM, but if a GM
  // ever elevated it, it must still never elect itself as the responder. By id,
  // never by name: a human GM may be called anything.
  const users = game.users;
  const active = users?.activeGM;
  if (active && !isServiceUserId(active.id)) return active;

  return users?.getDesignatedUser(
    (user) => user.isGM && user.active && !isServiceUserId(user.id),
  );
}

export function isResponder(): boolean {
  const me = game.user;
  return !!me?.isGM && !isServiceUserId(me.id) && responderGM()?.id === me.id;
}
