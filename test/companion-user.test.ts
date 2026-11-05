import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_USER_NAME,
  ensureCompanionUser,
  findCompanionUser,
  resetCompanionPassword,
} from "../src/setup/companion-user.js";
import { MODULE_ID, SETTING_COMPANION_ANCHOR } from "../src/constants.js";

afterEach(() => vi.unstubAllGlobals());

interface FakeUser {
  id: string;
  name: string;
  isGM?: boolean;
  getFlag(scope: string, key: string): unknown;
  update?: ReturnType<typeof vi.fn>;
}

const flagged = (scope: string, key: string) =>
  scope === MODULE_ID && key === "companion";

function stubFoundry(
  existing: FakeUser[] = [],
  world: { anchor?: string; actors?: Array<{ ownership: object }> } = {},
): {
  createSpy: ReturnType<typeof vi.fn>;
} {
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
      filter: (fn: (u: FakeUser) => boolean) => existing.filter(fn),
    },
    actors: { contents: world.actors ?? [] },
    settings: {
      get: (_scope: string, key: string) =>
        key === SETTING_COMPANION_ANCHOR ? (world.anchor ?? "") : "",
      set: async () => {},
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
      getFlag: flagged,
    };
    const { createSpy } = stubFoundry([existing], { anchor: "u-old" });
    const result = await ensureCompanionUser();

    expect(result).toEqual({ userId: "u-old", existed: true });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("finds a legacy Companion by the module flag alone: not a GM, owning no Actor, the only one", () => {
    stubFoundry([
      { id: "u-flag", name: "Totally Renamed", getFlag: flagged },
      { id: "u-alice", name: "Alice", getFlag: () => undefined },
    ]);
    expect((findCompanionUser() as unknown as FakeUser).id).toBe("u-flag");
  });

  it("never takes a player named like it, a flagged Gamemaster, a flagged character owner, or one of two", () => {
    const named = {
      id: "u-name",
      name: COMPANION_USER_NAME,
      getFlag: () => undefined,
    };
    const gm = { id: "u-gm", name: "GM", isGM: true, getFlag: flagged };
    const owner = { id: "u-alice", name: "Alice", getFlag: flagged };
    for (const [users, actors] of [
      [[named], []],
      [[gm], []],
      [[owner], [{ ownership: { "u-alice": 3 } }]],
      [
        [
          { id: "u-a", name: "A", getFlag: flagged },
          { id: "u-b", name: "B", getFlag: flagged },
        ],
        [],
      ],
    ] as const) {
      stubFoundry([...users], { actors: [...actors] });
      expect(findCompanionUser()).toBeUndefined();
    }
  });

  it("never resets the password of a player who carries the name", async () => {
    const player: FakeUser = {
      id: "u-name",
      name: COMPANION_USER_NAME,
      getFlag: () => undefined,
      update: vi.fn(),
    };
    stubFoundry([player]);
    await expect(resetCompanionPassword()).rejects.toThrow();
    expect(player.update).not.toHaveBeenCalled();
  });
});
