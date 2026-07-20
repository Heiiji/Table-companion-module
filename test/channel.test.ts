import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Channel } from "../src/rpc/channel.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import {
  ModuleResponseSigner,
  responseSigningString,
} from "../src/rpc/responseSigning.js";
import {
  CAP_RESPONSE_SIG,
  ENVELOPE_VERSION,
  MAX_ENVELOPE_BYTES,
  MODULE_ID,
  REPLAY_WINDOW_MS,
  SETTING_AGENT_KEY,
} from "../src/constants.js";

// The channel is the module's trust boundary (signature gate, TOFU pairing,
// responder gating, rpc dispatch). These tests drive it through the real socket
// listener it registers on start(), with a stubbed `game` (mirroring
// presence.test.ts) and a genuine Ed25519 agent key (mirroring signing.test.ts),
// so the whole verify path runs end to end.

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString("base64");
}

/** Verify a base64 Ed25519 signature over `message` against a base64 raw public
 * key — the module-response-signing counterpart of the agent's verify step. */
async function verifyResponseSig(
  pubB64: string,
  sigB64: string,
  message: string,
): Promise<boolean> {
  const pub = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(pubB64, "base64")),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    pub,
    new Uint8Array(Buffer.from(sigB64, "base64")),
    new TextEncoder().encode(message),
  );
}

let agentKey: CryptoKeyPair;
let agentPubB64: string;

beforeAll(async () => {
  agentKey = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  agentPubB64 = toB64(await crypto.subtle.exportKey("raw", agentKey.publicKey));
});

// --- signed-wire helpers ---------------------------------------------------

type Fields = Record<string, unknown>;

function agentEnv(
  type: string,
  fields: Fields = {},
  withPubKey = false,
): Fields {
  return {
    v: ENVELOPE_VERSION,
    type,
    ts: Date.now(),
    peer: {
      role: "agent",
      version: "9.9.9",
      minEnvelope: 1,
      maxEnvelope: 1,
      ...(withPubKey ? { pubKey: agentPubB64 } : {}),
    },
    ...fields,
  };
}

async function sign(env: Fields, key: CryptoKey = agentKey.privateKey) {
  const body = JSON.stringify(env);
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(body),
  );
  return { sig: toB64(sig), body };
}

// --- game stub -------------------------------------------------------------

let socketHandler: ((raw: unknown) => unknown) | undefined;
let emitSpy: ReturnType<typeof vi.fn>;
let setSpy: ReturnType<typeof vi.fn>;

function stubGame(opts: { pinned?: string; responder?: boolean } = {}): void {
  const responder = opts.responder ?? true;
  const me = { id: "gm1", isGM: true, active: true, name: "GM" };
  const other = { id: "gm0", isGM: true, active: true, name: "GM0" };
  emitSpy = vi.fn();
  const store: Record<string, unknown> = {
    [`${MODULE_ID}:${SETTING_AGENT_KEY}`]: opts.pinned ?? "",
  };
  setSpy = vi.fn(async (ns: string, key: string, val: unknown) => {
    store[`${ns}:${key}`] = val;
  });
  vi.stubGlobal("game", {
    user: me,
    world: { id: "test-world" },
    users: {
      // activeGM is `me` only when this client should be the responder.
      activeGM: responder ? me : other,
      contents: responder ? [me] : [other, me],
    },
    socket: {
      on: (_ch: string, fn: (raw: unknown) => unknown) => {
        socketHandler = fn;
      },
      emit: (_ch: string, env: unknown) => emitSpy(env),
    },
    settings: {
      get: (ns: string, key: string) => store[`${ns}:${key}`],
      set: setSpy,
    },
  });
}

function startChannel(timeoutMs?: number, withActorUpsert = false): Channel {
  const registry = new ProcedureRegistry();
  registry.register("echo", (payload) => ({ echoed: payload }));
  registry.register("boom", () => {
    throw new Error("kaboom");
  });
  registry.register("hang", () => new Promise(() => {})); // never settles
  if (withActorUpsert) registry.register("actor.upsert.v1", () => ({}));
  const channel = new Channel(registry, "0.0.0-test", timeoutMs);
  channel.start();
  emitSpy.mockClear(); // discard the hello broadcast on start
  return channel;
}

/** Deliver a raw socket payload and await the channel's async handling. */
async function deliver(raw: unknown): Promise<void> {
  await socketHandler!(raw);
}

/** Envelopes the channel emitted, optionally filtered by type. */
function emitted(type?: string): Fields[] {
  const envs = emitSpy.mock.calls.map((c) => c[0] as Fields);
  return type ? envs.filter((e) => e.type === type) : envs;
}

afterEach(() => {
  vi.unstubAllGlobals();
  socketHandler = undefined;
});

describe("Channel.onMessage", () => {
  it("ignores unsigned / malformed traffic", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver({ foo: "bar" });
    await deliver("not even an object");
    await deliver(42);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("drops an oversized body before parsing it (A1)", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver({ sig: "x", body: "x".repeat(MAX_ENVELOPE_BYTES + 1) });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("drops a signed envelope claiming peer.role 'module'", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    const env = agentEnv("hello");
    (env.peer as Fields).role = "module";
    await deliver(await sign(env));
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("acks a fresh signed hello when paired + responder", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver(await sign(agentEnv("hello")));
    expect(emitted("hello.ack")).toHaveLength(1);
  });

  it("drops a stale envelope outside the freshness window (A2)", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    const env = agentEnv("hello", { ts: Date.now() - REPLAY_WINDOW_MS - 5000 });
    await deliver(await sign(env));
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("answers an rpc.request once but drops a verbatim replay (A2)", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    const wrapped = await sign(
      agentEnv("rpc.request", { id: "r1", proc: "echo", payload: { n: 1 } }),
    );
    await deliver(wrapped);
    await deliver(wrapped); // identical bytes + id -> replay
    expect(emitted("rpc.response")).toHaveLength(1);
    expect(emitted("rpc.response")[0].payload).toEqual({ echoed: { n: 1 } });
  });

  it("pins the agent key on first contact (TOFU) only while the pairing window is open", async () => {
    stubGame({ pinned: "", responder: true });
    const warnSpy = vi.fn();
    vi.stubGlobal("ui", { notifications: { warn: warnSpy } });
    const channel = startChannel();
    channel.openPairingWindow(); // the GM has the setup/pairing dialog open
    await deliver(await sign(agentEnv("hello", {}, true)));
    expect(setSpy).toHaveBeenCalledWith(
      MODULE_ID,
      SETTING_AGENT_KEY,
      agentPubB64,
    );
    // A new pairing is surfaced with the key fingerprint so the GM can cross-check.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/pair/i);
    expect(emitted("hello.ack")).toHaveLength(1);
  });

  it("does NOT auto-pin an unknown key when the pairing window is closed", async () => {
    stubGame({ pinned: "", responder: true });
    startChannel(); // pairing window never opened
    await deliver(await sign(agentEnv("hello", {}, true)));
    expect(setSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("does not pin when unpaired and not the responder", async () => {
    stubGame({ pinned: "", responder: false });
    const channel = startChannel();
    channel.openPairingWindow(); // even with the window open, a non-responder never pins
    await deliver(await sign(agentEnv("hello", {}, true)));
    expect(setSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("drops an envelope signed by a different key when paired", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    const wrong = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    await deliver(await sign(agentEnv("hello"), wrong.privateKey));
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("returns rpc.error for an unknown procedure", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver(
      await sign(agentEnv("rpc.request", { id: "u1", proc: "nope.missing" })),
    );
    const [err] = emitted("rpc.error");
    expect(err.id).toBe("u1");
    expect((err.error as Fields).code).toBe("unknown_procedure");
  });

  it("maps a throwing handler to rpc.error procedure_failed", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver(
      await sign(agentEnv("rpc.request", { id: "b1", proc: "boom" })),
    );
    const [err] = emitted("rpc.error");
    expect(err.id).toBe("b1");
    expect((err.error as Fields).code).toBe("procedure_failed");
    expect((err.error as Fields).message).toBe("kaboom");
  });

  it("times out a hung handler with rpc.error procedure_timeout (C7/C8)", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel(20); // 20ms per-request deadline
    await deliver(
      await sign(agentEnv("rpc.request", { id: "h1", proc: "hang" })),
    );
    const errs = emitted("rpc.error");
    expect(errs).toHaveLength(1); // exactly one — the late handler resolution is ignored
    expect(errs[0].id).toBe("h1");
    expect((errs[0].error as Fields).code).toBe("procedure_timeout");
  });

  it("answers ping only when responder (A4)", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    startChannel();
    await deliver(await sign(agentEnv("ping", { id: "p1" })));
    expect(emitted("pong")).toHaveLength(1);
    expect(emitted("pong")[0].id).toBe("p1");
  });

  it("ignores rpc.request / ping when not the responder (A4)", async () => {
    stubGame({ pinned: agentPubB64, responder: false });
    startChannel();
    await deliver(await sign(agentEnv("ping", { id: "p2" })));
    await deliver(
      await sign(agentEnv("rpc.request", { id: "r2", proc: "echo" })),
    );
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

// --- M8: module -> agent response signing ----------------------------------

describe("Channel response signing (M8)", () => {
  async function withSigner(): Promise<{
    channel: Channel;
    signer: ModuleResponseSigner;
  }> {
    const channel = startChannel();
    const { signer } = await ModuleResponseSigner.generate();
    channel.setResponseSigner(signer); // re-announces hello
    emitSpy.mockClear();
    return { channel, signer };
  }

  it("advertises the capability, its public key + worldId only when responder + signer", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    const channel = startChannel();
    // Before a signer: no signing capability, no pubKey, no worldId.
    channel.sendHello();
    let hello = emitted("hello").at(-1)!;
    expect(hello.capabilities).not.toContain(CAP_RESPONSE_SIG);
    expect((hello.peer as Fields).pubKey).toBeUndefined();
    expect(hello.worldId).toBeUndefined();

    const { signer } = await ModuleResponseSigner.generate();
    emitSpy.mockClear();
    channel.setResponseSigner(signer); // re-announces
    hello = emitted("hello").at(-1)!;
    expect(hello.capabilities).toContain(CAP_RESPONSE_SIG);
    expect((hello.peer as Fields).pubKey).toBe(signer.publicKeyB64);
    expect(hello.worldId).toBe("test-world");
  });

  it("keeps consequential actor.upsert.v1 invisible until this responder can sign", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    const channel = startChannel(undefined, true);
    channel.sendHello();
    expect(emitted("hello").at(-1)!.capabilities).not.toContain(
      "actor.upsert.v1",
    );

    const { signer } = await ModuleResponseSigner.generate();
    emitSpy.mockClear();
    channel.setResponseSigner(signer);
    const capabilities = emitted("hello").at(-1)!.capabilities as string[];
    expect(capabilities).toContain("actor.upsert.v1");
    expect(capabilities).toContain(CAP_RESPONSE_SIG);
  });

  it("does not advertise/sign when a signer is set but this client is NOT the responder", async () => {
    stubGame({ pinned: agentPubB64, responder: false });
    const channel = startChannel();
    const { signer } = await ModuleResponseSigner.generate();
    channel.setResponseSigner(signer); // non-responder: must NOT re-hello
    expect(emitSpy).not.toHaveBeenCalled();
    channel.sendHello();
    const hello = emitted("hello").at(-1)!;
    expect(hello.capabilities).not.toContain(CAP_RESPONSE_SIG);
    expect((hello.peer as Fields).pubKey).toBeUndefined();
  });

  it("signs an rpc.response so it verifies against the advertised key", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    const { signer } = await withSigner();

    await deliver(
      await sign(
        agentEnv("rpc.request", { id: "s1", proc: "echo", payload: { n: 7 } }),
      ),
    );
    const resp = emitted("rpc.response")[0];
    expect(resp).toBeDefined();
    expect(typeof resp.sig).toBe("string");
    expect(typeof resp.signedAt).toBe("number");
    expect(resp.payload).toEqual({ echoed: { n: 7 } });

    // Rebuild the canonical signing string exactly as the agent would and verify.
    const message = await responseSigningString(
      "s1",
      "test-world",
      "echo",
      resp.signedAt as number,
      resp.payload,
    );
    const ok = await verifyResponseSig(
      signer.publicKeyB64,
      resp.sig as string,
      message,
    );
    expect(ok).toBe(true);
  });

  it("signs an rpc.error over the error body (not swappable for a response)", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    const { signer } = await withSigner();

    await deliver(
      await sign(agentEnv("rpc.request", { id: "e1", proc: "boom" })),
    );
    const err = emitted("rpc.error")[0];
    expect(err).toBeDefined();
    expect(typeof err.sig).toBe("string");

    const message = await responseSigningString(
      "e1",
      "test-world",
      "boom",
      err.signedAt as number,
      err.error,
    );
    const ok = await verifyResponseSig(
      signer.publicKeyB64,
      err.sig as string,
      message,
    );
    expect(ok).toBe(true);
  });

  it("rotates the signing key on reset pairing", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    const channel = startChannel();
    const first = (await ModuleResponseSigner.generate()).signer;
    channel.setResponseSigner(first);
    let rotated = false;
    channel.setResponseKeyResetter(async () => {
      rotated = true;
      channel.setResponseSigner((await ModuleResponseSigner.generate()).signer);
    });
    await channel.resetPairing();
    expect(rotated).toBe(true);
    // The pinned agent key is also cleared (existing behaviour preserved).
    expect(setSpy).toHaveBeenCalledWith(MODULE_ID, SETTING_AGENT_KEY, "");
  });
});
