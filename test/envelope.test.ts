import { describe, expect, it } from "vitest";
import { makeEnvelope, parseEnvelope } from "../src/rpc/envelope.js";
import { ENVELOPE_VERSION } from "../src/constants.js";

describe("parseEnvelope", () => {
  it("rejects non-objects", () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope(undefined)).toBeNull();
    expect(parseEnvelope("hello")).toBeNull();
    expect(parseEnvelope(42)).toBeNull();
  });

  it("requires a string type and numeric version", () => {
    expect(parseEnvelope({ v: 1 })).toBeNull();
    expect(parseEnvelope({ type: "hello" })).toBeNull();
    expect(parseEnvelope({ type: 1, v: 1 })).toBeNull();
    expect(parseEnvelope({ type: "hello", v: "1" })).toBeNull();
  });

  it("parses a minimal valid envelope and defaults ts", () => {
    const before = Date.now();
    const env = parseEnvelope({ type: "ping", v: 1 });
    expect(env).not.toBeNull();
    expect(env!.type).toBe("ping");
    expect(env!.v).toBe(1);
    expect(env!.ts).toBeGreaterThanOrEqual(before);
  });

  it("preserves a provided ts", () => {
    expect(parseEnvelope({ type: "ping", v: 1, ts: 123 })!.ts).toBe(123);
  });

  it("filters capabilities to strings only", () => {
    const env = parseEnvelope({
      type: "hello",
      v: 1,
      capabilities: ["ping", 5, null, "presence", {}],
    });
    expect(env!.capabilities).toEqual(["ping", "presence"]);
  });

  it("drops a malformed peer but keeps a valid one", () => {
    expect(parseEnvelope({ type: "hello", v: 1, peer: { role: "x" } })!.peer)
      .toBeUndefined();
    const good = {
      role: "agent",
      version: "1.0.0",
      minEnvelope: 1,
      maxEnvelope: 1,
    };
    expect(parseEnvelope({ type: "hello", v: 1, peer: good })!.peer).toEqual(good);
  });

  it("drops a malformed error but keeps a valid one", () => {
    expect(
      parseEnvelope({ type: "rpc.error", v: 1, error: { code: 1 } })!.error,
    ).toBeUndefined();
    const err = { code: "boom", message: "it broke" };
    expect(parseEnvelope({ type: "rpc.error", v: 1, error: err })!.error).toEqual(
      err,
    );
  });

  it("ignores non-string id/proc (forward-compat tolerance)", () => {
    const env = parseEnvelope({ type: "rpc.request", v: 1, id: 5, proc: {} });
    expect(env!.id).toBeUndefined();
    expect(env!.proc).toBeUndefined();
  });
});

describe("makeEnvelope", () => {
  it("stamps the current envelope version and a ts", () => {
    const before = Date.now();
    const env = makeEnvelope("ping", { id: "abc" });
    expect(env.v).toBe(ENVELOPE_VERSION);
    expect(env.type).toBe("ping");
    expect(env.id).toBe("abc");
    expect(env.ts).toBeGreaterThanOrEqual(before);
  });

  it("round-trips through parseEnvelope", () => {
    const env = makeEnvelope("hello", { capabilities: ["ping"] });
    expect(parseEnvelope(env)).toEqual(env);
  });
});
