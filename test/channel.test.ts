import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Channel } from "../src/rpc/channel.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import {
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

function agentEnv(type: string, fields: Fields = {}, withPubKey = false): Fields {
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

function startChannel(): Channel {
  const registry = new ProcedureRegistry();
  registry.register("echo", (payload) => ({ echoed: payload }));
  registry.register("boom", () => {
    throw new Error("kaboom");
  });
  const channel = new Channel(registry, "0.0.0-test");
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

  it("pins the agent key on first contact (TOFU) when responder", async () => {
    stubGame({ pinned: "", responder: true });
    startChannel();
    await deliver(await sign(agentEnv("hello", {}, true)));
    expect(setSpy).toHaveBeenCalledWith(
      MODULE_ID,
      SETTING_AGENT_KEY,
      agentPubB64,
    );
    expect(emitted("hello.ack")).toHaveLength(1);
  });

  it("does not pin when unpaired and not the responder", async () => {
    stubGame({ pinned: "", responder: false });
    startChannel();
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
    await deliver(await sign(agentEnv("rpc.request", { id: "b1", proc: "boom" })));
    const [err] = emitted("rpc.error");
    expect(err.id).toBe("b1");
    expect((err.error as Fields).code).toBe("procedure_failed");
    expect((err.error as Fields).message).toBe("kaboom");
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
    await deliver(await sign(agentEnv("rpc.request", { id: "r2", proc: "echo" })));
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
