// Unambiguous 57-character alphabet (no 0/O, 1/l/I) so a GM can read/copy the
// generated Companion password reliably. log2(57) ~= 5.83 bits/char.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

// Largest multiple of the alphabet size that fits in a byte; values at or above
// it are rejected so every character is uniformly distributed (no modulo bias).
const REJECT_AT = 256 - (256 % ALPHABET.length);

/** Generate a crypto-strong password using the Web Crypto API (available in
 * Foundry's browser/Electron runtime). Uses rejection sampling for an unbiased
 * draw. Default 24 chars ~= 140 bits (24 * log2(57)). */
export function generatePassword(length = 24): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] >= REJECT_AT) continue;
    out.push(ALPHABET[buf[0] % ALPHABET.length]);
  }
  return out.join("");
}
