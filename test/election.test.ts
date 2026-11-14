import { afterEach, describe, expect, it, vi } from "vitest";
import { isResponder } from "../src/setup/election.js";
import {
  SETTING_AGENT_USER,
  SETTING_COMPANION_ANCHOR,
} from "../src/constants.js";

interface FakeUser {
  id: string;
  name?: string;
  isGM: boolean;
  active: boolean;
}

function setGame(opts: {
  me?: FakeUser;
  activeGM?: FakeUser | null;
  users?: FakeUser[];
  pairedUserId?: string;
  companionAnchorId?: string;
}): void {
  vi.stubGlobal("game", {
    user: opts.me,
    settings: {
      get: (_scope: string, key: string) => {
        if (key === SETTING_AGENT_USER) return opts.pairedUserId ?? "";
        if (key === SETTING_COMPANION_ANCHOR)
          return opts.companionAnchorId ?? "";
        return "";
      },
    },
    users: {
      activeGM: opts.activeGM ?? null,
      contents: opts.users ?? [],
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

const gm = (id: string, active = true): FakeUser => ({
  id,
  isGM: true,
  active,
});
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

  it("never elects the paired service user, even elevated to GM", () => {
    const me = gm("svc");
    setGame({ me, activeGM: me, pairedUserId: "svc" });
    expect(isResponder()).toBe(false);
  });

  describe.each([
    { pairedUserId: "0-service" },
    { companionAnchorId: "0-service" },
  ])("with an elevated service user identified by %o", (identity) => {
    it.each([true, false])(
      "elects only the lowest-id active human GM (service activeGM: %s)",
      (serviceIsActiveGM) => {
        const service = gm("0-service");
        const firstHuman = gm("b");
        const secondHuman = gm("c");
        const users = [secondHuman, service, gm("a", false), firstHuman];
        for (const me of [service, firstHuman, secondHuman]) {
          setGame({
            ...identity,
            me,
            activeGM: serviceIsActiveGM ? service : null,
            users,
          });
          expect(isResponder()).toBe(me === firstHuman);
        }
      },
    );
  });

  it("elects a human GM who carries the service user's default name", () => {
    const me = { ...gm("b"), name: "Companion" };
    setGame({ me, activeGM: me, pairedUserId: "svc" });
    expect(isResponder()).toBe(true);
  });
});
