import type { Channel, LinkStatus } from "./rpc/channel.js";
import type {
  Procedure,
  ProcedureDescriptor,
  ProcedureRegistry,
} from "./rpc/registry.js";
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
  /** Procedure names this module currently advertises to the agent.
   *
   * This is the WIRE list, not the raw registry: `actor.upsert.v1` is withheld
   * until this client can sign its replies, and the `moduleResponseSignatureV1`
   * token is included when it can. Reporting the registry instead would tell a
   * caller the module offers something the agent will never be shown. */
  capabilities(): string[];
  /** Current agent <-> module link status. */
  getStatus(): LinkStatus;
  /** Register an additional RPC procedure. Its name becomes a new advertised
   * capability immediately. Use a namespaced name (e.g. "myaddon.doThing").
   *
   * The descriptor is required: the advertised set is a promise the apps
   * feature-detect on, and the agent routes its fallback behaviour on the
   * declared `kind` (a read may fall back silently when it times out; a
   * mutation may not). An add-on cannot opt out of saying which it is. */
  registerProcedure(
    name: string,
    handler: Procedure,
    descriptor: ProcedureDescriptor,
  ): void;
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
    capabilities: () => channel.advertisedCapabilities(),
    getStatus: () => channel.getStatus(),
    registerProcedure: (name, handler, descriptor) =>
      registry.register(name, handler, descriptor),
    onAgentEvent: (listener) => channel.onEvent(listener),
    openSetup,
  };
}
