import { vi, type Mock } from "vitest";

// Fakes that test permissions the way Foundry does for a world Actor: a GM
// owns everything, else the user's explicit level, else `default`.
export interface FakeUser {
  id: string;
  name: string;
  isGM?: boolean;
}

export interface FakeActor {
  id: string;
  name: string;
  ownership: Record<string, number>;
  update: Mock<(changes: Record<string, unknown>) => Promise<void>>;
  testUserPermission(user: FakeUser, permission: string): boolean;
}

const LEVEL: Record<string, number> = { OBSERVER: 2, OWNER: 3 };

export function fakeActor(
  id: string,
  ownership: Record<string, number>,
  name = id,
): FakeActor {
  const actor: FakeActor = {
    id,
    name,
    ownership,
    update: vi.fn(async (changes: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(changes))
        actor.ownership[key.slice("ownership.".length)] = Number(value);
    }),
    testUserPermission: (user, permission) =>
      (user.isGM
        ? 3
        : (actor.ownership[user.id] ?? actor.ownership.default ?? 0)) >=
      LEVEL[permission],
  };
  return actor;
}

export const COMPANION: FakeUser = { id: "comp1", name: "Companion" };
export const USERS: FakeUser[] = [
  { id: "gm1", name: "GM", isGM: true },
  COMPANION,
  { id: "ann", name: "Ann" },
  { id: "bob", name: "Bob" },
];

/** A world with a GM, the Companion user (paired) and two players. */
export function stubWorld(
  actors: FakeActor[],
  isGM = true,
  extra: Record<string, unknown> = {},
): void {
  vi.stubGlobal("game", {
    ...extra,
    user: { ...USERS[0], isGM },
    users: {
      contents: USERS,
      get: (id: string) => USERS.find((user) => user.id === id),
      find: (fn: (user: FakeUser) => boolean) => USERS.find(fn),
    },
    settings: { get: () => COMPANION.id },
    actors: {
      contents: actors,
      get: (id: string) => actors.find((actor) => actor.id === id),
    },
  });
}
