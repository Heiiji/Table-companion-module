import { ENVELOPE_VERSION } from "../constants.js";

/** Envelope message types. Additive: new types may be added in later envelope
 * versions; receivers MUST ignore types they do not recognize. */
export type EnvelopeType =
  | "hello"
  | "hello.ack"
  | "ping"
  | "pong"
  | "rpc.request"
  | "rpc.response"
  | "rpc.error"
  | "event";

export interface PeerInfo {
  /** "agent" (the Go backend) or "module" (this Foundry module). */
  role: "agent" | "module";
  /** Sender's software version (semver). */
  version: string;
  /** Lowest / highest envelope version the sender can speak. */
  minEnvelope: number;
  maxEnvelope: number;
  /** Base64 raw Ed25519 public key — present on the agent's hello/hello.ack so
   * the module can pin it (trust-on-first-use) and verify the agent's
   * signatures. Absent for the module (it does not sign). */
  pubKey?: string;
}

/** The single message shape exchanged on the `module.table-companion` channel.
 * This is OUR protocol — not Foundry's — and rides Foundry's socket relay.
 * Evolution rule: additive only. Unknown fields, types, and `proc` names MUST
 * be ignored so old and new peers interoperate. Bump `v` only on a breaking
 * change. */
export interface Envelope {
  /** Envelope schema version. */
  v: number;
  type: EnvelopeType;
  /** Correlation id linking an rpc.request to its rpc.response/rpc.error. */
  id?: string;
  /** Procedure name for rpc.request, e.g. "ping", "roll.execute". */
  proc?: string;
  /** Advertised procedure names — present on hello / hello.ack. */
  capabilities?: string[];
  /** Sender identity + envelope range — present on hello / hello.ack. */
  peer?: PeerInfo;
  /** Procedure-specific body. */
  payload?: unknown;
  /** Present on rpc.error. */
  error?: { code: string; message: string };
  /** Unix ms timestamp. */
  ts: number;
}

/** Narrow an unknown socket payload to a well-formed Envelope, or return null.
 * Deliberately permissive about extra fields (forward-compat) and strict about
 * the two we branch on (`type`, `v`). */
export function parseEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.type !== "string") return null;
  if (typeof e.v !== "number") return null;
  return {
    v: e.v,
    type: e.type as EnvelopeType,
    id: typeof e.id === "string" ? e.id : undefined,
    proc: typeof e.proc === "string" ? e.proc : undefined,
    capabilities: Array.isArray(e.capabilities)
      ? (e.capabilities.filter((c) => typeof c === "string") as string[])
      : undefined,
    peer: isPeerInfo(e.peer) ? e.peer : undefined,
    payload: e.payload,
    error: isErr(e.error) ? e.error : undefined,
    ts: typeof e.ts === "number" ? e.ts : Date.now(),
  };
}

export function makeEnvelope(
  type: EnvelopeType,
  fields: Partial<Omit<Envelope, "v" | "type" | "ts">> = {},
): Envelope {
  return { v: ENVELOPE_VERSION, type, ts: Date.now(), ...fields };
}

function isPeerInfo(x: unknown): x is PeerInfo {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    (p.role === "agent" || p.role === "module") &&
    typeof p.version === "string" &&
    typeof p.minEnvelope === "number" &&
    typeof p.maxEnvelope === "number" &&
    (p.pubKey === undefined || typeof p.pubKey === "string")
  );
}

function isErr(x: unknown): x is { code: string; message: string } {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return typeof p.code === "string" && typeof p.message === "string";
}
