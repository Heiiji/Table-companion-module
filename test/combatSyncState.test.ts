import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../src/rpc/channel.js";
import {
  COMBAT_STATE_EVENT,
  COMBAT_STATE_REQUEST_EVENT,
  combatStateV1,
  combatStateV1Snapshot,
  startCombatStateWatcher,
} from "../src/procedures/combatSyncState.js";
import { MODULE_ID, SETTING_AGENT_USER } from "../src/constants.js";

type Dict = Record<string, unknown>;

const handlers: Record<string, Array<() => void>> = {};
const fire = (hook: string) => {
  for (const fn of handlers[hook] ?? []) fn();
};

function combatant(id: string, over: Dict = {}): Dict {
  return {
    id,
    name: id.slice(0, 6),
    initiative: null,
    hidden: false,
    actorId: null,
    flags: {},
    ...over,
  };
}

function combat(id: string, over: Dict = {}): Dict {
  return {
    id,
    active: false,
    round: 0,
    turn: null,
    turns: [],
    combatants: { contents: [] },
    flags: {},
    ...over,
  };
}

let world: Dict[] = [];

function stubGame({ responder = true, paired = true, system = "knight" } = {}) {
  const me = { id: "gm1", isGM: true, active: true };
  vi.stubGlobal("game", {
    user: me,
    users: { activeGM: responder ? me : { id: "gm2" }, contents: [me] },
    settings: {
      get: (_scope: string, key: string) =>
        key === SETTING_AGENT_USER && paired ? "comp" : "",
    },
    system: { id: system },
    release: { generation: 14 },
    combats: {
      get contents() {
        return world;
      },
    },
  });
}

beforeEach(() => {
  world = [];
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.useFakeTimers();
  vi.stubGlobal("Hooks", {
    on: (hook: string, fn: () => void) => {
      (handlers[hook] ??= []).push(fn);
      return 0;
    },
  });
  stubGame();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("combatStateV1Snapshot", () => {
  it("reports a Combat started in Foundry in its turn order, with the active combatant", () => {
    const hero = combatant("cbtHero000000001", {
      name: "Hero",
      initiative: 14.5,
      actorId: "actAriane0000001",
    });
    const orc = combatant("cbtOrc0000000001", {
      name: "Orc",
      initiative: 9,
      hidden: true,
      actorId: "actorOrcNpc00001",
    });
    world.push(
      combat("combatFoundry001", {
        active: true,
        round: 2,
        turn: 1,
        turns: [hero, orc],
        combatants: { contents: [orc, hero] },
      }),
    );
    expect(combatStateV1Snapshot()).toEqual({
      schemaVersion: 1,
      truncated: false,
      combats: [
        {
          id: "combatFoundry001",
          active: true,
          round: 2,
          activeCombatantId: "cbtOrc0000000001",
          appCombatId: null,
          appliedSequence: null,
          combatants: [
            {
              id: "cbtHero000000001",
              actorId: "actAriane0000001",
              name: "Hero",
              initiative: 14.5,
              hidden: false,
              appKey: null,
            },
            {
              id: "cbtOrc0000000001",
              actorId: "actorOrcNpc00001",
              name: "Orc",
              initiative: 9,
              hidden: true,
              appKey: null,
            },
          ],
        },
      ],
    });
  });

  it("names no active combatant before the start and falls back to the collection order", () => {
    const a = combatant("cbtA000000000001");
    world.push(combat("combatFoundry001", { combatants: { contents: [a] } }));
    const [state] = combatStateV1Snapshot().combats;
    expect(state.activeCombatantId).toBeNull();
    expect(state.combatants.map((c) => c.id)).toEqual(["cbtA000000000001"]);
  });

  it("reads our flags and drops malformed ones", () => {
    world.push(
      combat("combatMirror0001", {
        round: 1,
        flags: {
          [MODULE_ID]: {
            combatSync: { combatId: "app-combat-1", appliedRevision: 7 },
          },
        },
        turns: [
          combatant("cbtKeyed00000001", {
            flags: { [MODULE_ID]: { key: "entry-1" } },
          }),
          combatant("cbtBadKey0000001", {
            flags: { [MODULE_ID]: { key: "bad key" } },
          }),
        ],
      }),
      combat("combatBadFlag001", {
        flags: {
          [MODULE_ID]: { combatSync: { combatId: 3, appliedRevision: 0 } },
        },
      }),
    );
    const [mirror, bad] = combatStateV1Snapshot().combats;
    expect(mirror).toMatchObject({
      appCombatId: "app-combat-1",
      appliedSequence: 7,
    });
    expect(mirror.combatants.map((c) => c.appKey)).toEqual(["entry-1", null]);
    expect(bad).toMatchObject({ appCombatId: null, appliedSequence: null });
  });

  it("clamps what the backend would refuse and skips documents without an id", () => {
    world.push(
      combat("combatFoundry001", {
        round: 12345,
        turns: [
          combatant("cbtA000000000001", {
            name: "N\0" + "x".repeat(200),
            initiative: 5e9,
          }),
          combatant("cbtB000000000001", { initiative: Number.NaN }),
          combatant("not-a-foundry-id"),
        ],
      }),
      combat("bad"),
    );
    const { combats } = combatStateV1Snapshot();
    expect(combats).toHaveLength(1);
    expect(combats[0].round).toBe(9999);
    expect(combats[0].combatants).toHaveLength(2);
    expect(combats[0].combatants[0].name).toHaveLength(120);
    expect(combats[0].combatants[0].name.startsWith("N")).toBe(true);
    expect(combats[0].combatants[0].initiative).toBe(1_000_000);
    expect(combats[0].combatants[1].initiative).toBeNull();
  });

  it("ranks flagged, then started, then active, caps 16 combats and 64 combatants, and says so", () => {
    const id = (n: number) => `combat${String(n).padStart(10, "0")}`;
    for (let n = 0; n < 20; n++) world.push(combat(id(n)));
    world.push(
      combat("combatStarted001", { round: 1 }),
      combat("combatActive0001", { active: true }),
      combat("combatMirror0001", {
        flags: { [MODULE_ID]: { combatSync: { combatId: "x" } } },
        turns: Array.from({ length: 70 }, (_, i) =>
          combatant(`cbt${String(i).padStart(13, "0")}`),
        ),
      }),
    );
    const snap = combatStateV1Snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.combats).toHaveLength(16);
    expect(snap.combats.slice(0, 3).map((c) => c.id)).toEqual([
      "combatMirror0001",
      "combatStarted001",
      "combatActive0001",
    ]);
    expect(snap.combats[0].combatants).toHaveLength(64);
  });

  it("is empty when Foundry holds no Combat, and the procedure answers the same", () => {
    expect(combatStateV1({}, {} as never)).toEqual({
      schemaVersion: 1,
      truncated: false,
      combats: [],
    });
  });
});

describe("startCombatStateWatcher", () => {
  let agentEvent: (proc: string, payload: unknown) => void = () => {};
  function watch() {
    const emit = vi.fn();
    startCombatStateWatcher({
      emitEvent: emit,
      onEvent: (fn: typeof agentEvent) => {
        agentEvent = fn;
        return () => {};
      },
    } as unknown as Channel);
    return emit;
  }

  it("pushes the snapshot once after start and once per burst of combat changes", () => {
    const emit = watch();
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(COMBAT_STATE_EVENT, {
      schemaVersion: 1,
      truncated: false,
      combats: [],
    });

    world.push(combat("combatFoundry001", { round: 1 }));
    fire("createCombat");
    fire("createCombatant");
    vi.advanceTimersByTime(100);
    fire("updateCombat");
    vi.advanceTimersByTime(249);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.lastCall?.[1].combats[0].id).toBe("combatFoundry001");

    world = [];
    fire("deleteCombat");
    vi.advanceTimersByTime(250);
    expect(emit.mock.lastCall?.[1].combats).toEqual([]);
    for (const hook of ["updateCombatant", "deleteCombatant"]) {
      fire(hook);
      vi.advanceTimersByTime(250);
    }
    expect(emit).toHaveBeenCalledTimes(5);
  });

  it("answers the backend's request at once and ignores its other events", () => {
    const emit = watch();
    vi.advanceTimersByTime(1000);
    world.push(combat("combatFoundry001", { round: 1 }));
    agentEvent("app.presence", {});
    vi.advanceTimersByTime(0);
    expect(emit).toHaveBeenCalledTimes(1);
    agentEvent(COMBAT_STATE_REQUEST_EVENT, {});
    vi.advanceTimersByTime(0);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.lastCall?.[1].combats[0].id).toBe("combatFoundry001");
  });

  it("stays silent on a tab that is not the responder or not paired", () => {
    stubGame({ responder: false });
    const emit = watch();
    fire("updateCombat");
    vi.advanceTimersByTime(2000);
    stubGame({ paired: false });
    fire("updateCombat");
    vi.advanceTimersByTime(2000);
    expect(emit).not.toHaveBeenCalled();
    // Becoming the responder later says it.
    stubGame();
    fire("userConnected");
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("never starts on a system the backend does not mirror", () => {
    stubGame({ system: "pf2e" });
    const emit = watch();
    fire("updateCombat");
    vi.advanceTimersByTime(2000);
    expect(emit).not.toHaveBeenCalled();
    expect(handlers.updateCombat).toBeUndefined();
  });
});
