/**
 * Structured RPC errors. A thrown `RpcError` carries a stable machine `code` the
 * channel copies verbatim into the `rpc.error` envelope, so the backend (and
 * the apps behind it) can branch on the failure kind instead of parsing a
 * message. Codes are a shared contract: never rename or merge one. Each is
 * described in CONTRIBUTING.md « Error codes ».
 */
import { MAX_ENVELOPE_BYTES } from "../constants.js";

/** Every code the module answers in an `rpc.error`. */
export type RpcErrorCode =
  // Answered by the channel for any procedure.
  | "unknown_procedure"
  | "procedure_failed"
  | "procedure_timeout"
  | "payload_too_large"
  // Common to the procedures.
  | "invalid_args"
  | "permission_denied"
  | "unsupported_runtime"
  | "not_found"
  // Binding and identity of the written Actor.
  | "actor_not_found"
  | "binding_collision"
  | "binding_conflict"
  | "deleted_link"
  // Ordering and compare-and-set guards.
  | "stale_revision"
  | "revision_conflict"
  | "name_conflict"
  | "base_conflict"
  | "level_mismatch"
  | "item_conflict"
  | "item_missing"
  // Knight attacks.
  | "knight_api_missing"
  | "weapon_not_found"
  | "weapon_unsupported"
  | "attack_card_timeout";

export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
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
