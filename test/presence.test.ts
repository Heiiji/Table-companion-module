import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../src/rpc/channel.js";
import { anyActiveGM, startPresenceWatcher } from "../src/setup/presence.js";
import { SETTING_AGENT_USER } from "../src/constants.js";

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
    // The paired backend user is "comp".
    settings: {
      get: (_scope: string, key: string) =>
        key === SETTING_AGENT_USER ? "comp" : "",
    },
  });
}

function fakeChannel(): { channel: Channel; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  return { channel: { emitEvent: emit } as unknown as Channel, emit };
}

const gm = (id: string): FakeUser => ({
  id,
  isGM: true,
  active: true,
  name: id,
});
const companion: FakeUser = {
  id: "comp",
  isGM: false,
  active: true,
  name: "Companion",
};

/** Window event listeners (`pagehide`), by event name. */
const pageListeners = new Map<string, Array<() => void>>();

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(handlers)) delete handlers[k];
  pageListeners.clear();
  vi.stubGlobal("addEventListener", (name: string, fn: () => void) =>
    pageListeners.set(name, [...(pageListeners.get(name) ?? []), fn]),
  );
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
  it("counts an active human GM but excludes an elevated Companion by id, not name", () => {
    setGame([gm("a")], gm("a"));
    expect(anyActiveGM()).toBe(true);

    // Even if the Companion were somehow a GM, it must not count, renamed or not.
    setGame([{ ...companion, isGM: true, name: "Table bot" }], gm("a"));
    expect(anyActiveGM()).toBe(false);
    // A human GM who happens to be called "Companion" is a GM.
    setGame([{ ...gm("h"), name: "Companion" }], gm("a"));
    expect(anyActiveGM()).toBe(true);
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
    fire("userConnected"); // a leave fires userConnected too
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
  });

  it("observes a GM leaving from another GM's client, which takes over and reports a GM present", () => {
    const a = gm("a");
    const me = gm("b");
    const users = { activeGM: a, contents: [a, me] };
    vi.stubGlobal("game", { user: me, users, settings: { get: () => "" } });
    const { channel, emit } = fakeChannel();

    startPresenceWatcher(channel);
    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled(); // "a" answers the backend

    // "a" closes the tab: Foundry marks it inactive and elects "b".
    a.active = false;
    users.activeGM = me;
    fire("userConnected");
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("presence", { activeGm: true });
  });

  it("says no GM is left when the last GM's responder tab goes away", () => {
    const me = gm("a");
    setGame([me, companion], me);
    const { channel, emit } = fakeChannel();
    startPresenceWatcher(channel);
    vi.advanceTimersByTime(1000);
    emit.mockClear();

    for (const fn of pageListeners.get("pagehide") ?? []) fn();
    expect(emit).toHaveBeenCalledWith("presence", { activeGm: false });
  });

  it("says nothing on the way out while another GM is still here, or off the responder", () => {
    const me = gm("a");
    setGame([me, gm("b")], me);
    const { channel, emit } = fakeChannel();
    startPresenceWatcher(channel);
    vi.advanceTimersByTime(1000);
    emit.mockClear();
    for (const fn of pageListeners.get("pagehide") ?? []) fn();
    expect(emit).not.toHaveBeenCalled();

    const other = gm("b");
    vi.stubGlobal("game", {
      user: other,
      users: { activeGM: me, contents: [other] },
      settings: { get: () => "" },
    });
    for (const fn of pageListeners.get("pagehide") ?? []) fn();
    expect(emit).not.toHaveBeenCalled();
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
