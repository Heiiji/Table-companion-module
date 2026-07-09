import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_USER_NAME,
  ensureCompanionUser,
  findCompanionUser,
} from "../src/setup/companion-user.js";
import { MODULE_ID } from "../src/constants.js";

afterEach(() => vi.unstubAllGlobals());

interface FakeUser {
  id: string;
  name: string;
  getFlag(scope: string, key: string): unknown;
}

function stubFoundry(existing: FakeUser[] = []): { createSpy: ReturnType<typeof vi.fn> } {
  const createSpy = vi.fn(async (data: { name: string }) => ({
    id: "u-created",
    name: data.name,
    getFlag: () => true,
  }));
  vi.stubGlobal("User", { create: createSpy });
  vi.stubGlobal("CONST", {
    USER_ROLES: { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 },
  });
  vi.stubGlobal("game", {
    users: {
      find: (fn: (u: FakeUser) => boolean) => existing.find(fn),
    },
  });
  return { createSpy };
}

describe("companion-user least-privilege creation", () => {
  it("creates the Companion user with the PLAYER role (not TRUSTED+) and the module flag", async () => {
    const { createSpy } = stubFoundry();
    const result = await ensureCompanionUser();

    expect(result.existed).toBe(false);
    expect(result.userId).toBe("u-created");
    // The password is generated, returned once, never empty.
    expect(result.password).toBeTruthy();

    expect(createSpy).toHaveBeenCalledOnce();
    const data = createSpy.mock.calls[0][0] as {
      name: string;
      role: number;
      password: string;
      flags: Record<string, Record<string, unknown>>;
    };
    expect(data.name).toBe(COMPANION_USER_NAME);
    // Least privilege: PLAYER (1), deliberately below TRUSTED (2).
    expect(data.role).toBe(1);
    // The module flag makes the user findable after a rename.
    expect(data.flags[MODULE_ID]).toEqual({ companion: true });
    expect(data.password).toBe(result.password);
  });

  it("returns the existing user untouched (no create, no password reset)", async () => {
    const existing: FakeUser = {
      id: "u-old",
      name: "Renamed Companion",
      getFlag: (scope, key) => scope === MODULE_ID && key === "companion",
    };
    const { createSpy } = stubFoundry([existing]);
    const result = await ensureCompanionUser();

    expect(result).toEqual({ userId: "u-old", existed: true });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("findCompanionUser prefers the module flag over the name", async () => {
    const flagged: FakeUser = {
      id: "u-flag",
      name: "Totally Renamed",
      getFlag: (scope, key) => scope === MODULE_ID && key === "companion",
    };
    stubFoundry([flagged]);
    expect((findCompanionUser() as unknown as FakeUser).id).toBe("u-flag");
  });

  it("findCompanionUser falls back to the name for pre-flag users", async () => {
    const named: FakeUser = {
      id: "u-name",
      name: COMPANION_USER_NAME,
      getFlag: () => undefined,
    };
    stubFoundry([named]);
    expect((findCompanionUser() as unknown as FakeUser).id).toBe("u-name");
  });
});
