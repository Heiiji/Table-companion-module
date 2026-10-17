import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPresenceStore } from "../src/setup/appPresence.js";

// The store keeps the backend's last « who has the app open » snapshot. The
// channel has already checked the signature, sender and world; this checks the
// shape, and a bad snapshot is dropped whole.

const SEAT = {
  memberId: "m1",
  actorId: "a1",
  label: "Aria",
  state: "inSession",
  lastSeenAt: 1_760_000_000_000,
};

function presence(seats: unknown[], extra: Record<string, unknown> = {}) {
  return { v: 1, seats, ...extra };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe("AppPresenceStore", () => {
  it("is empty until a snapshot arrives", () => {
    expect(new AppPresenceStore().get()).toBeNull();
  });

  it("keeps the documented fields of a valid snapshot and its arrival time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const store = new AppPresenceStore();
    store.onEvent(
      "app.presence",
      presence(
        [
          { ...SEAT, extra: "ignored" },
          { memberId: "m2", state: "appOpen" },
          { memberId: "m3", state: "offline", actorId: null, label: null },
        ],
        { other: true },
      ),
    );
    expect(store.get()).toEqual({
      receivedAt: 5_000,
      seats: [
        SEAT,
        { memberId: "m2", state: "appOpen" },
        { memberId: "m3", state: "offline" },
      ],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts the bounds and an empty seat list", () => {
    const store = new AppPresenceStore();
    const seat = {
      memberId: "m".repeat(64),
      actorId: "a".repeat(64),
      label: "l".repeat(128),
      state: "offline",
    };
    store.onEvent("app.presence", presence(Array(32).fill(seat)));
    expect(store.get()?.seats).toHaveLength(32);
    store.onEvent("app.presence", presence([]));
    expect(store.get()?.seats).toEqual([]);
  });

  it("ignores every other event", () => {
    const store = new AppPresenceStore();
    store.onEvent("presence", presence([SEAT]));
    store.onEvent("app.presence.v2", presence([SEAT]));
    expect(store.get()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  const violations: Array<[string, unknown]> = [
    ["a non-object payload", "nope"],
    ["a null payload", null],
    ["another payload version", { v: 2, seats: [SEAT] }],
    ["a missing version", { seats: [SEAT] }],
    ["seats that are not an array", { v: 1, seats: {} }],
    ["more than 32 seats", presence(Array(33).fill(SEAT))],
    ["a seat that is not an object", presence(["m1"])],
    ["a seat that is an array", presence([[SEAT]])],
    ["a missing memberId", presence([{ state: "offline" }])],
    ["an empty memberId", presence([{ ...SEAT, memberId: "" }])],
    ["a memberId over 64", presence([{ ...SEAT, memberId: "m".repeat(65) }])],
    ["a numeric memberId", presence([{ ...SEAT, memberId: 7 }])],
    ["an actorId over 64", presence([{ ...SEAT, actorId: "a".repeat(65) }])],
    ["a numeric actorId", presence([{ ...SEAT, actorId: 1 }])],
    ["a label over 128", presence([{ ...SEAT, label: "l".repeat(129) }])],
    ["a non-string label", presence([{ ...SEAT, label: ["Aria"] }])],
    ["an unknown state", presence([{ ...SEAT, state: "away" }])],
    ["a missing state", presence([{ memberId: "m1" }])],
    ["a string lastSeenAt", presence([{ ...SEAT, lastSeenAt: "1" }])],
    ["an infinite lastSeenAt", presence([{ ...SEAT, lastSeenAt: Infinity }])],
    ["a NaN lastSeenAt", presence([{ ...SEAT, lastSeenAt: NaN }])],
    ["one bad seat among good ones", presence([SEAT, { ...SEAT, state: 1 }])],
  ];

  it.each(violations)(
    "drops %s and keeps the previous snapshot",
    (_name, payload) => {
      const store = new AppPresenceStore();
      store.onEvent("app.presence", presence([SEAT]));
      const before = store.get();
      store.onEvent("app.presence", payload);
      expect(store.get()).toBe(before);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain(
        "dropped app presence snapshot",
      );
    },
  );

  it("names a flood of bad snapshots once per interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = new AppPresenceStore();
    store.onEvent("app.presence", "bad");
    store.onEvent("app.presence", "bad");
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(15_000);
    store.onEvent("app.presence", "bad");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
