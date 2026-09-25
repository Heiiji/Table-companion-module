import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODULE_ID,
  SETTING_AGENT_KEY,
  SETTING_AGENT_USER,
} from "../src/constants.js";
import { Channel } from "../src/rpc/channel.js";
import { parseEnvelope } from "../src/rpc/envelope.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { verifySignature } from "../src/rpc/signing.js";

// These vectors are byte-identical to the backend's
// internal/connector/testdata/agent_signing_vectors.json, produced by the very
// code path the backend sends with. They fence the wire shape of a signed
// backend message: had they existed, a backend that left `peer` off its
// requests (which this module has always dropped) could not have passed.

interface AgentVector {
  name: string;
  body: string;
  sig: string;
  expect: {
    type: string;
    worldId: string;
    peerUserId: string;
    peerRole: string;
  };
}

const file = JSON.parse(
  readFileSync(
    new URL("./vectors/agent_signing_vectors.json", import.meta.url),
    "utf8",
  ),
) as { publicKeyB64: string; vectors: AgentVector[] };

const request = file.vectors.find((v) => v.name === "rpc.request")!;
const agentUser = request.expect.peerUserId;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("agent signing vectors", () => {
  it.each(file.vectors.map((v) => [v.name, v] as const))(
    "%s verifies against the published key, and a tampered copy does not",
    async (_name, v) => {
      expect(await verifySignature(file.publicKeyB64, v)).toBe(true);
      const tampered = {
        ...v,
        body: v.body.replace("vector-world", "other-world"),
      };
      expect(await verifySignature(file.publicKeyB64, tampered)).toBe(false);
    },
  );

  it.each(file.vectors.map((v) => [v.name, v] as const))(
    "%s carries the fields the module requires",
    (_name, v) => {
      const env = parseEnvelope(JSON.parse(v.body));
      expect(env).not.toBeNull();
      expect(env!.type).toBe(v.expect.type);
      expect(env!.worldId).toBe(v.expect.worldId);
      expect(env!.peer?.role).toBe(v.expect.peerRole);
      expect(env!.peer?.userId).toBe(v.expect.peerUserId);
    },
  );
});

describe("a backend rpc.request, end to end through the channel", () => {
  function run(opts: { worldId?: string } = {}) {
    const ts = (JSON.parse(request.body) as { ts: number }).ts;
    vi.useFakeTimers({ now: ts, toFake: ["Date"] });
    const me = { id: "gm1", isGM: true, active: true, name: "GM" };
    const agent = {
      id: agentUser,
      isGM: false,
      active: true,
      name: "Companion",
    };
    const player = {
      id: "player0000000001",
      isGM: false,
      active: true,
      name: "P",
    };
    const all = [me, agent, player];
    const store: Record<string, unknown> = {
      [`${MODULE_ID}:${SETTING_AGENT_KEY}`]: file.publicKeyB64,
      [`${MODULE_ID}:${SETTING_AGENT_USER}`]: agentUser,
    };
    let handler:
      ((raw: unknown, sender?: unknown) => Promise<void>) | undefined;
    const emitted: Array<{ env: Record<string, unknown>; opts?: unknown }> = [];
    vi.stubGlobal("game", {
      user: me,
      world: { id: opts.worldId ?? request.expect.worldId },
      users: {
        activeGM: me,
        contents: all,
        get: (id: string) => all.find((u) => u.id === id),
        find: (fn: (u: unknown) => boolean) => all.find(fn),
      },
      socket: {
        on: (_c: string, fn: typeof handler) => {
          handler = fn;
        },
        emit: (_c: string, env: Record<string, unknown>, o?: unknown) =>
          emitted.push({ env, opts: o }),
      },
      settings: {
        get: (ns: string, key: string) => store[`${ns}:${key}`],
        set: async (ns: string, key: string, v: unknown) => {
          store[`${ns}:${key}`] = v;
        },
      },
    });
    const registry = new ProcedureRegistry();
    registry.register("roll.execute", () => ({ total: 11 }), { kind: "read" });
    new Channel(registry, "0.0.0-test").start();
    emitted.length = 0;
    return {
      deliver: (sender: string) =>
        handler!({ sig: request.sig, body: request.body }, sender),
      emitted,
    };
  }

  it("is answered, to the backend's user only", async () => {
    const ch = run();
    await ch.deliver(agentUser);
    const reply = ch.emitted.find((e) => e.env.type === "rpc.response");
    expect(reply?.env.id).toBe("00112233445566778899aabbccddeeff");
    expect(reply?.env.payload).toEqual({ total: 11 });
    expect(reply?.opts).toEqual({ recipients: [agentUser] });
  });

  it("is dropped when re-sent by another user", async () => {
    const ch = run();
    await ch.deliver("player0000000001");
    expect(ch.emitted).toHaveLength(0);
  });

  it("is dropped in any other world", async () => {
    const ch = run({ worldId: "another-world" });
    await ch.deliver(agentUser);
    expect(ch.emitted).toHaveLength(0);
  });
});
