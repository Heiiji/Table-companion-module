import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Channel } from "../src/rpc/channel.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { RpcError } from "../src/rpc/errors.js";
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
  SETTING_AGENT_USER,
  SETTING_COMPANION_ANCHOR,
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

/** The Foundry user the agent is logged in as (a PLAYER-role service user). */
const AGENT_USER = "agentUser0000001";
/** An ordinary player, who can see and re-send everything on the relay. */
const PLAYER = "player0000000001";

function agentEnv(
  type: string,
  fields: Fields = {},
  withPubKey = false,
): Fields {
  return {
    v: ENVELOPE_VERSION,
    type,
    ts: Date.now(),
    worldId: "test-world",
    peer: {
      role: "agent",
      version: "9.9.9",
      minEnvelope: 1,
      maxEnvelope: 1,
      userId: AGENT_USER,
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

let socketHandler: ((raw: unknown, senderId?: unknown) => unknown) | undefined;
let emitSpy: ReturnType<typeof vi.fn<(env: unknown, opts?: unknown) => void>>;
let setSpy: ReturnType<typeof vi.fn>;
let store: Record<string, unknown>;

/**
 * `pinned` is the paired agent key; `pinnedUser` the paired agent's user id
 * (defaults to AGENT_USER when a key is pinned, as a 0.11.0 pairing records
 * both). `anchor` is the service user this module created.
 */
function stubGame(
  opts: {
    pinned?: string;
    pinnedUser?: string;
    anchor?: string;
    responder?: boolean;
  } = {},
): void {
  const responder = opts.responder ?? true;
  const me = { id: "gm1", isGM: true, active: true, name: "GM" };
  const other = { id: "gm0", isGM: true, active: true, name: "GM0" };
  const agent = { id: AGENT_USER, isGM: false, active: true, name: "Companion" };
  const player = { id: PLAYER, isGM: false, active: true, name: "Alice" };
  const all = [me, other, agent, player];
  emitSpy = vi.fn();
  store = {
    [`${MODULE_ID}:${SETTING_AGENT_KEY}`]: opts.pinned ?? "",
    [`${MODULE_ID}:${SETTING_AGENT_USER}`]:
      opts.pinnedUser ?? (opts.pinned ? AGENT_USER : ""),
    [`${MODULE_ID}:${SETTING_COMPANION_ANCHOR}`]: opts.anchor ?? "",
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
      contents: responder ? [me, agent, player] : [other, me, agent, player],
      get: (id: string) => all.find((u) => u.id === id),
      find: (fn: (u: unknown) => boolean) => all.find(fn),
    },
    socket: {
      on: (_ch: string, fn: (raw: unknown, senderId?: unknown) => unknown) => {
        socketHandler = fn;
      },
      emit: (_ch: string, env: unknown, opts?: unknown) => emitSpy(env, opts),
    },
    settings: {
      get: (ns: string, key: string) => store[`${ns}:${key}`],
      set: setSpy,
    },
  });
}

function startChannel(timeoutMs?: number, withActorUpsert = false): Channel {
  const registry = new ProcedureRegistry();
  const READ = { kind: "read" } as const;
  registry.register("echo", (payload) => ({ echoed: payload }), READ);
  registry.register(
    "boom",
    () => {
      throw new Error("kaboom");
    },
    READ,
  );
  registry.register("hang", () => new Promise(() => {}), READ); // never settles
  registry.register(
    "refuse",
    () => {
      throw new RpcError("invalid_args", "bad formula");
    },
    READ,
  );
  if (withActorUpsert) {
    registry.register("actor.upsert.v1", () => ({}), { kind: "mutation" });
    registry.register("npc.upsert.v1", () => ({}), { kind: "mutation" });
  }
  const channel = new Channel(registry, "0.0.0-test", timeoutMs);
  channel.start();
  emitSpy.mockClear(); // discard the hello broadcast on start
  return channel;
}

/** Deliver a raw socket payload as Foundry's relay would — with the sender's
 * user id — and await the channel's async handling. */
async function deliver(raw: unknown, sender: string = AGENT_USER): Promise<void> {
  await socketHandler!(raw, sender);
}

/** The recipients a given emitted envelope was targeted at, or undefined for a
 * broadcast. */
function recipientsOf(env: Fields): unknown {
  const call = emitSpy.mock.calls.find((c) => c[0] === env);
  return (call?.[1] as { recipients?: unknown } | undefined)?.recipients;
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

  it("pairs with the service user this module created while the pairing window is open", async () => {
    stubGame({ pinned: "", anchor: AGENT_USER, responder: true });
    const infoSpy = vi.fn();
    vi.stubGlobal("ui", { notifications: { info: infoSpy } });
    const channel = startChannel();
    channel.openPairingWindow(); // the GM has the setup/pairing dialog open
    await deliver(await sign(agentEnv("hello", {}, true)));
    expect(setSpy).toHaveBeenCalledWith(
      MODULE_ID,
      SETTING_AGENT_KEY,
      agentPubB64,
    );
    expect(setSpy).toHaveBeenCalledWith(
      MODULE_ID,
      SETTING_AGENT_USER,
      AGENT_USER,
    );
    // The pairing is surfaced with the key fingerprint.
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(emitted("hello.ack")).toHaveLength(1);
    expect(recipientsOf(emitted("hello.ack")[0])).toEqual([AGENT_USER]);
  });

  it("holds a pairing request from any other user until the GM trusts it", async () => {
    stubGame({ pinned: "", anchor: "someoneElse00001", responder: true });
    const warnSpy = vi.fn();
    vi.stubGlobal("ui", { notifications: { warn: warnSpy, info: vi.fn() } });
    const channel = startChannel();
    channel.openPairingWindow();
    await deliver(await sign(agentEnv("hello", {}, true)));

    // Nothing pinned, nothing answered; the GM is told who is asking.
    expect(setSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const pairing = await channel.getPairing();
    expect(pairing.paired).toBe(false);
    expect(pairing.pending).toMatchObject({ userId: AGENT_USER, userName: "Companion" });

    await channel.trustPendingPairing();
    expect(store[`${MODULE_ID}:${SETTING_AGENT_KEY}`]).toBe(agentPubB64);
    expect(store[`${MODULE_ID}:${SETTING_AGENT_USER}`]).toBe(AGENT_USER);
    expect((await channel.getPairing()).pending).toBeNull();
    // Announced so the agent completes the handshake, to the agent only.
    const hello = emitted("hello").at(-1)!;
    expect(recipientsOf(hello)).toEqual([AGENT_USER]);
  });

  it("drops a held pairing request the GM ignores", async () => {
    stubGame({ pinned: "", responder: true });
    vi.stubGlobal("ui", { notifications: { warn: vi.fn() } });
    const channel = startChannel();
    channel.openPairingWindow();
    await deliver(await sign(agentEnv("hello", {}, true)));
    channel.ignorePendingPairing();
    expect((await channel.getPairing()).pending).toBeNull();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("never pairs with a Gamemaster sender", async () => {
    stubGame({ pinned: "", anchor: "gm0", responder: true });
    const channel = startChannel();
    channel.openPairingWindow();
    const env = agentEnv("hello", {}, true);
    (env.peer as Fields).userId = "gm0";
    await deliver(await sign(env), "gm0");
    expect(setSpy).not.toHaveBeenCalled();
    expect((await channel.getPairing()).pending).toBeNull();
  });

  // The pairing race the audit found: a player's own self-signed "agent" hello,
  // sent while the GM has setup open. It is held for the GM, never pinned.
  it("never auto-pins a player's self-signed hello", async () => {
    stubGame({ pinned: "", anchor: AGENT_USER, responder: true });
    vi.stubGlobal("ui", { notifications: { warn: vi.fn() } });
    const channel = startChannel();
    channel.openPairingWindow();
    const env = agentEnv("hello", {}, true);
    (env.peer as Fields).userId = PLAYER;
    await deliver(await sign(env), PLAYER);
    expect(setSpy).not.toHaveBeenCalled();
    expect((await channel.getPairing()).pending?.userName).toBe("Alice");
  });

  it("does NOT pin an unknown key when the pairing window is closed", async () => {
    stubGame({ pinned: "", anchor: AGENT_USER, responder: true });
    startChannel(); // pairing window never opened
    await deliver(await sign(agentEnv("hello", {}, true)));
    expect(setSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("does not pin when unpaired and not the responder", async () => {
    stubGame({ pinned: "", anchor: AGENT_USER, responder: false });
    const channel = startChannel();
    channel.openPairingWindow(); // even with the window open, a non-responder never pins
    await deliver(await sign(agentEnv("hello", {}, true)));
    expect(setSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("drops a genuine envelope re-sent by another user", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    const wrapped = await sign(
      agentEnv("rpc.request", { id: "x1", proc: "echo", payload: {} }),
    );
    await deliver(wrapped, PLAYER); // captured and replayed from a player's session
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("drops an envelope signed for a different world", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver(
      await sign(
        agentEnv("rpc.request", { id: "w1", proc: "echo", worldId: "other-world" }),
      ),
    );
    await deliver(
      await sign(agentEnv("rpc.request", { id: "w2", proc: "echo", worldId: undefined })),
    );
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("drops an envelope from a user other than the paired agent user", async () => {
    // Paired to AGENT_USER; a validly-signed envelope naming (and sent by) the
    // player is refused even though the key verifies.
    stubGame({ pinned: agentPubB64, pinnedUser: AGENT_USER });
    startChannel();
    const env = agentEnv("rpc.request", { id: "q1", proc: "echo" });
    (env.peer as Fields).userId = PLAYER;
    await deliver(await sign(env), PLAYER);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  // A world paired before the agent user was recorded has no pinned user yet, so
  // only the signed userId stands between a player's replay and the migration
  // recording that player as "the agent".
  it("never records a player who re-sends a genuine envelope as the agent user", async () => {
    stubGame({ pinned: agentPubB64, pinnedUser: "" });
    startChannel();
    const genuine = await sign(agentEnv("hello"));
    await deliver(genuine, PLAYER);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(store[`${MODULE_ID}:${SETTING_AGENT_USER}`]).toBe("");
  });

  it("records the agent user of a world paired before it was tracked", async () => {
    stubGame({ pinned: agentPubB64, pinnedUser: "" });
    startChannel();
    await deliver(await sign(agentEnv("hello")));
    expect(store[`${MODULE_ID}:${SETTING_AGENT_USER}`]).toBe(AGENT_USER);
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

  it("maps a throwing handler to procedure_failed with a generic message", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver(
      await sign(agentEnv("rpc.request", { id: "b1", proc: "boom" })),
    );
    const [err] = emitted("rpc.error");
    expect(err.id).toBe("b1");
    expect((err.error as Fields).code).toBe("procedure_failed");
    // An unexpected exception's text can name internals; it stays in the log.
    expect((err.error as Fields).message).toBe("module procedure failed");
  });

  it("passes a structured RpcError's code and message through", async () => {
    stubGame({ pinned: agentPubB64 });
    startChannel();
    await deliver(
      await sign(agentEnv("rpc.request", { id: "v1", proc: "refuse" })),
    );
    const [err] = emitted("rpc.error");
    expect(err.error).toEqual({ code: "invalid_args", message: "bad formula" });
  });

  it("refuses a signed-only procedure when this responder cannot sign", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    startChannel(undefined, true); // upserts registered, but no signer installed
    await deliver(
      await sign(
        agentEnv("rpc.request", { id: "a1", proc: "actor.upsert.v1", payload: {} }),
      ),
    );
    const [err] = emitted("rpc.error");
    expect(err.id).toBe("a1");
    expect((err.error as Fields).code).toBe("unknown_procedure");
    expect(emitted("rpc.response")).toHaveLength(0);
  });

  it("forgets a request id only once it is too old to replay", async () => {
    vi.useFakeTimers();
    try {
      stubGame({ pinned: agentPubB64 });
      startChannel();
      await deliver(
        await sign(agentEnv("rpc.request", { id: "t1", proc: "echo" })),
      );
      // Same id, fresh ts, inside the window: still a replay.
      vi.advanceTimersByTime(REPLAY_WINDOW_MS);
      await deliver(
        await sign(agentEnv("rpc.request", { id: "t1", proc: "echo" })),
      );
      expect(emitted("rpc.response")).toHaveLength(1);
      // Past twice the window the old entry has aged out; a fresh signed
      // request may legitimately reuse the id.
      vi.advanceTimersByTime(REPLAY_WINDOW_MS + 1);
      await deliver(
        await sign(agentEnv("rpc.request", { id: "t1", proc: "echo" })),
      );
      expect(emitted("rpc.response")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("answers ping only when responder, to the agent only", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    startChannel();
    await deliver(await sign(agentEnv("ping", { id: "p1" })));
    expect(emitted("pong")).toHaveLength(1);
    expect(emitted("pong")[0].id).toBe("p1");
    expect(recipientsOf(emitted("pong")[0])).toEqual([AGENT_USER]);
  });

  it("sends responses and errors to the agent only, never to every player", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    startChannel();
    await deliver(
      await sign(agentEnv("rpc.request", { id: "d1", proc: "echo", payload: 1 })),
    );
    await deliver(await sign(agentEnv("rpc.request", { id: "d2", proc: "boom" })));
    expect(recipientsOf(emitted("rpc.response")[0])).toEqual([AGENT_USER]);
    expect(recipientsOf(emitted("rpc.error")[0])).toEqual([AGENT_USER]);
  });

  // The agent replaces its capability list with the last hello it hears, so a
  // player's or second GM's smaller list used to knock the upserts out.
  it("only the elected responder announces itself", async () => {
    stubGame({ pinned: agentPubB64, responder: false });
    const channel = new Channel(new ProcedureRegistry(), "0.0.0-test");
    channel.start();
    channel.sendHello();
    expect(emitted("hello")).toHaveLength(0);

    stubGame({ pinned: agentPubB64, responder: true });
    const responder = new Channel(new ProcedureRegistry(), "0.0.0-test");
    responder.start();
    const [hello] = emitted("hello");
    expect(hello).toBeDefined();
    expect(recipientsOf(hello)).toEqual([AGENT_USER]);
  });

  it("re-announces when this client becomes the responder", async () => {
    const hooks: Record<string, Array<() => void>> = {};
    vi.stubGlobal("Hooks", {
      on: (h: string, fn: () => void) => (hooks[h] ??= []).push(fn),
    });
    stubGame({ pinned: agentPubB64, responder: false });
    const g = game as unknown as { users: { activeGM: unknown }; user: unknown };
    const channel = new Channel(new ProcedureRegistry(), "0.0.0-test");
    channel.start();
    expect(emitted("hello")).toHaveLength(0);

    g.users.activeGM = g.user; // the other GM left; this client is now elected
    for (const fn of hooks.userDisconnected ?? []) fn();
    expect(emitted("hello")).toHaveLength(1);
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

  it("keeps consequential provisioning mutations invisible until this responder can sign", async () => {
    stubGame({ pinned: agentPubB64, responder: true });
    const channel = startChannel(undefined, true);
    channel.sendHello();
    const unsigned = emitted("hello").at(-1)!.capabilities as string[];
    expect(unsigned).not.toContain("actor.upsert.v1");
    expect(unsigned).not.toContain("npc.upsert.v1");

    const { signer } = await ModuleResponseSigner.generate();
    emitSpy.mockClear();
    channel.setResponseSigner(signer);
    const capabilities = emitted("hello").at(-1)!.capabilities as string[];
    expect(capabilities).toContain("actor.upsert.v1");
    expect(capabilities).toContain("npc.upsert.v1");
    expect(capabilities).toContain(CAP_RESPONSE_SIG);
  });

  it("does not advertise/sign when a signer is set but this client is NOT the responder", async () => {
    stubGame({ pinned: agentPubB64, responder: false });
    const channel = startChannel();
    const { signer } = await ModuleResponseSigner.generate();
    channel.setResponseSigner(signer); // non-responder: must NOT re-hello
    expect(emitSpy).not.toHaveBeenCalled();
    channel.sendHello(); // and never announces at all
    expect(emitted("hello")).toHaveLength(0);
    expect(channel.advertisedCapabilities()).not.toContain(CAP_RESPONSE_SIG);
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
      "rpc.response",
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
      "rpc.error",
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
