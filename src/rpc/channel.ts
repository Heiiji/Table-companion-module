import {
  CAP_RESPONSE_SIG,
  CHANNEL,
  DROP_WARN_INTERVAL_MS,
  ENVELOPE_VERSION,
  REPLAY_WINDOW_MS,
  REQUEST_TIMEOUT_MS,
  SEEN_ID_CACHE_MAX,
  SETTING_AGENT_KEY,
} from "../constants.js";
import { MODULE_ID } from "../constants.js";
import { isResponder } from "../setup/election.js";
import {
  companionAnchorId,
  pairedAgentUserId,
  setPairedAgentUserId,
  userById,
} from "../setup/identity.js";
import {
  foundryHooks,
  gameSettings,
  gameSocket,
  uiNotifications,
  worldId as foundryWorldId,
} from "../foundry/runtime.js";
import { localize, log } from "../util/log.js";
import { Envelope, makeEnvelope, parseEnvelope, PeerInfo } from "./envelope.js";
import { ProcedureRegistry, RpcContext } from "./registry.js";
import { RpcError } from "./errors.js";
import { fingerprint, parseSignedMessage, verifySignature } from "./signing.js";
import type { ModuleResponseSigner } from "./responseSigning.js";

/** Consequential provisioning mutations that must never be advertised by a
 * responder that cannot sign its replies. Parity-locked with the agent's
 * relay-side signing requirement (internal/connector/modulechannel.go). */
const SIGNED_ONLY_PROCEDURES = new Set(["actor.upsert.v1", "npc.upsert.v1"]);

/** Best-effort access to Foundry's toast notifications, tolerant of the harness
 * where the `ui` global is absent. */
function notify(kind: "warn" | "info", message: string): void {
  uiNotifications()?.[kind]?.(message);
}

/** Snapshot of the agent <-> module link, surfaced to the status UI and the
 * public API. */
export interface LinkStatus {
  /** Unix ms of the last `hello` heard from the agent, or null if never. */
  lastAgentHelloAt: number | null;
  /** The agent's advertised identity from its last hello, if any. */
  agentPeer: PeerInfo | null;
  /** Whether this client is the elected responder right now. */
  isResponder: boolean;
}

type EventListener = (proc: string, payload: unknown) => void;

/** Pairing state surfaced to the setup UI. */
export interface Pairing {
  /** Whether an agent signing key has been pinned for this world. */
  paired: boolean;
  /** Short human-comparable fingerprint of the pinned key, or "" if unpaired. */
  fingerprint: string;
  /** Name of the Foundry user the paired agent sends as, or "". */
  agentUserName: string;
  /** A pairing request waiting for the GM's Trust / Ignore, or null. */
  pending: PendingPairing | null;
}

/** An agent that asked to pair from a user other than the one this module
 * created. It is held, not trusted, until the GM decides. */
export interface PendingPairing {
  userId: string;
  userName: string;
  fingerprint: string;
}

/**
 * Owns the `module.table-companion` socket conversation: answers the agent's
 * handshake/liveness, dispatches inbound rpc.requests to the registry, and
 * tracks link status. Agent->module is the only inbound direction implemented
 * today; the envelope already carries everything needed to add module->agent
 * requests later without a protocol change.
 */
export class Channel {
  private status: LinkStatus = {
    lastAgentHelloAt: null,
    agentPeer: null,
    isResponder: isResponder(),
  };
  private readonly eventListeners = new Set<EventListener>();
  // Anti-replay: ids of recently-accepted agent envelopes (id -> accept time),
  // so a verbatim replay of a signed rpc.request can't re-trigger its handler.
  // Entries expire once the envelope could no longer pass the freshness window,
  // and the map is size-capped as a memory bound.
  private readonly seenIds = new Map<string, number>();
  // Pairing gate: a new agent key is considered ONLY while the GM has the setup
  // dialog open (an explicit "I am pairing now" window). Outside it, a
  // validly-signed envelope from an unknown key is dropped rather than pinned, so
  // a rogue agent cannot silently claim an unpaired world.
  private pairingWindowOpen = false;
  // A pairing request from a user other than the module-created service user,
  // held until the GM clicks Trust or Ignore in the setup dialog.
  private pending: (PendingPairing & { pubKey: string }) | null = null;
  // Whether this client was the elected responder at the last check, so a
  // responder change can re-announce the capabilities (see start()).
  private wasResponder = false;

  // Rate-limited drop diagnostics: last log time per distinct cause.
  private readonly dropWarnAt = new Map<string, number>();

  // This responder's Ed25519 response-signing key, or null when the build
  // couldn't create one (older runtime) or this client is not signing. Set async
  // after `ready` via setResponseSigner(); only the responder ever signs.
  private responseSigner: ModuleResponseSigner | null = null;

  // Rotates this browser's response-signing key on "Reset pairing" (wired by
  // module.ts, which owns the key storage). null in the test harness, where
  // reset only needs to clear the pinned agent key and user.
  private responseKeyResetter: (() => Promise<void>) | null = null;

  constructor(
    private readonly registry: ProcedureRegistry,
    private readonly moduleVersion: string,
    private readonly requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  /** Install (or clear) this client's response-signing key. When present and this
   * client is the elected responder, the module advertises
   * `moduleResponseSignatureV1` + its public key and signs every rpc.response /
   * rpc.error. Idempotent; safe to call once the keypair has loaded. */
  setResponseSigner(signer: ModuleResponseSigner | null): void {
    this.responseSigner = signer;
    if (signer && isResponder()) {
      // Re-announce so an already-connected agent picks up the capability + key
      // without waiting for its next hello.
      this.sendHello();
    }
  }

  /** Wire the reset hook that rotates this browser's response-signing key when
   * the GM clicks "Reset pairing". */
  setResponseKeyResetter(fn: () => Promise<void>): void {
    this.responseKeyResetter = fn;
  }

  /** True when this client will sign its responses (elected responder + a key). */
  private canSign(): boolean {
    return this.responseSigner !== null && isResponder();
  }

  /** Capabilities advertised in hello / hello.ack: the registered procedures,
   * plus the response-signing token when this client signs.
   *
   * Public because this — not the raw registry — is what the agent actually
   * sees, so it is the only honest answer to "what does this module offer?".
   * The public API reports this list for the same reason. */
  advertisedCapabilities(): string[] {
    // Mutation-consequential procedures are invisible until this elected GM
    // responder can authenticate their replies. This prevents a capability-only
    // client from submitting work that can never cross the signed-result gate.
    const caps = this.registry
      .capabilities()
      .filter((name) => !SIGNED_ONLY_PROCEDURES.has(name) || this.canSign());
    if (this.canSign()) caps.push(CAP_RESPONSE_SIG);
    return caps.sort();
  }

  /** Log a dropped-envelope reason at most once per cause per DROP_WARN_INTERVAL_MS,
   * so noise/flooding names its cause without spamming the console. */
  private warnDrop(cause: string): void {
    const now = Date.now();
    if (now - (this.dropWarnAt.get(cause) ?? 0) < DROP_WARN_INTERVAL_MS) return;
    this.dropWarnAt.set(cause, now);
    log.warn(`dropped agent envelope: ${cause}`);
  }

  /** Begin listening. Safe to call once, after the `ready` hook (socket is up
   * from `init`, but we want game state for election + procedures). */
  start(): void {
    // Foundry's server relays a `module.*` event as (data, senderUserId), the
    // sender taken from the session on the server — the one fact about a
    // message that a client cannot forge.
    gameSocket()?.on(CHANNEL, (raw: unknown, senderId?: unknown) =>
      this.onMessage(raw, senderId),
    );
    log.info(`listening on socket channel "${CHANNEL}"`);
    // Announce ourselves so an agent that connected *before* this client opened
    // detects us without waiting for its next hello. Only the elected responder
    // announces: the agent replaces its capability list with the last hello it
    // hears, and every other client advertises less.
    this.wasResponder = isResponder();
    this.sendHello();
    // When the responder changes (a GM joins or leaves), the new one announces
    // itself so the agent's capability list follows it.
    const hooks = foundryHooks();
    const recheck = () => {
      const now = isResponder();
      if (now && !this.wasResponder) this.sendHello();
      this.wasResponder = now;
    };
    hooks?.on("userConnected", recheck);
    hooks?.on("userDisconnected", recheck);
  }

  /** Announce our presence + capabilities to the agent. Only the elected
   * responder speaks for the world. */
  sendHello(): void {
    if (!isResponder()) return;
    this.emit(
      makeEnvelope("hello", {
        capabilities: this.advertisedCapabilities(),
        peer: this.selfPeer(),
        worldId: this.canSign() ? foundryWorldId() : undefined,
      }),
      this.agentRecipients(),
    );
  }

  /** Proactively push an event to the agent (module → agent). */
  emitEvent(proc: string, payload: unknown): void {
    this.emit(
      makeEnvelope("event", { proc, payload, peer: this.selfPeer() }),
      this.agentRecipients(),
    );
  }

  /** Who module → agent traffic goes to: only the paired agent's user once
   * known, so players' browsers never receive it. Before pairing there is no
   * one to target, and the only such traffic (a hello) carries nothing private,
   * so it is broadcast. */
  private agentRecipients(): string[] | undefined {
    const id = pairedAgentUserId();
    return id ? [id] : undefined;
  }

  getStatus(): LinkStatus {
    return { ...this.status, isResponder: isResponder() };
  }

  /** The pinned agent public key (base64), or "" if not yet paired. */
  private pinnedKey(): string {
    const v = gameSettings()?.get(MODULE_ID, SETTING_AGENT_KEY);
    return typeof v === "string" ? v : "";
  }

  private async setPinnedKey(b64: string): Promise<void> {
    try {
      await gameSettings()?.set(MODULE_ID, SETTING_AGENT_KEY, b64);
    } catch (err) {
      log.warn("could not persist the agent signing key", err);
    }
  }

  /** Current pairing state, for the setup UI. */
  async getPairing(): Promise<Pairing> {
    const key = this.pinnedKey();
    const pending = this.pending
      ? {
          userId: this.pending.userId,
          userName: this.pending.userName,
          fingerprint: this.pending.fingerprint,
        }
      : null;
    return {
      paired: !!key,
      fingerprint: key ? await fingerprint(key) : "",
      agentUserName: key ? (userById(pairedAgentUserId())?.name ?? "") : "",
      pending,
    };
  }

  /** The GM trusts the held pairing request: pin its key and user, then
   * announce ourselves so the agent completes the handshake. */
  async trustPendingPairing(): Promise<void> {
    const req = this.pending;
    if (!req) return;
    this.pending = null;
    await this.pin(req.pubKey, req.userId);
    this.sendHello();
  }

  /** The GM declines the held pairing request. */
  ignorePendingPairing(): void {
    this.pending = null;
  }

  private async pin(pubKey: string, userId: string): Promise<void> {
    await this.setPinnedKey(pubKey);
    await setPairedAgentUserId(userId);
    const fp = await fingerprint(pubKey);
    log.info(`paired agent signing key (${fp}) for user ${userId}`);
    notify("info", localize("setup.notify.paired", { fingerprint: fp }));
  }

  /** Forget the pinned agent key and user so the next agent contact re-pairs
   * (GM only — writing the world settings requires GM rights). Also rotates THIS
   * browser's response-signing key, so the agent must re-pin our identity too —
   * a full two-sided reset. */
  async resetPairing(): Promise<void> {
    this.pending = null;
    await this.setPinnedKey("");
    await setPairedAgentUserId("");
    if (this.responseKeyResetter) {
      try {
        await this.responseKeyResetter();
      } catch (err) {
        log.warn("could not rotate the response-signing key on reset", err);
      }
    }
    log.info("agent pairing reset");
  }

  /** Open the explicit pairing window: while it is open, a first validly-signed
   * agent key may be pinned (see verifiedAgentEnvelope). The setup UI calls this
   * when its dialog renders and closePairingWindow() when it tears down. */
  openPairingWindow(): void {
    this.pairingWindowOpen = true;
  }

  /** Close the explicit pairing window; an unknown agent key is no longer pinned. */
  closePairingWindow(): void {
    this.pairingWindowOpen = false;
  }

  private noteAgent(peer: PeerInfo): void {
    this.status.lastAgentHelloAt = Date.now();
    this.status.agentPeer = peer;
  }

  /** Subscribe to module-bound `event` envelopes (agent push notifications). */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Send an envelope. With `recipients`, Foundry's server delivers it only to
   * those users' sessions; without, to every other connected session. */
  private emit(env: Envelope, recipients?: string[]): void {
    const socket = gameSocket();
    if (recipients?.length) socket?.emit(CHANNEL, env, { recipients });
    else socket?.emit(CHANNEL, env);
  }

  private selfPeer(): PeerInfo {
    const peer: PeerInfo = {
      role: "module",
      version: this.moduleVersion,
      minEnvelope: ENVELOPE_VERSION,
      maxEnvelope: ENVELOPE_VERSION,
    };
    // The agent pins this (trust-on-first-use) and verifies our signed responses
    // against it. Only advertised when we actually sign (responder + key), so the
    // agent never pins a key that will not be used.
    if (this.canSign()) peer.pubKey = this.responseSigner!.publicKeyB64;
    return peer;
  }

  private async onMessage(raw: unknown, senderId: unknown): Promise<void> {
    // Every inbound type we handle is agent-originated. We act only on an
    // envelope that is signed by the paired agent AND arrives from the Foundry
    // user it was signed for; unsigned traffic, spoofed `peer.role:"agent"`
    // messages and copies re-sent by another user are dropped here.
    const sender = typeof senderId === "string" ? senderId : "";
    const env = await this.verifiedAgentEnvelope(raw, sender);
    if (!env) return;

    switch (env.type) {
      case "hello":
        this.noteAgent(env.peer!);
        if (isResponder()) {
          this.emit(
            makeEnvelope("hello.ack", {
              id: env.id,
              capabilities: this.advertisedCapabilities(),
              peer: this.selfPeer(),
              worldId: this.canSign() ? foundryWorldId() : undefined,
            }),
            [sender],
          );
        }
        break;

      case "hello.ack":
        // The agent acking the hello we sent on start — pure liveness signal.
        this.noteAgent(env.peer!);
        break;

      case "ping":
        if (isResponder()) {
          this.emit(makeEnvelope("pong", { id: env.id }), [sender]);
        }
        break;

      case "rpc.request":
        if (isResponder()) await this.handleRequest(env, sender);
        break;

      case "event":
        if (env.proc) {
          // Isolate listeners: one throwing subscriber must not starve the rest
          // (this is a public-API surface via api.onAgentEvent).
          for (const l of this.eventListeners) {
            try {
              l(env.proc, env.payload);
            } catch (err) {
              log.error("onAgentEvent listener threw", err);
            }
          }
        }
        break;

      // hello.ack / pong / rpc.response / rpc.error are agent-bound replies to
      // our (future) outbound requests; nothing to do inbound today.
      default:
        break;
    }
  }

  /** Verify that `raw` is a signed envelope from the paired agent, sent by the
   * Foundry user it was signed for and for this world, returning the parsed
   * envelope on success or null (drop) otherwise. Pairing happens here too: only
   * the elected responder with the setup dialog open ever pins a new key. */
  private async verifiedAgentEnvelope(
    raw: unknown,
    sender: string,
  ): Promise<Envelope | null> {
    const signed = parseSignedMessage(raw);
    if (!signed) {
      // Not a signed message (or over the size cap): the channel is signed-only,
      // so this is noise or a spoof — never a supported unsigned peer.
      this.warnDrop("not a signed message (or over the size cap)");
      return null;
    }

    let inner: unknown;
    try {
      inner = JSON.parse(signed.body);
    } catch {
      return null;
    }
    const env = parseEnvelope(inner);
    if (!env || env.v !== ENVELOPE_VERSION) {
      this.warnDrop("unparseable or envelope version mismatch");
      return null;
    }
    if (env.peer?.role !== "agent") return null; // only the agent signs

    // The agent signs the user it is logged in as; Foundry's server attests who
    // actually sent this copy. A captured envelope re-sent by a player — from
    // this world or another — names a different user and stops here. (The body
    // is not verified yet; a forged userId still fails the signature below.)
    if (!sender || env.peer.userId !== sender) {
      this.warnDrop("sender is not the user the agent signed for");
      return null;
    }
    // One agent key signs for every world it serves, so the world is signed in.
    if (env.worldId !== foundryWorldId()) {
      this.warnDrop("signed for a different world");
      return null;
    }

    // Only the elected responder ever acts on rpc.request/ping, so every other
    // client drops them here — before the per-message signature verify —
    // rather than verifying work it will never use. hello/hello.ack/event still
    // verify on every client that receives them (they drive the status panel).
    if ((env.type === "rpc.request" || env.type === "ping") && !isResponder()) {
      return null;
    }

    // Anti-replay (1/2): drop stale envelopes before spending a signature verify.
    // A replayed capture carries its original `ts`, so it ages out of the window;
    // this also bounds how long a replayed `hello` can keep faking link liveness.
    if (Math.abs(Date.now() - env.ts) > REPLAY_WINDOW_MS) {
      this.warnDrop("outside the freshness window");
      return null;
    }

    const pinned = this.pinnedKey();
    if (pinned) {
      if (!(await verifySignature(pinned, signed))) {
        this.warnDrop("invalid signature");
        return null;
      }
      const pinnedUser = pairedAgentUserId();
      if (pinnedUser && pinnedUser !== sender) {
        this.warnDrop("not sent by the paired agent user");
        return null;
      }
      if (!this.notReplayed(env)) return null;
      // Worlds paired before the agent user was recorded: the first envelope that
      // verifies against the pinned key names it. Only a GM client can write it.
      if (!pinnedUser && isResponder()) await setPairedAgentUserId(sender);
      return env;
    }

    // Not yet paired. Pairing is gated to the explicit pairing window: a GM must
    // have the setup dialog open. Outside it, a validly-signed envelope from an
    // unknown agent is dropped — never silently pinned.
    if (!isResponder() || !env.peer.pubKey) return null;
    if (!this.pairingWindowOpen) {
      this.warnDrop("unknown agent key while the pairing window is closed");
      return null;
    }
    if (!(await verifySignature(env.peer.pubKey, signed))) {
      this.warnDrop("invalid signature on an unpaired envelope");
      return null;
    }
    // The agent logs in as a service user, never as a GM.
    const user = userById(sender);
    if (!user || user.isGM) {
      this.warnDrop("pairing request from a missing or Gamemaster user");
      return null;
    }
    if (sender === companionAnchorId()) {
      // The service user this module created: the GM already chose it.
      await this.pin(env.peer.pubKey, sender);
      return this.notReplayed(env) ? env : null;
    }
    // Any other user is held until the GM decides in the setup dialog.
    const fp = await fingerprint(env.peer.pubKey);
    const isNew =
      this.pending?.userId !== sender || this.pending?.pubKey !== env.peer.pubKey;
    this.pending = {
      pubKey: env.peer.pubKey,
      userId: sender,
      userName: user.name ?? sender,
      fingerprint: fp,
    };
    if (isNew) {
      notify(
        "warn",
        localize("setup.notify.pairingRequest", {
          name: user.name ?? sender,
          fingerprint: fp,
        }),
      );
    }
    return null;
  }

  /** Anti-replay (2/2): true unless this envelope's `id` was already accepted.
   * Called only after the signature verified, so unauthenticated traffic can
   * never fill the cache. Envelopes without an id (e.g. a broadcast hello) are
   * always allowed — freshness alone guards those. An id is remembered for twice
   * the freshness window (after that the envelope is stale anyway), so a
   * flood of other traffic cannot evict an id and re-open its replay. */
  private notReplayed(env: Envelope): boolean {
    const id = env.id;
    if (!id) return true;
    const now = Date.now();
    for (const [seen, at] of this.seenIds) {
      if (now - at <= 2 * REPLAY_WINDOW_MS) break; // insertion order = age order
      this.seenIds.delete(seen);
    }
    if (this.seenIds.has(id)) {
      this.warnDrop("replayed envelope id");
      return false;
    }
    this.seenIds.set(id, now);
    if (this.seenIds.size > SEEN_ID_CACHE_MAX) {
      const oldest = this.seenIds.keys().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return true;
  }

  private async handleRequest(env: Envelope, sender: string): Promise<void> {
    const proc = env.proc ?? "";
    const handler = env.proc ? this.registry.get(env.proc) : undefined;
    // A procedure withheld from the advertised set (a consequential mutation on a
    // responder that cannot sign its reply) is refused exactly as if it did not
    // exist: hiding it from hello is not enough when a request names it directly.
    if (!handler || (SIGNED_ONLY_PROCEDURES.has(proc) && !this.canSign())) {
      await this.sendError(sender, env.id, proc, {
        code: "unknown_procedure",
        message: `no procedure "${proc}"`,
      });
      return;
    }
    const ctx: RpcContext = { request: env };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound the handler: a wedged procedure (a stuck system API, a never-settling
      // await) must not hang the channel. Whichever settles first wins the race, so
      // exactly one response/error is emitted; a late handler resolution is ignored.
      const result = await Promise.race([
        Promise.resolve(handler(env.payload, ctx)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new RpcError(
                  "procedure_timeout",
                  `procedure "${env.proc}" exceeded the ${this.requestTimeoutMs}ms deadline`,
                ),
              ),
            this.requestTimeoutMs,
          );
        }),
      ]);
      await this.sendResponse(sender, env.id, proc, result);
    } catch (err) {
      log.error(`procedure "${env.proc}" failed`, err);
      // A handler may throw a structured RpcError (permission_denied,
      // invalid_args, …) whose message is written for the caller. Anything else
      // is an unexpected failure: its text can name internals (document ids,
      // stack details), so it stays in this browser's log and the wire carries a
      // generic message.
      await this.sendError(
        sender,
        env.id,
        proc,
        err instanceof RpcError
          ? { code: err.code, message: err.message }
          : { code: "procedure_failed", message: "module procedure failed" },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Emit an rpc.response to the agent that asked, signed when this client is a
   * signing responder. */
  private async sendResponse(
    to: string,
    requestId: string | undefined,
    proc: string,
    payload: unknown,
  ): Promise<void> {
    const env = makeEnvelope("rpc.response", { id: requestId, payload });
    await this.attachSignature(env, requestId, proc, payload);
    this.emit(env, [to]);
  }

  /** Emit an rpc.error, signed when this client is a signing responder. The
   * signed body is the `error` object, so a signed error cannot be swapped for a
   * signed response (the body hash differs). */
  private async sendError(
    to: string,
    requestId: string | undefined,
    proc: string,
    error: { code: string; message: string },
  ): Promise<void> {
    const env = makeEnvelope("rpc.error", { id: requestId, error });
    await this.attachSignature(env, requestId, proc, error);
    this.emit(env, [to]);
  }

  /** Attach `sig` + `signedAt` to a reply when this client signs. A signing
   * failure logs and emits UNSIGNED; the agent (which requires a signature once
   * it has latched the capability) then drops the reply — fail-closed, the app
   * falls back to its local engine — rather than accepting an unauthenticated
   * reply. */
  private async attachSignature(
    env: Envelope,
    requestId: string | undefined,
    proc: string,
    body: unknown,
  ): Promise<void> {
    if (!this.canSign() || !requestId) return;
    try {
      const { sig, signedAt } = await this.responseSigner!.sign(
        env.type,
        requestId,
        foundryWorldId(),
        proc,
        body,
      );
      env.sig = sig;
      env.signedAt = signedAt;
    } catch (err) {
      log.error("failed to sign rpc reply", err);
    }
  }
}
