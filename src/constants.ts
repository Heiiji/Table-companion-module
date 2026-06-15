/** The Foundry module id. Also the namespace used in document flags
 * (`flags["table-companion"]`) by the agent and the apps — keep in sync. */
export const MODULE_ID = "table-companion";

/** The Foundry socket event name the module and the agent rendez-vous on.
 * Foundry relays `module.<id>` socket emissions to every other connected
 * session, so the agent (logged in as the Companion user) and the browser
 * clients exchange envelopes here without the module ever knowing the agent's
 * address or credentials. Requires `"socket": true` in module.json. */
export const CHANNEL = `module.${MODULE_ID}`;

/** Envelope schema version this build speaks. Bump only on a breaking change to
 * the envelope shape; additive fields/procedures must NOT bump it. */
export const ENVELOPE_VERSION = 1;

/** How recent a `hello` from the agent must be for the link to read "live". */
export const LINK_STALE_MS = 90_000;
