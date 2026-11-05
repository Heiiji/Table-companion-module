import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../src/api.js";
import { ENVELOPE_VERSION } from "../src/constants.js";
import type { Channel } from "../src/rpc/channel.js";
import type { ProcedureRegistry } from "../src/rpc/registry.js";

describe("buildApi", () => {
  it("exposes the version and delegates to the channel and registry", () => {
    const status = { linked: true };
    const unsubscribe = () => undefined;
    const channel = {
      advertisedCapabilities: vi.fn(() => ["ping.v1"]),
      getStatus: vi.fn(() => status),
      onEvent: vi.fn(() => unsubscribe),
    };
    const registry = { register: vi.fn() };
    const openSetup = vi.fn();
    const api = buildApi(
      "1.2.3",
      registry as unknown as ProcedureRegistry,
      channel as unknown as Channel,
      openSetup,
    );

    expect(api.version).toBe("1.2.3");
    expect(api.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(api.capabilities()).toEqual(["ping.v1"]);
    expect(api.getStatus()).toBe(status);

    const handler = async () => ({});
    api.registerProcedure("addon.thing", handler, { kind: "read" });
    expect(registry.register).toHaveBeenCalledWith("addon.thing", handler, {
      kind: "read",
    });

    const listener = () => undefined;
    expect(api.onAgentEvent(listener)).toBe(unsubscribe);
    expect(channel.onEvent).toHaveBeenCalledWith(listener);

    api.openSetup();
    expect(openSetup).toHaveBeenCalledOnce();
  });
});
