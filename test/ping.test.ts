import { afterEach, describe, expect, it, vi } from "vitest";
import { ping } from "../src/procedures/ping.js";

afterEach(() => vi.unstubAllGlobals());

describe("ping", () => {
  it("echoes the nonce with Foundry's version", async () => {
    vi.stubGlobal("game", { version: "14.360" });
    expect(await ping({ nonce: "n-1" }, {} as never)).toEqual({
      pong: true,
      nonce: "n-1",
      foundryVersion: "14.360",
    });
  });

  it("answers without a nonce", async () => {
    vi.stubGlobal("game", { version: "13.351" });
    for (const payload of [undefined, null, "x", {}])
      expect(await ping(payload, {} as never)).toEqual({
        pong: true,
        nonce: undefined,
        foundryVersion: "13.351",
      });
  });
});
