import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../src/rpc/channel.js";
import { anyActiveGM, startPresenceWatcher } from "../src/setup/presence.js";

interface FakeUser {
  id: string;
  isGM: boolean;
  active: boolean;
  name: string;
}

const handlers: Record<string, Array<() => void>> = {};

function fire(hook: string): void {
  for (const fn of handlers[hook] ?? []) fn();
}

/** Stub `game` so the current user is the elected responder (GM + activeGM),
 * with `users.contents` driving anyActiveGM(). */
function setGame(users: FakeUser[], me: FakeUser): void {
  vi.stubGlobal("game", {
    user: me,
    users: { activeGM: me, contents: users },
  });
}

function fakeChannel(): { channel: Channel; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  return { channel: { emitEvent: emit } as unknown as Channel, emit };
}

const gm = (id: string): FakeUser => ({ id, isGM: true, active: true, name: id });
const companion: FakeUser = {
  id: "comp",
  isGM: false,
  active: true,
  name: "Companion",
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.stubGlobal("Hooks", {
    on: (hook: string, fn: () => void) => {
      (handlers[hook] ??= []).push(fn);
      return 0;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("anyActiveGM", () => {
  it("counts an active human GM but excludes an elevated Companion by name", () => {
    setGame([gm("a")], gm("a"));
    expect(anyActiveGM()).toBe(true);

    // Even if the Companion were somehow a GM, it must not count.
    setGame([{ ...companion, isGM: true }], gm("a"));
    expect(anyActiveGM()).toBe(false);
  });

  it("is false when no GM is active", () => {
    setGame([{ id: "p", isGM: false, active: true, name: "p" }], gm("a"));
    expect(anyActiveGM()).toBe(false);
  });
});

describe("startPresenceWatcher", () => {
  it("emits the initial presence state once after the debounce", () => {
    const me = gm("a");
    setGame([me], me);
    const { channel, emit } = fakeChannel();

    startPresenceWatcher(channel);
    expect(emit).not.toHaveBeenCalled(); // debounced, not yet fired
    vi.advanceTimersByTime(1000);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("presence", { activeGm: true });
  });

  it("collapses a flurry of connect/disconnect events into one emit", () => {
    const me = gm("a");
    setGame([me], me);
    const { channel, emit } = fakeChannel();

    startPresenceWatcher(channel);
    fire("userConnected");
    fire("userDisconnected");
    fire("userConnected");
    vi.advanceTimersByTime(1000);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("only emits when the active-GM state actually changes", () => {
    const me = gm("a");
    const users = [me];
    setGame(users, me);
    const { channel, emit } = fakeChannel();

    startPresenceWatcher(channel);
    vi.advanceTimersByTime(1000); // initial -> activeGm:true
    expect(emit).toHaveBeenCalledTimes(1);

    // No change -> no second emit.
    fire("userConnected");
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    // GM leaves -> activeGm flips to false -> one more emit.
    users.length = 0;
    fire("userDisconnected");
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("presence", { activeGm: false });
  });

  it("does not emit when this client is not the responder", () => {
    // A GM who is not the activeGM and not lowest-id is not the responder.
    const me = gm("b");
    vi.stubGlobal("game", {
      user: me,
      users: { activeGM: gm("a"), contents: [gm("a"), me] },
    });
    const { channel, emit } = fakeChannel();

    startPresenceWatcher(channel);
    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled();
  });
});
