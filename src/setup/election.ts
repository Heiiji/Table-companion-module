/** Zero-dependency GM election.
 *
 * Many clients may have the module loaded, but exactly one should answer the
 * agent (reply to `hello`, run `roll.execute`, ...) to avoid duplicate work.
 * Foundry designates a primary GM as `game.users.activeGM`; we defer to it, and
 * fall back to the lowest-id connected GM if Foundry reports none. Every client
 * still *listens* for status display — election only gates who *responds*.
 */
export function isResponder(): boolean {
  const me = game.user;
  if (!me?.isGM) return false;

  const active = game.users?.activeGM;
  if (active) return active.id === me.id;

  const gms = (game.users?.contents ?? [])
    .filter((u) => u.isGM && u.active)
    .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  return gms.length > 0 && gms[0].id === me.id;
}
