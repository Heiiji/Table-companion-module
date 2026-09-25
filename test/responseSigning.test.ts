import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KeyStore, StoredKeyPair } from "../src/util/keyStore.js";
import {
  canonicalize,
  clearStoredSigner,
  loadOrCreateSigner,
  ModuleResponseSigner,
  responseSigningString,
} from "../src/rpc/responseSigning.js";

// These vectors are byte-identical to the agent's
// internal/connector/testdata/response_signing_vectors.json. Both suites assert
// against the same file, which is the cross-language canonicalization proof: the
// module builds the signing string, the agent rebuilds it, and they must agree
// to the byte.
interface Vectors {
  canonicalScheme: string;
  freshnessWindowMs: number;
  signingKey: { seedB64: string; publicKeyB64: string };
  canonicalJSON: { name: string; value: unknown; canonical: string }[];
  signingStrings: {
    name: string;
    type: string;
    requestId: string;
    worldId: string;
    procedure: string;
    signedAt: number;
    body: unknown;
    canonicalBody: string;
    bodyHashHex: string;
    signingString: string;
    sigB64: string;
  }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./vectors/response_signing_vectors.json", import.meta.url), "utf8"),
);

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  // Copy into a plain ArrayBuffer: Buffer's is ArrayBufferLike, which WebCrypto's
  // BufferSource does not accept.
  const src = Buffer.from(b64, "base64");
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}
function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString("base64");
}

/** Verify a base64 Ed25519 signature over `message` against a base64 raw public
 * key. Shared by every test below that reproduces the agent's verify step. */
async function verifySig(pubB64: string, sigB64: string, message: string): Promise<boolean> {
  const pub = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(pubB64),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    pub,
    b64ToBytes(sigB64),
    new TextEncoder().encode(message),
  );
}

// Import the fixed vector seed as a WebCrypto signing key by building its private
// JWK, so the module's real signing path reproduces the pinned vector signatures
// (Ed25519 is deterministic across Node/Go/WebCrypto).
let vectorPriv: CryptoKey;
let vectorPubB64: string;

beforeAll(async () => {
  const seed = b64ToBytes(vectors.signingKey.seedB64);
  const pub = b64ToBytes(vectors.signingKey.publicKeyB64);
  const jwk: JsonWebKey = {
    kty: "OKP",
    crv: "Ed25519",
    d: Buffer.from(seed).toString("base64url"),
    x: Buffer.from(pub).toString("base64url"),
    key_ops: ["sign"],
    ext: true,
  };
  vectorPriv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, [
    "sign",
  ]);
  vectorPubB64 = vectors.signingKey.publicKeyB64;
});

describe("canonicalize", () => {
  it("matches every shared canonical-JSON vector byte for byte", () => {
    for (const v of vectors.canonicalJSON) {
      expect(canonicalize(v.value), v.name).toBe(v.canonical);
    }
  });

  it("sorts object keys by UTF-8 byte order (uppercase < lowercase < multibyte)", () => {
    expect(canonicalize({ b: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"b":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalize(Number.NaN)).toThrow();
  });
});

describe("responseSigningString", () => {
  it("matches every shared signing-string vector", async () => {
    for (const v of vectors.signingStrings) {
      const s = await responseSigningString(
        v.type,
        v.requestId,
        v.worldId,
        v.procedure,
        v.signedAt,
        v.body,
      );
      expect(s, v.name).toBe(v.signingString);
    }
  });
});

describe("envelope-type binding (scheme v2)", () => {
  // The bug this closes: an rpc.error's signed body is {code, message}, which
  // canonicalizes IDENTICALLY to an rpc.response payload of the same shape.
  // Under v1 the type lived outside the signature, so every signed field
  // matched and a captured error verified as a success — the agent resolved the
  // call with garbage instead of the module's authored failure.
  it("gives the same body different signing strings per envelope type", async () => {
    const body = { code: "actor_not_found", message: "no such actor" };
    const asResponse = await responseSigningString(
      "rpc.response",
      "req-9",
      "w",
      "roll.action",
      1737158403000,
      body,
    );
    const asError = await responseSigningString(
      "rpc.error",
      "req-9",
      "w",
      "roll.action",
      1737158403000,
      body,
    );

    expect(asResponse).not.toBe(asError);
    // Everything else is identical — only the bound type separates them.
    expect(asResponse.replace("|rpc.response|", "|")).toBe(
      asError.replace("|rpc.error|", "|"),
    );
  });

  it("a signature over an rpc.error does not verify as an rpc.response", async () => {
    const { signer } = await ModuleResponseSigner.generate();
    const body = { code: "actor_not_found", message: "no such actor" };
    const { sig, signedAt } = await signer.sign(
      "rpc.error",
      "req-9",
      "w",
      "roll.action",
      body,
    );

    const replayed = await responseSigningString(
      "rpc.response",
      "req-9",
      "w",
      "roll.action",
      signedAt,
      body,
    );
    expect(await verifySig(signer.publicKeyB64, sig, replayed)).toBe(false);

    // Sanity: it still verifies as what it actually is.
    const honest = await responseSigningString(
      "rpc.error",
      "req-9",
      "w",
      "roll.action",
      signedAt,
      body,
    );
    expect(await verifySig(signer.publicKeyB64, sig, honest)).toBe(true);
  });
});

describe("signature vectors", () => {
  it("reproduces every pinned signature deterministically", async () => {
    for (const v of vectors.signingStrings) {
      const sig = await crypto.subtle.sign(
        { name: "Ed25519" },
        vectorPriv,
        new TextEncoder().encode(v.signingString),
      );
      expect(toB64(sig), v.name).toBe(v.sigB64);
    }
  });

  it("verifies each pinned signature against the vector public key", async () => {
    for (const v of vectors.signingStrings) {
      const ok = await verifySig(vectorPubB64, v.sigB64, v.signingString);
      expect(ok, v.name).toBe(true);
    }
  });
});

describe("ModuleResponseSigner", () => {
  it("round-trips: sign then verify against its own public key", async () => {
    const { signer } = await ModuleResponseSigner.generate();
    const body = { formula: "2d6+3", total: 10, dice: [{ faces: 6, results: [4, 3] }] };
    const { sig, signedAt } = await signer.sign(
      "rpc.response",
      "req-1",
      "world-x",
      "roll.execute",
      body,
    );

    // freshness: signedAt is stamped ~now (the agent's ±90s check would pass).
    expect(Math.abs(Date.now() - signedAt)).toBeLessThan(5000);

    const message = await responseSigningString(
      "rpc.response",
      "req-1",
      "world-x",
      "roll.execute",
      signedAt,
      body,
    );
    const ok = await verifySig(signer.publicKeyB64, sig, message);
    expect(ok).toBe(true);
  });

  it("tamper: a signature over one body does not verify against a changed body", async () => {
    const { signer } = await ModuleResponseSigner.generate();
    const body = { total: 10 };
    const { sig, signedAt } = await signer.sign("rpc.response", "req-2", "w", "roll.execute", body);
    const tamperedMsg = await responseSigningString(
      "rpc.response",
      "req-2",
      "w",
      "roll.execute",
      signedAt,
      { total: 11 }, // attacker swaps the result
    );
    const ok = await verifySig(signer.publicKeyB64, sig, tamperedMsg);
    expect(ok).toBe(false);
  });

  it("wrong-key: a signature from one signer does not verify against another's key", async () => {
    const a = (await ModuleResponseSigner.generate()).signer;
    const b = (await ModuleResponseSigner.generate()).signer;
    const body = { total: 7 };
    const { sig, signedAt } = await a.sign("rpc.response", "req-3", "w", "roll.execute", body);
    const msg = await responseSigningString(
      "rpc.response",
      "req-3",
      "w",
      "roll.execute",
      signedAt,
      body,
    );
    const ok = await verifySig(b.publicKeyB64, sig, msg);
    expect(ok).toBe(false);
  });
});

/** An in-memory KeyStore holding live CryptoKeys, standing in for IndexedDB
 * (which vitest's node environment lacks). `failSave` models a browser that
 * cannot clone a CryptoKey into storage. */
function memoryKeyStore(opts: { failSave?: boolean } = {}): KeyStore & {
  current: StoredKeyPair | null;
} {
  const store = {
    current: null as StoredKeyPair | null,
    async load() {
      return store.current;
    },
    async save(pair: StoredKeyPair) {
      if (opts.failSave) throw new DOMException("no clone", "DataCloneError");
      store.current = pair;
    },
    async clear() {
      store.current = null;
    },
  };
  return store;
}

function jwkStorage(initial: JsonWebKey | null = null) {
  const state = { jwk: initial };
  return {
    state,
    getJwk: () => state.jwk,
    setJwk: async (jwk: JsonWebKey | null) => {
      state.jwk = jwk;
    },
  };
}

describe("loadOrCreateSigner", () => {
  it("mints a non-extractable key in the key store and reloads the same one", async () => {
    const keyStore = memoryKeyStore();
    const jwk = jwkStorage();
    const storage = { ...jwk, keyStore };

    const first = await loadOrCreateSigner(storage);
    expect(first).not.toBeNull();
    expect(keyStore.current).not.toBeNull();
    expect(keyStore.current!.privateKey.extractable).toBe(false);
    // Nothing exportable is left in browser settings.
    expect(jwk.state.jwk).toBeNull();

    const second = await loadOrCreateSigner(storage);
    expect(second!.publicKeyB64).toBe(first!.publicKeyB64);
  });

  it("migrates a legacy JWK without changing the public key, then clears it", async () => {
    const { jwk: legacyJwk, signer: legacy } = await ModuleResponseSigner.generate();
    const keyStore = memoryKeyStore();
    const jwk = jwkStorage(legacyJwk);

    const migrated = await loadOrCreateSigner({ ...jwk, keyStore });

    // Same identity, so the agent's pin still holds — no re-pair.
    expect(migrated!.publicKeyB64).toBe(legacy.publicKeyB64);
    expect(keyStore.current!.privateKey.extractable).toBe(false);
    expect(jwk.state.jwk).toBeNull();
    // The migrated key still signs verifiably.
    const body = { total: 4 };
    const { sig, signedAt } = await migrated!.sign("rpc.response", "r", "w", "p", body);
    const msg = await responseSigningString("rpc.response", "r", "w", "p", signedAt, body);
    expect(await verifySig(legacy.publicKeyB64, sig, msg)).toBe(true);
  });

  it("keeps the legacy JWK when the key store cannot hold the key", async () => {
    const { jwk: legacyJwk, signer: legacy } = await ModuleResponseSigner.generate();
    const jwk = jwkStorage(legacyJwk);
    const onFallback = vi.fn();

    const signer = await loadOrCreateSigner({
      ...jwk,
      keyStore: memoryKeyStore({ failSave: true }),
      onFallback,
    });

    // Still signing, with the same identity, and the GM is told.
    expect(signer!.publicKeyB64).toBe(legacy.publicKeyB64);
    expect(jwk.state.jwk).toEqual(legacyJwk);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it("falls back to the JWK path when there is no key store at all", async () => {
    const jwk = jwkStorage();
    const first = await loadOrCreateSigner({ ...jwk, keyStore: null });
    expect(first).not.toBeNull();
    expect(jwk.state.jwk).not.toBeNull();
    const second = await loadOrCreateSigner({ ...jwk, keyStore: null });
    expect(second!.publicKeyB64).toBe(first!.publicKeyB64);
  });

  it("forgets the key everywhere on reset, so a fresh one is minted", async () => {
    const { jwk: legacyJwk } = await ModuleResponseSigner.generate();
    const keyStore = memoryKeyStore();
    const jwk = jwkStorage(legacyJwk);
    const storage = { ...jwk, keyStore };
    const before = await loadOrCreateSigner(storage);

    await clearStoredSigner(storage);
    expect(keyStore.current).toBeNull();
    expect(jwk.state.jwk).toBeNull();

    const after = await loadOrCreateSigner(storage);
    expect(after!.publicKeyB64).not.toBe(before!.publicKeyB64);
  });

  // The case the reset exists for: a browser that kept its key as a JWK (the
  // store refused it). Clearing only the store would let the JWK bring the old
  // identity straight back.
  it("rotates a key that lives only as a JWK", async () => {
    const { jwk: legacyJwk, signer: legacy } = await ModuleResponseSigner.generate();
    const jwk = jwkStorage(legacyJwk);
    const storage = { ...jwk, keyStore: memoryKeyStore({ failSave: true }) };

    await clearStoredSigner(storage);
    const after = await loadOrCreateSigner(storage);

    expect(after!.publicKeyB64).not.toBe(legacy.publicKeyB64);
  });
});
