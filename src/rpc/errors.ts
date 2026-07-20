/**
 * Structured RPC errors. A thrown `RpcError` carries a stable machine `code` the
 * channel copies verbatim into the `rpc.error` envelope, so the agent (and the
 * apps behind it) can branch on the failure kind instead of parsing a message.
 *
 * Codes in use: `permission_denied` (the paired Companion user lacks the required
 * per-actor ownership), `payload_too_large` (a response would exceed the envelope
 * cap), `procedure_timeout` (a handler exceeded the per-request deadline),
 * `invalid_args` (the request payload failed procedure-specific validation),
 * `unsupported_runtime` (the connected Foundry/system version does not support the
 * procedure), `binding_collision` (more than one Actor carries the same Table
 * Companion binding), `deleted_link` (the previously linked Actor no longer
 * exists), `binding_conflict` (the binding or assignedActorId points at a
 * different Actor than expected), `actor_not_found` (assignedActorId does not
 * identify an existing Actor), `stale_revision` (the Actor already carries a newer
 * approved revision), and `revision_conflict` (the same approved revision was
 * resubmitted with different content). Handlers that throw a plain `Error` still
 * map to the generic `procedure_failed`.
 */
import { MAX_ENVELOPE_BYTES } from "../constants.js";

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * Guard an outbound response payload against the envelope size cap, throwing a
 * structured `payload_too_large` RpcError when it would exceed it. A live Foundry
 * world can hold arbitrarily large actors / compendium documents; without this a
 * single oversized response would be silently rejected by the peer's inbound
 * `MAX_ENVELOPE_BYTES` guard (see rpc/signing.ts), so we fail loudly and early on
 * the producing side. Uses the serialized string length as a conservative byte
 * proxy — the same measure the inbound guard applies. */
export function assertPayloadWithinCap(payload: unknown): void {
  let size: number;
  try {
    size = JSON.stringify(payload)?.length ?? 0;
  } catch {
    return; // non-serializable: the emit path will surface that separately
  }
  if (size > MAX_ENVELOPE_BYTES) {
    throw new RpcError(
      "payload_too_large",
      `response payload (${size} bytes) exceeds the ${MAX_ENVELOPE_BYTES}-byte envelope cap`,
    );
  }
}
