/**
 * Module -> agent response authentication (M8).
 *
 * The agent already signs every agent -> module envelope (see signing.ts); this
 * closes the reverse direction. Foundry's `module.*` socket relay carries no
 * trustworthy sender identity, so without this any connected player could inject
 * an rpc.response impersonating the module's answer. The elected responder GM
 * holds an Ed25519 keypair and signs every rpc.response / rpc.error it emits;
 * the agent pins the public key (trust-on-first-use) and verifies thereafter.
 *
 * Why a canonical signing STRING (not the raw-bytes wrapper the agent uses):
 * the signature travels as ADDITIVE `sig`/`signedAt` fields ON the envelope
 * (keeping the additive-only envelope contract, no second wire shape), so it
 * cannot sign the whole serialized envelope (that would contain `sig` itself).
 * Instead both sides independently build the exact same byte string:
 *
 *   v1|<requestId>|<worldId>|<procedure>|<signedAt>|<sha256hex(canonicalBody)>
 *
 * and Ed25519-sign / verify its UTF-8 bytes. The agent rebuilds it from the
 * request it issued (requestId/procedure), the pinned world id, and the
 * decoded response body. Field values never contain the `|` separator
 * (requestId is hex, worldId is a Foundry id, procedure is a dotted token).
 *
 * ---------------------------------------------------------------------------
 * CANONICAL JSON (canonicalize) — byte-identical with the agent's
 * internal/connector/moduleresponsesig.go. Shared vectors in
 * test/vectors/response_signing_vectors.json (== the agent's testdata copy):
 *
 *   null | boolean  -> "null" | "true" | "false"
 *   number          -> the ECMAScript JSON number token (JSON.stringify). The
 *                      agent receives this exact token over the socket
 *                      (json.Number) and re-emits it verbatim, so both anchor to
 *                      one serialization of the value — no reformatting either
 *                      side. Non-finite numbers are rejected.
 *   string          -> '"' + RFC 8785 minimal escaping + '"'; every other code
 *                      point (incl. non-ASCII) is literal UTF-8.
 *   array           -> "[" + elements joined by "," + "]"   (no whitespace)
 *   object          -> keys ascending by UTF-8 byte order,
 *                      "{" + '"k":v' joined by "," + "}"     (no whitespace)
 * ---------------------------------------------------------------------------
 */

import { RESPONSE_SIG_SCHEME } from "../constants.js";
import type { KeyStore, StoredKeyPair } from "../util/keyStore.js";

/** RFC 8785 minimal string escaping; all other code points literal UTF-8. */
function canonicalString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x09) out += "\\t";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0d) out += "\\r";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

const utf8 = new TextEncoder();

/** Compare two strings by their UTF-8 byte sequences (matches Go sort.Strings). */
function compareUtf8(a: string, b: string): number {
  const ea = utf8.encode(a);
  const eb = utf8.encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    if (ea[i] !== eb[i]) return ea[i] - eb[i];
  }
  return ea.length - eb.length;
}

/** Serialize a JSON value to its canonical string form (see file header). */
export function canonicalize(v: unknown): string {
  if (v === null || v === undefined) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v))
      throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(v);
  }
  if (t === "string") return canonicalString(v as string);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(compareUtf8);
    return (
      "{" +
      keys
        .map((k) => canonicalString(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("cannot canonicalize value of type " + t);
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(s));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build the canonical signing string for a response body.
 *
 * `type` is the envelope type being signed — `"rpc.response"` or `"rpc.error"`.
 * It is bound into the signature (scheme v2) because a signed error's body
 * `{code, message}` canonicalizes identically to a response payload of the same
 * shape, so without it one could be replayed as the other. Parity-locked with
 * the agent's `moduleResponseSigningString`. */
export async function responseSigningString(
  type: string,
  requestId: string,
  worldId: string,
  procedure: string,
  signedAt: number,
  body: unknown,
): Promise<string> {
  const bodyHash = await sha256hex(canonicalize(body));
  return `${RESPONSE_SIG_SCHEME}|${type}|${requestId}|${worldId}|${procedure}|${signedAt}|${bodyHash}`;
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

function bytesToB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

/** The signed material this signer attaches to an rpc.response / rpc.error. */
export interface ResponseSignature {
  /** base64 Ed25519 signature over the canonical signing string. */
  sig: string;
  /** Unix ms the signature was produced (the `signedAt` in the string). */
  signedAt: number;
}

/**
 * Holds the responder GM's Ed25519 keypair and signs response envelopes. Created
 * once per GM client and persisted so the agent's pin survives reloads — as a
 * non-extractable key in IndexedDB where the browser allows it (see
 * loadOrCreateSigner). Only the elected responder ever signs with it.
 */
export class ModuleResponseSigner {
  private constructor(
    private readonly privateKey: CryptoKey,
    /** base64 raw (32-byte) public key advertised to the agent. */
    readonly publicKeyB64: string,
  ) {}

  /** Sign a response body, returning the wire `sig` + `signedAt`. `type` is the
   * envelope type being signed (`"rpc.response"` / `"rpc.error"`); it is part of
   * the signed bytes so the two cannot be swapped for each other. */
  async sign(
    type: string,
    requestId: string,
    worldId: string,
    procedure: string,
    body: unknown,
  ): Promise<ResponseSignature> {
    const signedAt = Date.now();
    const message = await responseSigningString(
      type,
      requestId,
      worldId,
      procedure,
      signedAt,
      body,
    );
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      this.privateKey,
      utf8.encode(message),
    );
    return { sig: bytesToB64(sig), signedAt };
  }

  /** The key material to persist in a {@link KeyStore}. */
  toStored(): StoredKeyPair {
    return { privateKey: this.privateKey, publicKeyB64: this.publicKeyB64 };
  }

  /** Wrap a key loaded from a {@link KeyStore}. */
  static fromStored(pair: StoredKeyPair): ModuleResponseSigner {
    return new ModuleResponseSigner(pair.privateKey, pair.publicKeyB64);
  }

  /** Import a signer from a previously exported private JWK. `extractable`
   * false is the migration path into a {@link KeyStore}: the imported key can
   * sign but can never be exported again. */
  static async fromJwk(
    jwk: JsonWebKey,
    extractable = true,
  ): Promise<ModuleResponseSigner> {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      extractable,
      ["sign"],
    );
    // The public key is the JWK's `x` (base64url raw), re-encoded as base64 std.
    const raw = base64UrlToBytes(jwk.x ?? "");
    return new ModuleResponseSigner(privateKey, bytesToB64(raw));
  }

  /** Generate a fresh keypair whose private key can never be exported. */
  static async generateNonExtractable(): Promise<ModuleResponseSigner> {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    // A public key is always exportable, whatever the pair's extractable flag.
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    return new ModuleResponseSigner(pair.privateKey, bytesToB64(raw));
  }

  /** Generate a fresh keypair. Returns the signer and the exported private JWK
   * to persist — the fallback for a browser without a usable {@link KeyStore}. */
  static async generate(): Promise<{
    signer: ModuleResponseSigner;
    jwk: JsonWebKey;
  }> {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    const signer = new ModuleResponseSigner(pair.privateKey, bytesToB64(raw));
    return { signer, jwk };
  }
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Where the signer's key is persisted. `keyStore` is the preferred home (a
 * non-extractable key in IndexedDB); the JWK accessors are the client-setting
 * path used by older builds, kept for migration and as the fallback. */
export interface SignerStorage {
  getJwk(): JsonWebKey | null;
  setJwk(jwk: JsonWebKey | null): Promise<void>;
  keyStore: KeyStore | null;
  /** Called when the key could not be kept in `keyStore` and the JWK path is
   * used instead, so the GM can be told. */
  onFallback?(reason: unknown): void;
}

/** Save a signer into the key store and prove it reads back as the same key.
 * Throws when the store refuses (e.g. a browser that cannot clone a CryptoKey). */
async function saveAndConfirm(
  store: KeyStore,
  signer: ModuleResponseSigner,
): Promise<void> {
  await store.save(signer.toStored());
  const back = await store.load();
  if (!back || back.publicKeyB64 !== signer.publicKeyB64) {
    throw new Error("the stored key did not read back unchanged");
  }
}

/** The client-setting path: the JWK in localStorage, as before IndexedDB. */
async function loadOrCreateFromJwk(
  storage: SignerStorage,
): Promise<ModuleResponseSigner> {
  const existing = storage.getJwk();
  if (existing && existing.d) return ModuleResponseSigner.fromJwk(existing);
  const { signer, jwk } = await ModuleResponseSigner.generate();
  await storage.setJwk(jwk);
  return signer;
}

/**
 * Load the responder's signer, generating and persisting a fresh keypair on
 * first use.
 *
 * Preferred home: a non-extractable key in `storage.keyStore`. A JWK left in the
 * client setting by an older build is imported non-extractable, saved, and only
 * cleared once the store reads it back unchanged — the same public key, so the
 * agent's pin still holds and no re-pair is needed. If the store is missing or
 * refuses the key, the JWK path keeps working and `onFallback` fires: a failure
 * here must never leave the responder silently unable to sign.
 *
 * Returns null only if WebCrypto Ed25519 is unavailable (older runtime) — the
 * caller then advertises no signing capability and responses stay unsigned.
 */
export async function loadOrCreateSigner(
  storage: SignerStorage,
): Promise<ModuleResponseSigner | null> {
  const store = storage.keyStore;
  if (store) {
    try {
      const stored = await store.load();
      if (stored) return ModuleResponseSigner.fromStored(stored);

      const legacy = storage.getJwk();
      const signer =
        legacy && legacy.d
          ? await ModuleResponseSigner.fromJwk(legacy, false)
          : await ModuleResponseSigner.generateNonExtractable();
      await saveAndConfirm(store, signer);
      if (legacy) await storage.setJwk(null);
      return signer;
    } catch (err) {
      storage.onFallback?.(err);
    }
  }
  try {
    return await loadOrCreateFromJwk(storage);
  } catch {
    return null;
  }
}

/** Forget the persisted signing key everywhere it may live, so the next
 * loadOrCreateSigner mints a fresh one ("Reset pairing"). Clearing only the
 * store would let the migration path bring an old JWK back. */
export async function clearStoredSigner(storage: SignerStorage): Promise<void> {
  await storage.keyStore?.clear();
  await storage.setJwk(null);
}
