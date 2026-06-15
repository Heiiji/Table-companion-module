import { generatePassword } from "../util/password.js";
import { localize, log } from "../util/log.js";

/** The service-user name the agent logs in as. Mirrored in the agent README and
 * docs/foundry-protocol.md ("Companion"). */
export const COMPANION_USER_NAME = "Companion";

export interface CompanionResult {
  /** The freshly created (or pre-existing) Companion user's id. */
  userId: string;
  /** The plaintext password — shown to the GM ONCE, never stored by us. Only
   * present when we created the user this call. */
  password?: string;
  /** True when the user already existed and we did not touch it. */
  existed: boolean;
}

/** Find an existing Companion user, if any. */
export function findCompanionUser(): User | undefined {
  return game.users?.find((u) => u.name === COMPANION_USER_NAME) ?? undefined;
}

/**
 * Create the Companion service user with a crypto-strong generated password and
 * the TRUSTED role (lowest role that can hold OWNER ownership of actors, which
 * the agent needs for resource writes; the GM still grants per-actor ownership).
 * If the user already exists we leave it untouched and return its id — we never
 * reset a password the GM may already have linked into the app.
 *
 * Returns the plaintext password so the UI can show it once. We never persist or
 * log it.
 */
export async function ensureCompanionUser(): Promise<CompanionResult> {
  const existing = findCompanionUser();
  if (existing) {
    return { userId: existing.id!, existed: true };
  }

  const password = generatePassword();
  const created = (await User.create({
    name: COMPANION_USER_NAME,
    password,
    role: CONST.USER_ROLES.TRUSTED,
  })) as User | undefined;

  if (!created?.id) {
    throw new Error(localize("setup.error.createFailed"));
  }
  log.info(`created service user "${COMPANION_USER_NAME}" (${created.id})`);
  return { userId: created.id, password, existed: false };
}
