import {
  CAP_ACTOR_ITEMS_ARMOUR,
  CAP_ACTOR_RESOURCES_NAME,
  CAP_ACTOR_RESOURCES_WEAR,
  CAP_KNIGHT_ATTACK_ITEM_ID,
  CAP_KNIGHT_NPC_RESOURCES,
  CAP_BINDING_RECLAIM,
  CAP_BINDING_TAKEOVER,
  CAP_KNIGHT_SHEET_GLORY,
  CAP_KNIGHT_SHEET_WRITES,
  CAP_WRITE_BASE,
  WRITE_BASE_PROCEDURES,
  CAP_DND5E_RULES_MODERN,
  CAP_PF2E_NPC_WRITES,
  CAP_PF2E_SHEET_WRITES,
  CAP_RESPONSE_SIG,
  CHANNEL,
  DISPLAY_TAG,
  DROP_WARN_INTERVAL_MS,
  ENVELOPE_VERSION,
  KEY_ENROLL_EVENT,
  REPLAY_WINDOW_MS,
  REQUEST_TIMEOUT_MS,
  SEEN_ID_CACHE_MAX,
  SETTING_AGENT_KEY,
} from "../constants.js";
import { MODULE_ID } from "../constants.js";
import { supportsPf2eSheetWritesV1Runtime } from "../procedures/upsertShared.js";
import { isResponder } from "../setup/election.js";
import {
  companionAnchorId,
  pairedAgentUserId,
  setPairedAgentUserId,
  userById,
} from "../setup/identity.js";
import {
  dnd5eRulesVersion,
  foundryHooks,
  gameActors,
  gameSettings,
  gameSocket,
  uiNotifications,
  worldId as foundryWorldId,
} from "../foundry/runtime.js";
import { localize, log } from "../util/log.js";
import { Envelope, makeEnvelope, parseEnvelope, PeerInfo } from "./envelope.js";
import { ProcedureRegistry, RpcContext } from "./registry.js";
import { RpcError, type RpcErrorCode } from "./errors.js";
import { fingerprint, parseSignedMessage, verifySignature } from "./signing.js";
import type { ModuleResponseSigner } from "./responseSigning.js";
import { contentsOf, OWNERSHIP_OWNER } from "../procedures/upsertShared.js";

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
  /** The backend's verdict on the responder's reply key from its last hello /
   * hello.ack ("response_key_mismatch" | "world_mismatch"), or null when
   * healthy or never heard. */
  pairingIssue: string | null;
  /** The reply keys the backend lists as enrolled for this world in its last
   * hello / hello.ack, or null when it listed none (nothing enrolled yet, or a
   * backend that keeps a single key). */
  enrolledKeys: string[] | null;
  /** This browser's clock minus the backend's, from the last backend envelope
   * that reached the freshness check (ms), or null if none yet. */
  lastSkewMs: number | null;
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
interface PendingPairing {
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
    pairingIssue: null,
    enrolledKeys: null,
    lastSkewMs: null,
  };
  private readonly eventListeners = new Set<EventListener>();
  // Anti-replay: ids of recently-accepted agent envelopes (id -> accept time),
  // so a verbatim replay of a signed rpc.request can't re-trigger its handler.
  // Entries expire once the envelope could no longer pass the freshness window,
  // and the map is size-capped as a memory bound.
  private readonly seenIds = new Map<string, number>();
  /** The handler still running per procedure + character/actor/combat id. The
   * deadline answers the caller but does not stop a handler: a retry under a new
   * id waits for the one still writing instead of writing the same documents
   * beside it. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  // Pairing gate: a new agent key is considered ONLY while the GM has the setup
  // dialog open (an explicit "I am pairing now" window). Outside it, a
  // validly-signed envelope from an unknown key is dropped rather than pinned, so
  // a rogue agent cannot silently claim an unpaired world.
  private pairingWindowOpen = false;
  // A pairing request from a user other than the module-created service user,
  // held until the GM clicks Trust or Ignore in the setup dialog.
  private pending: (PendingPairing & { pubKey: string }) | null = null;
  /** Pairing refusals already toasted (`reason:userId`), so a backend that
   * re-sends its hello does not repeat the notice every few seconds. */
  private pairingNotices = new Set<string>();
  // Whether this client was the elected responder at the last check, so a
  // responder change can re-announce the capabilities (see start()).
  private wasResponder = false;

  // Rate-limited drop diagnostics: last log time per distinct cause.
  private readonly dropWarnAt = new Map<string, number>();

  // This responder's Ed25519 response-signing key, or null when the build
  // couldn't create one (older runtime) or this client is not signing. Set async
  // after `ready` via setResponseSigner(); only the responder ever signs.
  private responseSigner: ModuleResponseSigner | null = null;

  // Rotates this browser's response-signing key on "Reset pairing" and returns
  // the new signer (wired by module.ts, which owns the key storage). null in the
  // test harness, where reset only needs to clear the pinned agent key and user.
  private responseKeyResetter:
    (() => Promise<ModuleResponseSigner | null>) | null = null;

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
    if (!signer && isResponder()) {
      // Every reply from here goes out unsigned, and a backend that pinned a
      // reply key drops them all while setup still reads Live: say so.
      log.warn(
        "this browser has no response-signing key; replies go out unsigned",
      );
      notify("warn", localize("setup.notify.noSigner"));
    }
    // A key loaded while the setup is already open enrolls at once.
    if (signer && this.pairingWindowOpen) this.sendEnrollment("add");
    if (signer && isResponder()) {
      // Re-announce so an already-connected agent picks up the capability + key
      // without waiting for its next hello.
      this.sendHello();
    }
  }

  /** Wire the reset hook that rotates this browser's response-signing key when
   * the GM clicks "Reset pairing", resolving to the new signer. */
  setResponseKeyResetter(fn: () => Promise<ModuleResponseSigner | null>): void {
    this.responseKeyResetter = fn;
  }

  /** Whether the backend has enrolled this browser's reply key: null when this
   * browser has no key, or the backend listed no keys (nothing enrolled yet, or
   * a backend that keeps a single key — then its verdict alone says). */
  replyKeyEnrolled(): boolean | null {
    const keys = this.status.enrolledKeys;
    if (!this.responseSigner || !keys) return null;
    return keys.includes(this.responseSigner.publicKeyB64);
  }

  /** Ask the backend to enroll this browser's reply key for this Gamemaster
   * user. Sent while the setup dialog is open (on opening, and on each backend
   * hello) and, as "replace", right after « Reset pairing »: the dialog is the
   * explicit « this browser pairs now » moment, on any GM browser, responder or
   * not, so whichever of them answers later signs replies the backend accepts.
   * A backend that keeps a single key ignores it. */
  private sendEnrollment(mode: "add" | "replace"): void {
    const signer = this.responseSigner;
    if (!signer) return;
    this.emit(
      makeEnvelope("event", {
        proc: KEY_ENROLL_EVENT,
        payload: { mode },
        peer: { ...this.selfPeer(), pubKey: signer.publicKeyB64 },
        worldId: foundryWorldId(),
      }),
      this.agentRecipients(),
    );
  }

  /** True when this client will sign its responses (elected responder + a key). */
  private canSign(): boolean {
    return this.responseSigner !== null && isResponder();
  }

  /** Capabilities advertised in hello / hello.ack: the registered procedures,
   * plus the response-signing token when this client signs, and the
   * resources-name and Knight npc-resources tokens whenever
   * `actor.resources.v1` is advertised, the
   * write-base token with any lane that takes `base`, the
   * 2024-rules token with `dnd5e.resources.v1` on a world playing them, and
   * the Pathfinder 2e sheet-writes and npc-writes tokens with
   * `pf2e.resources.v1`, and the attack's item-id token with
   * `knight.attack.v1`.
   *
   * Public because this — not the raw registry — is what the agent actually
   * sees, so it is the only honest answer to "what does this module offer?".
   * The public API reports this list for the same reason. */
  advertisedCapabilities(): string[] {
    // Signed-only procedures (the consequential provisioning mutations) are
    // invisible until this elected GM responder can authenticate their replies.
    // This prevents a capability-only client from submitting work that can
    // never cross the signed-result gate.
    const caps = this.registry
      .capabilities()
      .filter((name) => !this.registry.isSignedOnly(name) || this.canSign());
    if (this.canSign()) caps.push(CAP_RESPONSE_SIG);
    // The name and wear fields and the Knight non-player types ride the resources
    // lane: advertised only with it.
    if (caps.includes("actor.resources.v1"))
      caps.push(
        CAP_ACTOR_RESOURCES_NAME,
        CAP_ACTOR_RESOURCES_WEAR,
        CAP_KNIGHT_NPC_RESOURCES,
        CAP_BINDING_TAKEOVER,
        CAP_BINDING_RECLAIM,
      );
    // The Knight sheet group rides the resources lane, its values in the
    // prepared numbers the statistics lane reads: advertised with both.
    if (
      caps.includes("actor.resources.v1") &&
      caps.includes("knight.statistics.v1")
    )
      caps.push(CAP_KNIGHT_SHEET_WRITES, CAP_KNIGHT_SHEET_GLORY);
    // The armour kind rides the items lane the same way.
    if (caps.includes("actor.items.v1")) caps.push(CAP_ACTOR_ITEMS_ARMOUR);
    // The attack's itemId rides the attack lane.
    if (caps.includes("knight.attack.v1")) caps.push(CAP_KNIGHT_ATTACK_ITEM_ID);
    // The base values ride the lanes that take them.
    if (WRITE_BASE_PROCEDURES.some((proc) => caps.includes(proc)))
      caps.push(CAP_WRITE_BASE);
    // The rules generation rides the Fifth Edition lane the same way.
    if (caps.includes("dnd5e.resources.v1") && dnd5eRulesVersion() === "modern")
      caps.push(CAP_DND5E_RULES_MODERN);
    // The Pathfinder 2e sheet groups ride that lane, where pf2e's currency
    // APIs exist.
    if (
      caps.includes("pf2e.resources.v1") &&
      supportsPf2eSheetWritesV1Runtime()
    )
      caps.push(CAP_PF2E_SHEET_WRITES);
    // The npc actor type rides the same lane on its own runtime gate: an npc
    // uses the character APIs, never the currency ones.
    if (caps.includes("pf2e.resources.v1")) caps.push(CAP_PF2E_NPC_WRITES);
    return caps.sort();
  }

  /** The procedures withheld on this runtime with their reason, for the
   * handshake and the setup panel — undefined (the field omitted) when nothing
   * is withheld. */
  withheldProcedures(): Record<string, string> | undefined {
    const withheld = this.registry.unsupported();
    return Object.keys(withheld).length > 0 ? withheld : undefined;
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
    // message that a client cannot forge. The relay ignores the listener's
    // promise, so its failure is logged here rather than left unhandled.
    gameSocket()?.on(CHANNEL, (raw: unknown, senderId?: unknown) =>
      this.onMessage(raw, senderId).catch((err: unknown) =>
        log.error("could not handle an agent message", err),
      ),
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
    // Foundry fires userConnected on a join and on a leave; there is no
    // userDisconnected hook.
    hooks?.on("userConnected", recheck);
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
        unsupported: this.withheldProcedures(),
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
    this.pairingNotices.clear();
    await this.pin(req.pubKey, req.userId);
    this.sendHello();
  }

  /** The GM declines the held pairing request. */
  ignorePendingPairing(): void {
    this.pending = null;
    this.pairingNotices.clear();
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
   * a full two-sided reset. Ends by announcing the module (a broadcast: nobody
   * is paired now), so a connected agent answers and pairs again at once — even
   * when this browser has no signing key and the rotation sent nothing. */
  async resetPairing(): Promise<void> {
    this.pending = null;
    this.pairingNotices.clear();
    await this.setPinnedKey("");
    await setPairedAgentUserId("");
    if (this.responseKeyResetter) {
      try {
        this.responseSigner = await this.responseKeyResetter();
        // Before the hello, so the backend never sees the new key unenrolled:
        // it replaces this user's old keys in this world only.
        this.sendEnrollment("replace");
      } catch (err) {
        log.warn("could not rotate the response-signing key on reset", err);
      }
    }
    log.info("agent pairing reset");
    this.sendHello();
  }

  /** Open the explicit pairing window: while it is open, a first validly-signed
   * agent key may be pinned (see verifiedAgentEnvelope). The setup UI calls this
   * when its dialog renders and closePairingWindow() when it tears down. */
  openPairingWindow(): void {
    this.pairingWindowOpen = true;
    this.sendEnrollment("add");
  }

  /** Close the explicit pairing window; an unknown agent key is no longer pinned. */
  closePairingWindow(): void {
    this.pairingWindowOpen = false;
  }

  private noteAgent(env: Envelope): void {
    this.status.lastAgentHelloAt = Date.now();
    this.status.agentPeer = env.peer ?? null;
    this.status.pairingIssue = env.pairing ?? null;
    this.status.enrolledKeys = env.responseKeys?.length
      ? env.responseKeys
      : null;
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
        this.noteAgent(env);
        // A backend that connects (or re-announces) while the setup is open
        // hears this browser's enrollment; one already enrolled is a no-op.
        if (this.pairingWindowOpen) this.sendEnrollment("add");
        if (isResponder()) {
          this.emit(
            makeEnvelope("hello.ack", {
              id: env.id,
              capabilities: this.advertisedCapabilities(),
              peer: this.selfPeer(),
              worldId: this.canSign() ? foundryWorldId() : undefined,
              unsupported: this.withheldProcedures(),
            }),
            [sender],
          );
        }
        break;

      case "hello.ack":
        // The agent acking the hello we sent on start — liveness, and its
        // verdict on our reply key.
        this.noteAgent(env);
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
    // A projector frame shares this socket by design (see display.ts); it is
    // not agent traffic, and logging it as a drop would fire on every client.
    if (typeof raw === "object" && raw !== null && DISPLAY_TAG in raw) {
      return null;
    }
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
      this.warnDrop("unparseable body");
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

    // Clock offset, for the setup panel: a drifted clock drops everything below
    // with only a console line. Sampled from the backend's own user only (the
    // paired one, else the service user this module created), so a player
    // cannot paint a bogus offset; the body is not verified yet.
    if (sender === (pairedAgentUserId() || companionAnchorId())) {
      this.status.lastSkewMs = Date.now() - env.ts;
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
      // The paired user first: it only drops, so a player's flood of
      // self-attributed envelopes costs no signature verify.
      const pinnedUser = pairedAgentUserId();
      if (pinnedUser && pinnedUser !== sender) {
        this.warnDrop("not sent by the paired agent user");
        return null;
      }
      if (!(await verifySignature(pinned, signed))) {
        this.warnDrop("invalid signature");
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
    // The backend's service user owns no Actor; a player account does. A
    // player-owned key is refused outright, never offered to the GM to trust.
    const ownsActor = contentsOf(gameActors()).some(
      (actor) => actor.ownership?.[sender] === OWNERSHIP_OWNER,
    );
    if (ownsActor) {
      this.warnDrop("pairing request from a user who owns an Actor");
      this.noticeOnce("OwnsActor", sender, user.name ?? sender);
      return null;
    }
    // One request is held at a time: another user's request never replaces it.
    if (this.pending && this.pending.userId !== sender) {
      this.warnDrop("second pairing request while one is pending");
      this.noticeOnce("OtherPending", sender, user.name ?? sender);
      return null;
    }
    // Any other user is held until the GM decides in the setup dialog.
    const fp = await fingerprint(env.peer.pubKey);
    const isNew =
      this.pending?.userId !== sender ||
      this.pending?.pubKey !== env.peer.pubKey;
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

  private noticeOnce(
    reason: "OwnsActor" | "OtherPending",
    userId: string,
    name: string,
  ): void {
    const key = `${reason}:${userId}`;
    if (this.pairingNotices.has(key)) return;
    this.pairingNotices.add(key);
    const pendingName = this.pending?.userName ?? "";
    notify(
      "warn",
      localize(`setup.notify.pairingRefused${reason}`, {
        name,
        pending: pendingName,
      }),
    );
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

  /** Election is by user, so two tabs of the same Gamemaster are both the
   * responder, and both receive the request (recipients are user ids): without a
   * guard both ran it — a provisioning request could create the Actor twice.
   * Only the tab that takes this browser's lock for the request id answers; the
   * others stay silent. The lock alone lasts only while the first tab runs the
   * request, so a copy arriving later in another tab would run it again: under
   * the lock, the tab also claims the id in `localStorage`, shared by every tab
   * of this browser, and a claimed id is never run twice. Web Locks need a
   * secure context: on plain-http Foundry `navigator.locks` is absent and the
   * claim alone stands in. */
  private async handleRequest(env: Envelope, sender: string): Promise<void> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } })
      .navigator?.locks;
    if (!env.id) return this.dispatchRequest(env, sender);
    if (!locks) {
      if (claimRequest(env.id)) await this.dispatchRequest(env, sender);
      return;
    }
    await locks.request(
      `${MODULE_ID}:${env.id}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock && claimRequest(env.id!))
          await this.dispatchRequest(env, sender);
      },
    );
  }

  private async dispatchRequest(env: Envelope, sender: string): Promise<void> {
    const proc = env.proc ?? "";
    const handler = env.proc ? this.registry.get(env.proc) : undefined;
    // The reply is signed with the key of the browser that accepted the request,
    // decided now: if the election moves while the handler runs, the write still
    // lands, and an unsigned reply would be dropped by the backend.
    const signer = this.canSign() ? this.responseSigner : null;
    // A procedure withheld from the advertised set (a consequential mutation on a
    // responder that cannot sign its reply) is refused exactly as if it did not
    // exist: hiding it from hello is not enough when a request names it directly.
    if (!handler || (this.registry.isSignedOnly(proc) && !signer)) {
      await this.sendError(signer, sender, env.id, proc, {
        code: "unknown_procedure",
        message: `no procedure "${proc}"`,
      });
      return;
    }
    const ctx: RpcContext = { request: env };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const key = serialKey(proc, env.payload);
      const previous = key ? this.inFlight.get(key) : undefined;
      const run = previous
        ? previous.then(() => handler(env.payload, ctx))
        : Promise.resolve(handler(env.payload, ctx));
      if (key) {
        const done: Promise<unknown> = run
          .catch(() => undefined)
          .finally(() => {
            if (this.inFlight.get(key) === done) this.inFlight.delete(key);
          });
        this.inFlight.set(key, done);
      }
      // Bound the handler: a wedged procedure (a stuck system API, a never-settling
      // await) must not hang the channel. Whichever settles first wins the race, so
      // exactly one response/error is emitted; a late handler resolution is ignored.
      // ponytail: a handler that never settles holds its key until reload; the
      // retries behind it still answer procedure_timeout.
      const result = await Promise.race([
        run,
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
      await this.sendResponse(signer, sender, env.id, proc, result);
    } catch (err) {
      // A refusal (stale_revision, base_conflict, invalid_args, …) is normal
      // flow: one line, no stack. A missed deadline is worth a warning; any
      // other exception is a fault.
      if (err instanceof RpcError)
        (err.code === "procedure_timeout" ? log.warn : log.info)(
          `procedure "${env.proc}" refused: ${err.code}: ${err.message}`,
        );
      else log.error(`procedure "${env.proc}" failed`, err);
      // A handler may throw a structured RpcError (permission_denied,
      // invalid_args, …) whose message is written for the caller. Anything else
      // is an unexpected failure: its text can name internals (document ids,
      // stack details), so it stays in this browser's log and the wire carries a
      // generic message.
      await this.sendError(
        signer,
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

  /** Emit an rpc.response to the agent that asked, signed with `signer` (the
   * key of the responder that accepted the request) when there is one. */
  private async sendResponse(
    signer: ModuleResponseSigner | null,
    to: string,
    requestId: string | undefined,
    proc: string,
    payload: unknown,
  ): Promise<void> {
    const env = makeEnvelope("rpc.response", { id: requestId, payload });
    await this.attachSignature(signer, env, requestId, proc, payload);
    this.emit(env, [to]);
  }

  /** Emit an rpc.error, signed like sendResponse. The signed body is the
   * `error` object, so a signed error cannot be swapped for a signed response
   * (the body hash differs). */
  private async sendError(
    signer: ModuleResponseSigner | null,
    to: string,
    requestId: string | undefined,
    proc: string,
    error: { code: RpcErrorCode; message: string },
  ): Promise<void> {
    const env = makeEnvelope("rpc.error", { id: requestId, error });
    await this.attachSignature(signer, env, requestId, proc, error);
    this.emit(env, [to]);
  }

  /** Attach `sig` + `signedAt` to a reply when there is a signer. A signing
   * failure logs and emits UNSIGNED; the agent (which requires a signature once
   * it has latched the capability) then drops the reply — fail-closed, the app
   * falls back to its local engine — rather than accepting an unauthenticated
   * reply. */
  private async attachSignature(
    signer: ModuleResponseSigner | null,
    env: Envelope,
    requestId: string | undefined,
    proc: string,
    body: unknown,
  ): Promise<void> {
    if (!signer || !requestId) return;
    try {
      const { sig, signedAt } = await signer.sign(
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

const CLAIM_PREFIX = `${MODULE_ID}:req:`;
/** As long as the replay cache remembers an id: past it, the envelope is stale
 * and refused before it gets here. */
const CLAIM_TTL_MS = 2 * REPLAY_WINDOW_MS;

/** The first tab of this browser to claim a request id answers it; claims
 * expire with the replay window and are pruned on each call. Without storage
 * (or when it throws) every tab answers, as before. Under a Web Lock the
 * get-then-set is atomic across tabs.
 * ponytail: without Web Locks (plain http) get-then-set is not atomic across
 * tabs; tabs receive a socket message at different moments, which is the race
 * this closes in practice. */
export function claimRequest(id: string, now = Date.now()): boolean {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    if (!store) return true;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (
        key?.startsWith(CLAIM_PREFIX) &&
        !(now - Number(store.getItem(key)) < CLAIM_TTL_MS)
      )
        store.removeItem(key);
    }
    if (store.getItem(CLAIM_PREFIX + id) !== null) return false;
    store.setItem(CLAIM_PREFIX + id, String(now));
    return true;
  } catch {
    return true;
  }
}

/** The serialization key of a request: its procedure and the character, actor or
 * combat it names; none when the payload names none. */
function serialKey(proc: string, payload: unknown): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const id = [p.characterId, p.actorId, p.combatId].find(
    (v) => typeof v === "string" && v !== "",
  );
  return id === undefined ? undefined : `${proc}:${String(id)}`;
}
