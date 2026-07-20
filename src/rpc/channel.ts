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
import { worldId as foundryWorldId } from "../procedures/foundry.js";
import { log } from "../util/log.js";
import { Envelope, makeEnvelope, parseEnvelope, PeerInfo } from "./envelope.js";
import { ProcedureRegistry, RpcContext } from "./registry.js";
import { RpcError } from "./errors.js";
import { fingerprint, parseSignedMessage, verifySignature } from "./signing.js";
import type { ModuleResponseSigner } from "./responseSigning.js";

/** Best-effort access to Foundry's toast notifications, tolerant of the harness
 * where the `ui` global is absent. */
function notify(kind: "warn" | "info", message: string): void {
  const g = globalThis as unknown as {
    ui?: { notifications?: Record<string, ((m: string) => void) | undefined> };
  };
  g.ui?.notifications?.[kind]?.(message);
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

// fvtt-types models settings only for keys registered through its own typed
// surface; our world setting is accessed structurally (no `any`) at this one
// boundary. Registration happens in module.ts at init.
type SettingsLike = {
  get(namespace: string, key: string): unknown;
  set(namespace: string, key: string, value: unknown): Promise<unknown>;
};

/** Pairing state surfaced to the setup UI. */
export interface Pairing {
  /** Whether an agent signing key has been pinned for this world. */
  paired: boolean;
  /** Short human-comparable fingerprint of the pinned key, or "" if unpaired. */
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
  // Anti-replay: ids of recently-accepted agent envelopes, so a verbatim replay
  // of a signed rpc.request can't re-trigger its handler. Bounded FIFO.
  private readonly seenIds = new Set<string>();
  // TOFU gate: a new agent key is auto-pinned ONLY while the GM has the setup /
  // pairing dialog open (an explicit "I am pairing now" window). Outside it, a
  // validly-signed envelope from an unknown key is dropped rather than pinned, so
  // a rogue agent cannot silently claim an unpaired world.
  private pairingWindowOpen = false;

  // Rate-limited drop diagnostics: last log time per distinct cause.
  private readonly dropWarnAt = new Map<string, number>();

  // M8: this responder's Ed25519 response-signing key, or null when the build
  // couldn't create one (older runtime) or this client is not signing. Set async
  // after `ready` via setResponseSigner(); only the responder ever signs.
  private responseSigner: ModuleResponseSigner | null = null;

  // M8: rotates this browser's response-signing key on "Reset pairing" (wired by
  // module.ts, which owns the client-scoped keypair setting). null in the test
  // harness, where reset only needs to clear the pinned agent key.
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
   * plus the response-signing token when this client signs. */
  private advertisedCapabilities(): string[] {
    // Mutation-consequential procedures are invisible until this elected GM
    // responder can authenticate their replies. This prevents a capability-only
    // client from submitting work that can never cross the signed-result gate.
    const caps = this.registry
      .capabilities()
      .filter((name) => name !== "actor.upsert.v1" || this.canSign());
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
    game.socket?.on(CHANNEL, (raw: unknown) => this.onMessage(raw));
    log.info(`listening on socket channel "${CHANNEL}"`);
    // Announce ourselves so an agent that connected *before* this client opened
    // detects us without waiting for its next hello. The handshake is symmetric:
    // whoever hears a hello replies with hello.ack.
    this.sendHello();
  }

  /** Broadcast our presence + capabilities. */
  sendHello(): void {
    this.emit(
      makeEnvelope("hello", {
        capabilities: this.advertisedCapabilities(),
        peer: this.selfPeer(),
        worldId: this.canSign() ? foundryWorldId() : undefined,
      }),
    );
  }

  /** Proactively push an event to the agent (module → agent). */
  emitEvent(proc: string, payload: unknown): void {
    this.emit(makeEnvelope("event", { proc, payload, peer: this.selfPeer() }));
  }

  getStatus(): LinkStatus {
    return { ...this.status, isResponder: isResponder() };
  }

  /** The pinned agent public key (base64), or "" if not yet paired. */
  private pinnedKey(): string {
    const settings = game.settings as unknown as SettingsLike | undefined;
    const v = settings?.get(MODULE_ID, SETTING_AGENT_KEY);
    return typeof v === "string" ? v : "";
  }

  private async setPinnedKey(b64: string): Promise<void> {
    const settings = game.settings as unknown as SettingsLike | undefined;
    try {
      await settings?.set(MODULE_ID, SETTING_AGENT_KEY, b64);
    } catch (err) {
      log.warn("could not persist the agent signing key", err);
    }
  }

  /** Current pairing state, for the setup UI. */
  async getPairing(): Promise<Pairing> {
    const key = this.pinnedKey();
    return { paired: !!key, fingerprint: key ? await fingerprint(key) : "" };
  }

  /** Forget the pinned agent key so the next agent contact re-pairs (GM only —
   * writing the world setting requires GM rights). Also rotates THIS browser's
   * response-signing key (M8), so the agent must re-pin our identity too — a full
   * two-sided reset. */
  async resetPairing(): Promise<void> {
    await this.setPinnedKey("");
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
   * agent key may be auto-pinned (TOFU). The setup UI calls this when its dialog
   * renders and closePairingWindow() when it tears down. */
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

  private emit(env: Envelope): void {
    game.socket?.emit(CHANNEL, env);
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

  private async onMessage(raw: unknown): Promise<void> {
    // Every inbound type we handle is agent-originated, and Foundry's relay
    // cannot prove the sender. We therefore act only on a cryptographically
    // verified agent envelope; unsigned traffic and spoofed `peer.role:"agent"`
    // messages from a malicious player are dropped here.
    const env = await this.verifiedAgentEnvelope(raw);
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
          );
        }
        break;

      case "hello.ack":
        // The agent acking the hello we sent on start — pure liveness signal.
        this.noteAgent(env.peer!);
        break;

      case "ping":
        if (isResponder()) this.emit(makeEnvelope("pong", { id: env.id }));
        break;

      case "rpc.request":
        if (isResponder()) await this.handleRequest(env);
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

  /** Verify that `raw` is a signed envelope from the paired agent, returning the
   * parsed envelope on success or null (drop) otherwise. Pins the agent's key on
   * first contact (trust-on-first-use); only a GM/responder establishes the
   * pairing, so non-GM clients act on agent events only after a GM has paired. */
  private async verifiedAgentEnvelope(raw: unknown): Promise<Envelope | null> {
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

    // A4: only the elected responder ever acts on rpc.request/ping, so every
    // other client drops them here — before the per-message signature verify —
    // rather than verifying work it will never use. hello/hello.ack/event still
    // verify on all clients (they drive status + events everywhere).
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
        log.warn("dropped agent envelope with an invalid signature");
        return null;
      }
      return this.notReplayed(env) ? env : null;
    }

    // Not yet paired. TOFU is gated to the explicit pairing window: a GM must have
    // the setup dialog open to adopt a key. Outside it, a validly-signed envelope
    // from an unknown agent is dropped — never silently pinned.
    if (!isResponder() || !env.peer.pubKey) return null;
    if (!this.pairingWindowOpen) {
      log.warn("dropped an unknown agent key: the pairing window is closed");
      return null;
    }
    if (!(await verifySignature(env.peer.pubKey, signed))) {
      log.warn("dropped unpaired agent envelope with an invalid signature");
      return null;
    }
    await this.setPinnedKey(env.peer.pubKey);
    const fp = await fingerprint(env.peer.pubKey);
    log.info(`paired agent signing key (${fp})`);
    // Surface the new pairing so a GM can cross-check the fingerprint against what
    // the app reports and spot an unexpected key.
    notify("warn", `Table Companion: paired a new agent signing key (${fp})`);
    return this.notReplayed(env) ? env : null;
  }

  /** Anti-replay (2/2): true unless this envelope's `id` was already accepted.
   * Envelopes without an id (e.g. a broadcast hello) are always allowed —
   * freshness alone guards those. New ids are recorded in a bounded FIFO set so
   * a verbatim replay of a signed rpc.request can't re-run its handler. */
  private notReplayed(env: Envelope): boolean {
    const id = env.id;
    if (!id) return true;
    if (this.seenIds.has(id)) {
      log.warn(`dropped replayed agent envelope (id ${id})`);
      return false;
    }
    this.seenIds.add(id);
    if (this.seenIds.size > SEEN_ID_CACHE_MAX) {
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) this.seenIds.delete(oldest);
    }
    return true;
  }

  private async handleRequest(env: Envelope): Promise<void> {
    const proc = env.proc ?? "";
    const handler = env.proc ? this.registry.get(env.proc) : undefined;
    if (!handler) {
      await this.sendError(env.id, proc, {
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
      await this.sendResponse(env.id, proc, result);
    } catch (err) {
      log.error(`procedure "${env.proc}" failed`, err);
      await this.sendError(env.id, proc, {
        // A handler may throw a structured RpcError (permission_denied,
        // payload_too_large, …); anything else is a generic failure.
        code: err instanceof RpcError ? err.code : "procedure_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Emit an rpc.response, signed when this client is a signing responder. */
  private async sendResponse(
    requestId: string | undefined,
    proc: string,
    payload: unknown,
  ): Promise<void> {
    const env = makeEnvelope("rpc.response", { id: requestId, payload });
    await this.attachSignature(env, requestId, proc, payload);
    this.emit(env);
  }

  /** Emit an rpc.error, signed when this client is a signing responder. The
   * signed body is the `error` object, so a signed error cannot be swapped for a
   * signed response (the body hash differs). */
  private async sendError(
    requestId: string | undefined,
    proc: string,
    error: { code: string; message: string },
  ): Promise<void> {
    const env = makeEnvelope("rpc.error", { id: requestId, error });
    await this.attachSignature(env, requestId, proc, error);
    this.emit(env);
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
