/**
 * Structured RPC errors. A thrown `RpcError` carries a stable machine `code` the
 * channel copies verbatim into the `rpc.error` envelope, so the agent (and the
 * apps behind it) can branch on the failure kind instead of parsing a message.
 *
 * Codes in use: `permission_denied` (the paired Companion user lacks the required
 * per-actor ownership), `payload_too_large` (a response would exceed the envelope
 * cap), `procedure_timeout` (a handler exceeded the per-request deadline). Handlers
 * that throw a plain `Error` still map to the generic `procedure_failed`.
 */
export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
