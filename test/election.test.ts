import { afterEach, describe, expect, it, vi } from "vitest";
import { isResponder } from "../src/setup/election.js";

interface FakeUser {
  id: string;
  isGM: boolean;
  active: boolean;
}

function setGame(opts: {
  me?: FakeUser;
  activeGM?: FakeUser | null;
  users?: FakeUser[];
}): void {
  vi.stubGlobal("game", {
    user: opts.me,
    users: {
      activeGM: opts.activeGM ?? null,
      contents: opts.users ?? [],
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

const gm = (id: string, active = true): FakeUser => ({ id, isGM: true, active });
const player = (id: string): FakeUser => ({ id, isGM: false, active: true });

describe("isResponder", () => {
  it("is false for a non-GM", () => {
    setGame({ me: player("p1") });
    expect(isResponder()).toBe(false);
  });

  it("is false when there is no current user", () => {
    setGame({ me: undefined });
    expect(isResponder()).toBe(false);
  });

  it("defers to Foundry's activeGM when present", () => {
    const me = gm("b");
    setGame({ me, activeGM: me });
    expect(isResponder()).toBe(true);

    setGame({ me, activeGM: gm("a") });
    expect(isResponder()).toBe(false);
  });

  it("falls back to the lowest-id active GM when activeGM is null", () => {
    const me = gm("a");
    setGame({
      me,
      activeGM: null,
      users: [gm("c"), me, gm("b"), player("p1")],
    });
    expect(isResponder()).toBe(true);
  });

  it("loses the fallback election to a lower-id active GM", () => {
    const me = gm("b");
    setGame({ me, activeGM: null, users: [gm("a"), me] });
    expect(isResponder()).toBe(false);
  });

  it("ignores inactive GMs in the fallback", () => {
    const me = gm("b");
    setGame({ me, activeGM: null, users: [gm("a", false), me] });
    expect(isResponder()).toBe(true);
  });
});
