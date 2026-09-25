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

/** Anti-replay: reject any signed envelope whose `ts` is outside ±this window
 * from now. Foundry relays every `module.*` emission to all sessions, so a
 * malicious player could otherwise capture a signed agent envelope and replay it
 * verbatim (the signature still verifies). Reusing the link-stale window keeps a
 * single notion of "recent." Requires the agent to stamp a fresh `ts`. */
export const REPLAY_WINDOW_MS = LINK_STALE_MS;

/** Anti-replay: memory bound on the recently-accepted envelope `id`s the channel
 * keeps to drop duplicate (replayed) requests. Ids expire by age (twice the
 * freshness window); this cap only stops the map growing without limit. */
export const SEEN_ID_CACHE_MAX = 4096;

/** Upper bound on a single inbound message's serialized size. This is a control
 * channel carrying small JSON messages; anything larger is malformed or hostile
 * (a flood/DoS attempt). We check the raw signed `body` string length BEFORE
 * `JSON.parse`, so an oversized message is dropped without allocating/parsing it
 * (see parseSignedMessage in rpc/signing.ts). Generous on purpose. */
export const MAX_ENVELOPE_BYTES = 64 * 1024;

/** World-setting key holding the pinned agent Ed25519 public key (base64). Empty
 * until the module pairs with an agent on first contact. config:false — it is
 * managed by the module/setup UI, not shown in Foundry's settings form. */
export const SETTING_AGENT_KEY = "agentPublicKey";

/** World-setting key holding the Foundry user id the agent sends as, pinned with
 * its key when the GM pairs. Afterwards the channel accepts agent traffic only
 * from this user. Written by the GM client; see src/setup/identity.ts. */
export const SETTING_AGENT_USER = "agentUserId";

/** World-setting key holding the id of the service user this module created
 * ("Create Companion user"). A pairing request from exactly this user needs no
 * extra confirmation; any other user needs the GM's explicit "Trust". */
export const SETTING_COMPANION_ANCHOR = "companionUserId";

/** CLIENT-scoped setting key holding THIS browser's module response-signing
 * Ed25519 keypair (exported JWK, contains the private `d`). scope:"client" is
 * deliberate and load-bearing: Foundry world settings are broadcast to every
 * connected client, so a world-scoped private key would be readable by any
 * player and could forge module responses — defeating the whole boundary. A
 * client-scoped setting lives only in the responder GM's browser localStorage
 * (per Foundry origin), never on the wire. Only the elected responder ever
 * generates/uses one. See src/rpc/responseSigning.ts. */
export const SETTING_MODULE_KEYPAIR = "moduleResponseKeypair";

/** Capability token the module advertises when this build can sign its
 * rpc.response / rpc.error envelopes (M8 transport authentication). When a world
 * advertises it, the agent REQUIRES a valid signature on every module reply and
 * drops unverified ones; without it, read-only relays stay best-effort
 * unauthenticated (today's behaviour). Parity-locked with the agent's
 * capModuleResponseSignatureV1. NOT a procedure name — it has no handler. */
export const CAP_RESPONSE_SIG = "moduleResponseSignatureV1";

/** Version tag prefixed to the canonical response-signing string (independent of
 * ENVELOPE_VERSION — it versions the signing scheme, not the envelope shape).
 *
 * **v2** binds the envelope TYPE into the signed bytes. Under v1 the type lived
 * outside the signature: a signed `rpc.error` could be replayed as an
 * `rpc.response` whose payload was exactly `{code, message}`, because both
 * canonicalize identically and every other signed field was unchanged. The
 * agent would then resolve a call with a garbage success instead of the
 * authored failure. Binding the type makes the two shapes unforgeable for each
 * other.
 *
 * The scheme tag is the FIRST field of the signed string, so a v1 signature can
 * never accidentally verify as v2 — the bytes differ before anything else is
 * read. Agent and module must move together; a mismatched pair fails closed
 * (reply dropped, 409, app falls back to its local engine). */
export const RESPONSE_SIG_SCHEME = "v2";

/** Per-request deadline for an rpc.request handler. A procedure that hangs (a
 * wedged system API, an await that never settles) would otherwise silently stall
 * the channel; on expiry we answer a structured `procedure_timeout` rpc.error and
 * move on. Generous: the heaviest procedures (a Knight actor upsert) are still
 * sub-second in practice. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Rate limit on the "dropped agent envelope" diagnostics: at most one log line
 * per distinct cause per this interval, so a flood of malformed/stale traffic
 * names its cause once without spamming the GM's console. */
export const DROP_WARN_INTERVAL_MS = 5_000;
