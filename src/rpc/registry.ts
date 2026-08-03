import { log } from "../util/log.js";
import type { Envelope } from "./envelope.js";

/** Context handed to every procedure handler. */
export interface RpcContext {
  /** The full inbound request envelope. */
  request: Envelope;
}

/** A procedure handler. Return value becomes the rpc.response payload; throw
 * to produce an rpc.error. May be async. */
export type Procedure = (
  payload: unknown,
  ctx: RpcContext,
) => unknown | Promise<unknown>;

/**
 * What a procedure DOES to the connected Foundry world. The agent routes its
 * fallback behaviour on this: a read that times out may silently fall back to
 * the app's local engine (standalone-first), but a `mutation` whose outcome is
 * unknown must NEVER fall back silently — the write may still land in Foundry,
 * and a silent fallback is how the app sheet and the Foundry sheet end up
 * disagreeing with nobody able to tell which is real.
 *
 * - `read` — reads world state (or evaluates dice) and writes nothing.
 * - `mutation` — creates, updates or deletes a Foundry document.
 * - `clientState` — changes what a connected browser is DISPLAYING, but writes
 *   no document. Recoverable by repeating or clearing it, so it needs neither a
 *   read's silent fallback nor a mutation's ceremony.
 */
export type ProcedureKind = "read" | "mutation" | "clientState";

/**
 * The contract a procedure claims. Required at registration, so a procedure
 * cannot enter the advertised set without someone stating what it does and
 * where it works.
 */
export interface ProcedureDescriptor {
  kind: ProcedureKind;
  /** Companion-user permission the handler enforces on its target Actor.
   * Omitted when the procedure is not actor-scoped. */
  minPermission?: "OBSERVER" | "OWNER";
  /**
   * Foundry system ids this procedure has a verified contract for. Omit only
   * when the procedure is genuinely system-agnostic (`ping`, a core-API dice
   * evaluation). A system-specific procedure that omits this is how
   * `roll.action` came to be advertised on every non-PF2e world while
   * supporting exactly two.
   */
  systems?: readonly string[];
}

/** Maps procedure name -> handler. The set of registered names IS the module's
 * advertised capability list, so adding a milestone feature (e.g. M4
 * "roll.execute") is one registration call — no envelope or channel change.
 * This is also the extension point exposed publicly via the module API.
 *
 * The advertised set is a PROMISE: the apps feature-detect on it and route away
 * from their local engine when a capability appears. Registering something that
 * cannot succeed here is worse than registering nothing, so every entry carries
 * a {@link ProcedureDescriptor} saying what it does and where it works. */
export class ProcedureRegistry {
  private readonly procs = new Map<string, Procedure>();
  private readonly meta = new Map<string, ProcedureDescriptor>();

  register(
    name: string,
    handler: Procedure,
    descriptor: ProcedureDescriptor,
  ): void {
    if (this.procs.has(name)) {
      log.warn(`procedure "${name}" is being overwritten`);
    }
    this.procs.set(name, handler);
    this.meta.set(name, descriptor);
  }

  get(name: string): Procedure | undefined {
    return this.procs.get(name);
  }

  has(name: string): boolean {
    return this.procs.has(name);
  }

  /** The descriptor a procedure was registered with, if it is registered. */
  descriptor(name: string): ProcedureDescriptor | undefined {
    return this.meta.get(name);
  }

  /** Every registered procedure's descriptor, keyed by name. */
  descriptors(): Record<string, ProcedureDescriptor> {
    return Object.fromEntries(this.meta);
  }

  /** Registered names whose declared kind is `mutation`, sorted. The agent
   * mirrors this classification in Go — see docs/CONTRACTS.md. */
  mutations(): string[] {
    return [...this.meta.entries()]
      .filter(([, d]) => d.kind === "mutation")
      .map(([name]) => name)
      .sort();
  }

  /** Sorted, stable capability list advertised in hello / hello.ack. */
  capabilities(): string[] {
    return [...this.procs.keys()].sort();
  }
}
