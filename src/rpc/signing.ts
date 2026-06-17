/**
 * Agent → module envelope authentication.
 *
 * Foundry's `module.*` socket relay carries no trustworthy sender identity, so
 * any connected session (including a malicious player) could otherwise forge an
 * envelope claiming `peer.role: "agent"`. We close that hole asymmetrically: the
 * agent holds an Ed25519 private key and signs every envelope it emits; the
 * module pins the agent's public key on first contact (trust-on-first-use) and
 * thereafter verifies every agent envelope against it.
 *
 * Asymmetric (not a shared HMAC secret) is required because Foundry has no
 * client-side store that a GM/agent can read but players cannot — world settings
 * and user flags are broadcast to every client. A *public* verification key is
 * safe to store in the open; only the agent ever holds the private half.
 *
 * The signed material is the exact UTF-8 bytes of `body` (the serialized
 * envelope), carried verbatim on the wire, so verification needs no cross-language
 * JSON canonicalization — the module verifies the literal bytes it was given,
 * then parses them.
 */

import { MAX_ENVELOPE_BYTES } from "../constants.js";

/** The wire shape of a signed message: the serialized envelope plus a detached
 * signature over its bytes. */
export interface SignedMessage {
  /** base64 Ed25519 signature over the UTF-8 bytes of `body`. */
  sig: string;
  /** The serialized envelope JSON that was signed (and is parsed after verify). */
  body: string;
}

/** Narrow an unknown socket payload to a SignedMessage, or null if it isn't one
 * (e.g. a legacy unsigned envelope, or noise). */
export function parseSignedMessage(raw: unknown): SignedMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.sig !== "string" || typeof m.body !== "string") return null;
  // Bound the serialized size on the raw wire string, BEFORE anyone JSON.parses
  // `body`, so a malicious peer can't force a large allocation/parse on every
  // connected client by flooding oversized messages.
  if (m.body.length > MAX_ENVELOPE_BYTES) return null;
  return { sig: m.sig, body: m.body };
}

// Both helpers return ArrayBuffer-backed views (not SharedArrayBuffer-backed) so
// they satisfy WebCrypto's BufferSource parameter type.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(enc.length));
  out.set(enc);
  return out;
}

// Cache the last imported key so a steady stream of agent envelopes doesn't
// re-import the same raw key on every message.
let keyCache: { b64: string; key: CryptoKey } | undefined;

async function importPublicKey(b64: string): Promise<CryptoKey | null> {
  if (keyCache?.b64 === b64) return keyCache.key;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      base64ToBytes(b64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    keyCache = { b64, key };
    return key;
  } catch {
    return null;
  }
}

/** Verify a SignedMessage against a base64 raw Ed25519 public key. Returns false
 * (never throws) on any malformed key, signature, or verification failure. */
export async function verifySignature(
  publicKeyB64: string,
  msg: SignedMessage,
): Promise<boolean> {
  const key = await importPublicKey(publicKeyB64);
  if (!key) return false;
  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      base64ToBytes(msg.sig),
      utf8(msg.body),
    );
  } catch {
    return false;
  }
}

/** A short, human-comparable fingerprint of a public key (first 8 bytes of its
 * SHA-256, hex). Shown in the setup UI so a GM can cross-check the paired agent
 * against what the app reports. */
export async function fingerprint(publicKeyB64: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      base64ToBytes(publicKeyB64),
    );
    return [...new Uint8Array(digest).slice(0, 8)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(":");
  } catch {
    return "";
  }
}
