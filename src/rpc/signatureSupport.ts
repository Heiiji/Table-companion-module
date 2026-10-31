/** Whether this browser can verify the backend's Ed25519 signatures. WebCrypto's
 * `crypto.subtle` exists only in a secure context (https, or localhost), so on a
 * Foundry served over plain http every agent envelope would be dropped as an
 * invalid signature. Checked once at `ready` so setup can say why. */
export type SignatureSupport =
  "ok" | "insecure-context" | "no-subtle" | "no-ed25519";

// RFC 8032 test vector 1 public key: a valid Ed25519 point, imported only to
// learn whether this browser's WebCrypto knows Ed25519.
const PROBE_KEY = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9,
  0x64, 0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02,
  0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);

let last: SignatureSupport = "ok";

/** The result of the last {@link checkSignatureSupport} ("ok" before any). */
export function signatureSupport(): SignatureSupport {
  return last;
}

/** Probe this browser once and remember the result. Never throws. */
export async function checkSignatureSupport(): Promise<SignatureSupport> {
  last = await probe();
  return last;
}

async function probe(): Promise<SignatureSupport> {
  if (globalThis.isSecureContext !== true) return "insecure-context";
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "no-subtle";
  try {
    await subtle.importKey("raw", PROBE_KEY, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return "ok";
  } catch {
    return "no-ed25519";
  }
}
