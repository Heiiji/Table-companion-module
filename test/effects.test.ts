import { afterEach, describe, expect, it, vi } from "vitest";
import { effectApply, effectRemove, effectSetValue } from "../src/procedures/effects.js";
import { RpcError } from "../src/rpc/errors.js";

afterEach(() => vi.unstubAllGlobals());

describe("effect procedures — Companion permission gate", () => {
  it("denies a write when the Companion user lacks OWNER on the actor", async () => {
    const companion = { id: "c1", name: "Companion", getFlag: () => true };
    const toggleStatusEffect = vi.fn(async () => undefined);
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      users: [companion],
      actors: {
        get: () => ({ toggleStatusEffect, testUserPermission: () => false }),
      },
    });
    await expect(
      effectApply({ actorId: "a1", statusId: "frightened", value: 1 }, {} as never),
    ).rejects.toBeInstanceOf(RpcError);
    // The write never ran because the gate rejected first.
    expect(toggleStatusEffect).not.toHaveBeenCalled();
  });

  it("allows a write when the Companion user holds OWNER", async () => {
    const companion = { id: "c1", name: "Companion", getFlag: () => true };
    const toggleStatusEffect = vi.fn(async () => undefined);
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      users: [companion],
      actors: {
        get: () => ({ toggleStatusEffect, testUserPermission: () => true }),
      },
    });
    await effectApply({ actorId: "a1", statusId: "prone" }, {} as never);
    expect(toggleStatusEffect).toHaveBeenCalledWith("prone", { active: true });
  });
});

describe("effect.apply", () => {
  it("all generic effect handlers reject PF2e before reading or mutating an actor", async () => {
    const increaseCondition = vi.fn(async () => undefined);
    const decreaseCondition = vi.fn(async () => undefined);
    const del = vi.fn(async () => undefined);
    const getActor = vi.fn(() => ({
      increaseCondition,
      decreaseCondition,
      effects: { get: () => ({ delete: del }) },
    }));
    vi.stubGlobal("game", { system: { id: "pf2e" }, actors: { get: getActor } });

    await expect(
      effectApply({ actorId: "a1", statusId: "frightened", value: 2 }, {} as never),
    ).rejects.toMatchObject({ code: "unsupported_runtime" });
    await expect(
      effectRemove({ actorId: "a1", effectId: "condition-item" }, {} as never),
    ).rejects.toMatchObject({ code: "unsupported_runtime" });
    await expect(
      effectSetValue({ actorId: "a1", statusId: "frightened", value: 0 }, {} as never),
    ).rejects.toMatchObject({ code: "unsupported_runtime" });

    expect(getActor).not.toHaveBeenCalled();
    expect(increaseCondition).not.toHaveBeenCalled();
    expect(decreaseCondition).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("non-pf2e falls back to toggleStatusEffect", async () => {
    const toggleStatusEffect = vi.fn(async () => undefined);
    vi.stubGlobal("game", { system: { id: "dnd5e" }, actors: { get: () => ({ toggleStatusEffect }) } });
    await effectApply({ actorId: "a1", statusId: "prone" }, {} as never);
    expect(toggleStatusEffect).toHaveBeenCalledWith("prone", { active: true });
  });

  it("requires statusId", async () => {
    vi.stubGlobal("game", { system: { id: "dnd5e" }, actors: { get: () => ({}) } });
    await expect(effectApply({ actorId: "a1" }, {} as never)).rejects.toThrow(/statusId/);
  });
});

describe("effect.remove", () => {
  it("deletes the embedded ActiveEffect (generic core API — e.g. dnd5e concentration drop)", async () => {
    const del = vi.fn(async () => undefined);
    vi.stubGlobal("game", {
      system: { id: "dnd5e" },
      actors: { get: () => ({ effects: { get: (id: string) => (id === "e1" ? { delete: del } : undefined) } }) },
    });
    const res = (await effectRemove({ actorId: "a1", effectId: "e1" }, {} as never)) as { ok: boolean; removed: string };
    expect(del).toHaveBeenCalled();
    expect(res).toEqual({ ok: true, removed: "e1" });
  });

  it("throws on an unknown effect", async () => {
    vi.stubGlobal("game", { system: { id: "dnd5e" }, actors: { get: () => ({ effects: { get: () => undefined } }) } });
    await expect(effectRemove({ actorId: "a1", effectId: "ghost" }, {} as never)).rejects.toThrow(/unknown effect/);
  });
});

describe("effect.setValue", () => {
  it("rejects a negative value", async () => {
    vi.stubGlobal("game", { system: { id: "dnd5e" }, actors: { get: () => ({}) } });
    await expect(effectSetValue({ actorId: "a1", statusId: "x", value: -1 }, {} as never)).rejects.toThrow(/value/);
  });
});
