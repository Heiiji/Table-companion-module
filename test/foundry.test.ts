import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCompanionPermission } from "../src/procedures/foundry.js";
import { RpcError } from "../src/rpc/errors.js";

afterEach(() => vi.unstubAllGlobals());

/** Stub `game.users` with a single Companion user (flag-stamped), as
 * findCompanionUser() resolves it. */
function stubCompanionUser(): { id: string; name: string } {
  const companion = { id: "companion1", name: "Companion", getFlag: () => true };
  vi.stubGlobal("game", { users: [companion] });
  return companion;
}

describe("assertCompanionPermission", () => {
  it("passes when the Companion user holds the required ownership", () => {
    const companion = stubCompanionUser();
    const testUserPermission = vi.fn((user: unknown, level: string) => {
      expect(user).toBe(companion);
      expect(level).toBe("OWNER");
      return true;
    });
    expect(() =>
      assertCompanionPermission({ testUserPermission }, "OWNER", "a1"),
    ).not.toThrow();
    expect(testUserPermission).toHaveBeenCalledOnce();
  });

  it("throws permission_denied when the Companion user lacks ownership", () => {
    stubCompanionUser();
    const testUserPermission = vi.fn(() => false);
    try {
      assertCompanionPermission({ testUserPermission }, "OBSERVER", "a1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe("permission_denied");
    }
  });

  it("throws permission_denied when no Companion user is configured", () => {
    vi.stubGlobal("game", { users: [] });
    try {
      assertCompanionPermission({ testUserPermission: () => true }, "OWNER", "a1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe("permission_denied");
    }
  });

  it("is a no-op for a fake actor without testUserPermission (unit harness)", () => {
    // No game stub at all: the check short-circuits before touching Foundry.
    expect(() => assertCompanionPermission({}, "OWNER", "a1")).not.toThrow();
  });
});
