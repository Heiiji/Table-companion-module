import { beforeAll, describe, expect, it } from "vitest";
import {
  fingerprint,
  parseSignedMessage,
  verifySignature,
  type SignedMessage,
} from "../src/rpc/signing.js";
import { MAX_ENVELOPE_BYTES } from "../src/constants.js";

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString("base64");
}

// A real Ed25519 key pair generated via the same WebCrypto the module uses, so
// the test exercises the actual verification path end to end.
let keyPair: CryptoKeyPair;
let publicKeyB64: string;

async function sign(body: string, key: CryptoKey): Promise<SignedMessage> {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(body),
  );
  return { sig: toB64(sig), body };
}

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKeyB64 = toB64(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
});

describe("parseSignedMessage", () => {
  it("accepts a well-formed wrapper", () => {
    expect(parseSignedMessage({ sig: "abc", body: "{}" })).toEqual({
      sig: "abc",
      body: "{}",
    });
  });

  it("rejects anything missing sig or body strings", () => {
    expect(parseSignedMessage(null)).toBeNull();
    expect(parseSignedMessage({ sig: "abc" })).toBeNull();
    expect(parseSignedMessage({ body: "{}" })).toBeNull();
    expect(parseSignedMessage({ sig: 1, body: "{}" })).toBeNull();
    // A legacy unsigned envelope is not a signed wrapper.
    expect(parseSignedMessage({ v: 1, type: "hello" })).toBeNull();
  });

  it("rejects an oversized body before parsing", () => {
    const body = "x".repeat(MAX_ENVELOPE_BYTES + 1);
    expect(parseSignedMessage({ sig: "abc", body })).toBeNull();
    // A body at the limit is still accepted.
    const atLimit = "x".repeat(MAX_ENVELOPE_BYTES);
    expect(parseSignedMessage({ sig: "abc", body: atLimit })).not.toBeNull();
  });
});

describe("verifySignature", () => {
  it("accepts a genuine signature", async () => {
    const msg = await sign(`{"v":1,"type":"hello"}`, keyPair.privateKey);
    expect(await verifySignature(publicKeyB64, msg)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const msg = await sign(`{"v":1,"type":"hello"}`, keyPair.privateKey);
    msg.body = `{"v":1,"type":"rpc.request","proc":"evil"}`;
    expect(await verifySignature(publicKeyB64, msg)).toBe(false);
  });

  it("rejects a garbage signature", async () => {
    const msg = await sign(`{"v":1}`, keyPair.privateKey);
    msg.sig = toB64(new Uint8Array(64)); // all-zero, wrong
    expect(await verifySignature(publicKeyB64, msg)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const msg = await sign(`{"v":1}`, other.privateKey);
    expect(await verifySignature(publicKeyB64, msg)).toBe(false);
  });

  it("never throws on a malformed key or signature", async () => {
    expect(await verifySignature("not-base64!!", { sig: "x", body: "y" })).toBe(
      false,
    );
    expect(await verifySignature("", { sig: "", body: "" })).toBe(false);
  });
});

describe("cross-language interop with the Go agent", () => {
  // Fixture produced by the agent's crypto/ed25519 (deterministic, RFC 8032):
  // seed = bytes 1..32, signing the exact body below. This pins that a message
  // signed by the Go agent verifies with the module's WebCrypto path.
  const GO_PUB = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=";
  const GO_SIG =
    "oJ0pKoOkKRYSwBviXeYkb/HbDPSUoNYsGaG3ZaWMIhdtKTzTreojWsrdmj3KXt79wNY8rx+qiZMihvgG/2cLDQ==";
  const GO_BODY = `{"v":1,"type":"hello","peer":{"role":"agent"}}`;

  it("verifies a real Go-signed envelope", async () => {
    expect(await verifySignature(GO_PUB, { sig: GO_SIG, body: GO_BODY })).toBe(
      true,
    );
  });

  it("rejects the Go signature against a different body", async () => {
    expect(
      await verifySignature(GO_PUB, { sig: GO_SIG, body: GO_BODY + " " }),
    ).toBe(false);
  });
});

describe("fingerprint", () => {
  it("is a stable 8-byte hex string for a given key", async () => {
    const fp = await fingerprint(publicKeyB64);
    expect(fp).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
    expect(await fingerprint(publicKeyB64)).toBe(fp); // deterministic
  });

  it("returns '' for an unparseable key", async () => {
    expect(await fingerprint("not-base64!!")).toBe("");
  });
});
