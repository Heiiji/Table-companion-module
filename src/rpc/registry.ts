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

/** Maps procedure name -> handler. The set of registered names IS the module's
 * advertised capability list, so adding a milestone feature (e.g. M4
 * "roll.execute") is one registration call — no envelope or channel change.
 * This is also the extension point exposed publicly via the module API. */
export class ProcedureRegistry {
  private readonly procs = new Map<string, Procedure>();

  register(name: string, handler: Procedure): void {
    if (this.procs.has(name)) {
      log.warn(`procedure "${name}" is being overwritten`);
    }
    this.procs.set(name, handler);
  }

  get(name: string): Procedure | undefined {
    return this.procs.get(name);
  }

  has(name: string): boolean {
    return this.procs.has(name);
  }

  /** Sorted, stable capability list advertised in hello / hello.ack. */
  capabilities(): string[] {
    return [...this.procs.keys()].sort();
  }
}
