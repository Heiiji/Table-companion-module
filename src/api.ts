import type { Channel, LinkStatus } from "./rpc/channel.js";
import type { Procedure, ProcedureRegistry } from "./rpc/registry.js";
import { ENVELOPE_VERSION } from "./constants.js";

/**
 * The module's public, semver-governed API, exposed at
 * `game.modules.get("table-companion").api`.
 *
 * This is a stable contract for the agent's companion code, for in-house
 * system add-ons, and (eventually) for third parties when the module is
 * published to the Foundry package registry. Treat additions as minor-version
 * changes and removals/renames as major. Internal helpers are intentionally
 * NOT exported here.
 */
export interface TableCompanionApi {
  /** Running module version (semver, from module.json). */
  readonly version: string;
  /** Envelope schema version this build speaks. */
  readonly envelopeVersion: number;
  /** Procedure names this module currently advertises to the agent. */
  capabilities(): string[];
  /** Current agent <-> module link status. */
  getStatus(): LinkStatus;
  /** Register an additional RPC procedure. Its name becomes a new advertised
   * capability immediately. Use a namespaced name (e.g. "myaddon.doThing"). */
  registerProcedure(name: string, handler: Procedure): void;
  /** Subscribe to agent-pushed `event` envelopes. Returns an unsubscribe fn. */
  onAgentEvent(listener: (proc: string, payload: unknown) => void): () => void;
  /** Open the GM setup & status dialog. A stable fallback entry point in case a
   * future Foundry layout change hides the Settings button. */
  openSetup(): void;
}

export function buildApi(
  version: string,
  registry: ProcedureRegistry,
  channel: Channel,
  openSetup: () => void,
): TableCompanionApi {
  return {
    version,
    envelopeVersion: ENVELOPE_VERSION,
    capabilities: () => registry.capabilities(),
    getStatus: () => channel.getStatus(),
    registerProcedure: (name, handler) => registry.register(name, handler),
    onAgentEvent: (listener) => channel.onEvent(listener),
    openSetup,
  };
}
