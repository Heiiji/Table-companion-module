import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalize,
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

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString("base64");
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
    const pub = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(vectorPubB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    for (const v of vectors.signingStrings) {
      const ok = await crypto.subtle.verify(
        { name: "Ed25519" },
        pub,
        b64ToBytes(v.sigB64),
        new TextEncoder().encode(v.signingString),
      );
      expect(ok, v.name).toBe(true);
    }
  });
});

describe("ModuleResponseSigner", () => {
  it("round-trips: sign then verify against its own public key", async () => {
    const { signer } = await ModuleResponseSigner.generate();
    const body = { formula: "2d6+3", total: 10, dice: [{ faces: 6, results: [4, 3] }] };
    const { sig, signedAt } = await signer.sign("req-1", "world-x", "roll.execute", body);

    // freshness: signedAt is stamped ~now (the agent's ±90s check would pass).
    expect(Math.abs(Date.now() - signedAt)).toBeLessThan(5000);

    const message = await responseSigningString(
      "req-1",
      "world-x",
      "roll.execute",
      signedAt,
      body,
    );
    const pub = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(signer.publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      pub,
      b64ToBytes(sig),
      new TextEncoder().encode(message),
    );
    expect(ok).toBe(true);
  });

  it("tamper: a signature over one body does not verify against a changed body", async () => {
    const { signer } = await ModuleResponseSigner.generate();
    const body = { total: 10 };
    const { sig, signedAt } = await signer.sign("req-2", "w", "roll.execute", body);
    const tamperedMsg = await responseSigningString(
      "req-2",
      "w",
      "roll.execute",
      signedAt,
      { total: 11 }, // attacker swaps the result
    );
    const pub = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(signer.publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      pub,
      b64ToBytes(sig),
      new TextEncoder().encode(tamperedMsg),
    );
    expect(ok).toBe(false);
  });

  it("wrong-key: a signature from one signer does not verify against another's key", async () => {
    const a = (await ModuleResponseSigner.generate()).signer;
    const b = (await ModuleResponseSigner.generate()).signer;
    const body = { total: 7 };
    const { sig, signedAt } = await a.sign("req-3", "w", "roll.execute", body);
    const msg = await responseSigningString("req-3", "w", "roll.execute", signedAt, body);
    const pubB = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(b.publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      pubB,
      b64ToBytes(sig),
      new TextEncoder().encode(msg),
    );
    expect(ok).toBe(false);
  });
});

describe("loadOrCreateSigner", () => {
  it("generates + persists on first use, then loads the same key", async () => {
    let stored: JsonWebKey | null = null;
    const get = () => stored;
    const set = async (jwk: JsonWebKey) => {
      stored = jwk;
    };

    const first = await loadOrCreateSigner(get, set);
    expect(first).not.toBeNull();
    expect(stored).not.toBeNull();

    const second = await loadOrCreateSigner(get, set);
    expect(second).not.toBeNull();
    // Same persisted keypair -> same public key across loads (agent's pin holds).
    expect(second!.publicKeyB64).toBe(first!.publicKeyB64);
  });
});
