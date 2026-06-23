import { afterEach, describe, expect, it, vi } from "vitest";
import { effectApply, effectRemove, effectSetValue } from "../src/procedures/effects.js";

afterEach(() => vi.unstubAllGlobals());

describe("effect.apply", () => {
  it("pf2e increments a valued condition via the system API", async () => {
    const increaseCondition = vi.fn(async () => undefined);
    vi.stubGlobal("game", { system: { id: "pf2e" }, actors: { get: () => ({ increaseCondition }) } });
    const res = (await effectApply({ actorId: "a1", statusId: "frightened", value: 2 }, {} as never)) as {
      ok: boolean;
      applied: string;
    };
    expect(increaseCondition).toHaveBeenCalledWith("frightened", { value: 2 });
    expect(res).toEqual({ ok: true, applied: "frightened" });
  });

  it("non-pf2e falls back to toggleStatusEffect", async () => {
    const toggleStatusEffect = vi.fn(async () => undefined);
    vi.stubGlobal("game", { system: { id: "dnd5e" }, actors: { get: () => ({ toggleStatusEffect }) } });
    await effectApply({ actorId: "a1", statusId: "prone" }, {} as never);
    expect(toggleStatusEffect).toHaveBeenCalledWith("prone", { active: true });
  });

  it("requires statusId", async () => {
    vi.stubGlobal("game", { system: { id: "pf2e" }, actors: { get: () => ({}) } });
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
  it("pf2e drives the badge toward the target value", async () => {
    const increaseCondition = vi.fn(async () => undefined);
    const decreaseCondition = vi.fn(async () => undefined);
    vi.stubGlobal("game", {
      system: { id: "pf2e" },
      actors: { get: () => ({ increaseCondition, decreaseCondition }) },
    });
    await effectSetValue({ actorId: "a1", statusId: "clumsy", value: 3 }, {} as never);
    expect(increaseCondition).toHaveBeenCalledWith("clumsy", { value: 3 });
  });

  it("pf2e value 0 force-removes the condition", async () => {
    const increaseCondition = vi.fn(async () => undefined);
    const decreaseCondition = vi.fn(async () => undefined);
    vi.stubGlobal("game", {
      system: { id: "pf2e" },
      actors: { get: () => ({ increaseCondition, decreaseCondition }) },
    });
    await effectSetValue({ actorId: "a1", statusId: "frightened", value: 0 }, {} as never);
    expect(decreaseCondition).toHaveBeenCalledWith("frightened", { forceRemove: true });
  });

  it("rejects a negative value", async () => {
    vi.stubGlobal("game", { system: { id: "pf2e" }, actors: { get: () => ({}) } });
    await expect(effectSetValue({ actorId: "a1", statusId: "x", value: -1 }, {} as never)).rejects.toThrow(/value/);
  });
});
