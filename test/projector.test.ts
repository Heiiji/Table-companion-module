import { afterEach, describe, expect, it, vi } from "vitest";
import { closeProjector, openProjector } from "../src/ui/projector.js";

afterEach(() => vi.unstubAllGlobals());

/** A DialogV2 whose render settles a tick later, as Foundry's does: the
 * popout is on screen once `rendered` turns true, until `close`. */
function stubDialogs(closeHook?: () => void) {
  const open = new Set<object>();
  class Dialog {
    rendered = false;
    async render() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.rendered = true;
      open.add(this);
    }
    async close() {
      closeHook?.();
      this.rendered = false;
      open.delete(this);
    }
  }
  vi.stubGlobal("foundry", { applications: { api: { DialogV2: Dialog } } });
  vi.stubGlobal("game", {});
  return open;
}

describe("projector popout", () => {
  it("leaves no popout behind when a clear follows a show still rendering", async () => {
    const open = stubDialogs();
    await Promise.all([openProjector("A", "<p>A</p>"), closeProjector()]);
    expect(open.size).toBe(0);
  });

  it("keeps exactly one popout when two shows arrive together", async () => {
    const open = stubDialogs();
    const shown = await Promise.all([
      openProjector("A", "<p>A</p>"),
      openProjector("B", "<p>B</p>"),
    ]);
    expect(shown).toEqual([true, true]);
    expect(open.size).toBe(1);
    await closeProjector();
    expect(open.size).toBe(0);
  });

  it("retains an open window for retry and refuses to layer a replacement over it", async () => {
    const close = vi.fn().mockImplementation(() => {
      throw new Error("close refused");
    });
    const open = stubDialogs(close);
    expect(await openProjector("A", "A")).toBe(true);
    expect(await closeProjector()).toBe(false);
    expect(await openProjector("B", "B")).toBe(false);
    expect(open.size).toBe(1);
    close.mockImplementation(() => undefined);
    expect(await closeProjector()).toBe(true);
    expect(open.size).toBe(0);
    expect(await closeProjector()).toBe(true);
  });

  it("keeps serving after a render fails", async () => {
    const open = stubDialogs();
    const { DialogV2 } = (
      globalThis as unknown as {
        foundry: { applications: { api: { DialogV2: { prototype: object } } } };
      }
    ).foundry.applications.api;
    const render = vi
      .spyOn(DialogV2.prototype as { render(): Promise<void> }, "render")
      .mockRejectedValueOnce(new Error("boom"));
    expect(await openProjector("A", "<p>A</p>")).toBe(false);
    render.mockRestore();
    expect(await openProjector("B", "<p>B</p>")).toBe(true);
    expect(open.size).toBe(1);
    await closeProjector();
  });
});
