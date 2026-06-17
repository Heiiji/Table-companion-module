import { MODULE_ID } from "../constants.js";
import { generatePassword } from "../util/password.js";
import { localize, log } from "../util/log.js";

/** The service-user name the agent logs in as. Mirrored in the agent README and
 * docs/foundry-protocol.md ("Companion"). */
export const COMPANION_USER_NAME = "Companion";

/** Flag key stamped on the user we create, so we can find it again even if a GM
 * renames it (the name is neither unique nor stable). */
const COMPANION_FLAG = "companion";

// fvtt-types models flags only for known core scopes, so our own module scope
// ("table-companion") is legitimately unknown to it. We read/write it through
// narrow structural types (no `any`) at this single boundary.
type FlagReader = { getFlag(scope: string, key: string): unknown };
type UserCreateData = Parameters<typeof User.create>[0];

export interface CompanionResult {
  /** The freshly created (or pre-existing) Companion user's id. */
  userId: string;
  /** The plaintext password — shown to the GM ONCE, never stored by us. Only
   * present when we created the user this call. */
  password?: string;
  /** True when the user already existed and we did not touch it. */
  existed: boolean;
}

/** Find an existing Companion user. Prefers the module flag we stamp on
 * creation (survives a rename); falls back to the name for users created before
 * the flag existed. */
export function findCompanionUser(): User | undefined {
  const users = game.users;
  if (!users) return undefined;
  return (
    users.find(
      (u) =>
        (u as unknown as FlagReader).getFlag(MODULE_ID, COMPANION_FLAG) === true,
    ) ??
    users.find((u) => u.name === COMPANION_USER_NAME) ??
    undefined
  );
}

/**
 * Create the Companion service user with a crypto-strong generated password and
 * the PLAYER role (least privilege). Ownership is independent of role: the
 * agent's actual reach comes from the per-actor OWNER/OBSERVER permission the GM
 * grants, not from the role — so PLAYER is the right default. It deliberately
 * avoids the world-level permissions TRUSTED adds over PLAYER (measured-template
 * / drawing creation and, where a world enables it for TRUSTED, FILES_UPLOAD —
 * writing media to the Foundry host's filesystem), which an automated account
 * whose password is handed to an external app should not carry. We stamp a
 * module flag so the user remains findable after a rename. If the user already
 * exists we leave it untouched and return its id — we never reset a password the
 * GM may already have linked into the app.
 *
 * Returns the plaintext password so the UI can show it once. We never persist or
 * log it.
 */
export async function ensureCompanionUser(): Promise<CompanionResult> {
  const existing = findCompanionUser();
  if (existing?.id) {
    return { userId: existing.id, existed: true };
  }

  const password = generatePassword();
  const created = (await User.create({
    name: COMPANION_USER_NAME,
    password,
    role: CONST.USER_ROLES.PLAYER,
    flags: { [MODULE_ID]: { [COMPANION_FLAG]: true } },
  } as unknown as UserCreateData)) as User | undefined;

  if (!created?.id) {
    throw new Error(localize("setup.error.createFailed"));
  }
  log.info(`created service user "${COMPANION_USER_NAME}" (${created.id})`);
  return { userId: created.id, password, existed: false };
}

/**
 * Generate a fresh password for the EXISTING Companion user and return it (shown
 * once, never stored). Unlike deleting and recreating the user, this preserves
 * its id and every per-actor ownership the GM has granted — so a fumbled copy no
 * longer costs the GM their setup. Throws if there is no Companion user yet; the
 * caller (setup UI) checks first and shows a friendly message.
 */
export async function resetCompanionPassword(): Promise<string> {
  const user = findCompanionUser();
  if (!user) throw new Error("no Companion user to reset");
  const password = generatePassword();
  await (
    user as unknown as { update(data: { password: string }): Promise<unknown> }
  ).update({ password });
  log.info("reset the Companion user password");
  return password;
}
