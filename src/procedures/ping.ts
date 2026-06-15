import type { Procedure } from "../rpc/registry.js";

/** M3 liveness probe. The agent can call this to confirm a responsive module
 * client beyond the passive hello/hello.ack handshake. Echoes any nonce back. */
export const ping: Procedure = (payload) => {
  const nonce =
    payload && typeof payload === "object" && "nonce" in payload
      ? (payload as { nonce: unknown }).nonce
      : undefined;
  return { pong: true, nonce, foundryVersion: game.version };
};
