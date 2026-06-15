import { CHANNEL, ENVELOPE_VERSION } from "../constants.js";
import { isResponder } from "../setup/election.js";
import { log } from "../util/log.js";
import {
  Envelope,
  makeEnvelope,
  parseEnvelope,
  PeerInfo,
} from "./envelope.js";
import { ProcedureRegistry, RpcContext } from "./registry.js";

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

  constructor(
    private readonly registry: ProcedureRegistry,
    private readonly moduleVersion: string,
  ) {}

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
        capabilities: this.registry.capabilities(),
        peer: this.selfPeer(),
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
    return {
      role: "module",
      version: this.moduleVersion,
      minEnvelope: ENVELOPE_VERSION,
      maxEnvelope: ENVELOPE_VERSION,
    };
  }

  private async onMessage(raw: unknown): Promise<void> {
    const env = parseEnvelope(raw);
    if (!env) return;
    // We only understand our current major envelope version; ignore the rest so
    // a newer agent can roll forward without breaking older modules.
    if (env.v !== ENVELOPE_VERSION) return;

    switch (env.type) {
      case "hello":
        // Only the agent's greeting counts as a link; ignore other module
        // clients echoing their own hello on the shared channel.
        if (env.peer?.role !== "agent") break;
        this.noteAgent(env.peer);
        if (isResponder()) {
          this.emit(
            makeEnvelope("hello.ack", {
              id: env.id,
              capabilities: this.registry.capabilities(),
              peer: this.selfPeer(),
            }),
          );
        }
        break;

      case "hello.ack":
        // The agent acking the hello we sent on start — pure liveness signal.
        if (env.peer?.role === "agent") this.noteAgent(env.peer);
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

  private async handleRequest(env: Envelope): Promise<void> {
    const handler = env.proc ? this.registry.get(env.proc) : undefined;
    if (!handler) {
      this.emit(
        makeEnvelope("rpc.error", {
          id: env.id,
          error: {
            code: "unknown_procedure",
            message: `no procedure "${env.proc ?? ""}"`,
          },
        }),
      );
      return;
    }
    const ctx: RpcContext = { request: env };
    try {
      const result = await handler(env.payload, ctx);
      this.emit(makeEnvelope("rpc.response", { id: env.id, payload: result }));
    } catch (err) {
      log.error(`procedure "${env.proc}" failed`, err);
      this.emit(
        makeEnvelope("rpc.error", {
          id: env.id,
          error: {
            code: "procedure_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }
  }
}
