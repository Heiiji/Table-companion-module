import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL } from "../src/constants.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import {
  buildShowBroadcast,
  clearDisplay,
  displayClear,
  displayShow,
  normalizeDisplayPayload,
  parseDisplayBroadcast,
  present,
  projectorContentHtml,
  startDisplayListener,
  type DisplayView,
} from "../src/procedures/display.js";

// game is stubbed so `localize` (reads game.i18n) and the socket helpers resolve.
// No `foundry` global ⇒ the projector popout (DialogV2) is a no-op, exactly the
// best-effort fallback the renderer is built for — these tests cover the logic,
// not the canvas (which needs a live Foundry, per the backend plan's QA note).
beforeEach(() => {
  vi.stubGlobal("game", { socket: { emit: vi.fn(), on: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

function emitMock(): ReturnType<typeof vi.fn> {
  return (globalThis as unknown as { game: { socket: { emit: ReturnType<typeof vi.fn> } } })
    .game.socket.emit;
}
function onMock(): ReturnType<typeof vi.fn> {
  return (globalThis as unknown as { game: { socket: { on: ReturnType<typeof vi.fn> } } })
    .game.socket.on;
}

const view: DisplayView = {
  name: "Gobelin",
  img: "worlds/w/goblin.webp",
  fields: [
    { label: "PV", value: "12 / 12" },
    { label: "CA", value: "15" },
  ],
  theme: "projector",
};

describe("normalizeDisplayPayload", () => {
  it("accepts a well-formed payload", () => {
    const v = normalizeDisplayPayload(view);
    expect(v.name).toBe("Gobelin");
    expect(v.fields).toHaveLength(2);
    expect(v.theme).toBe("projector");
  });

  it("accepts name-only (no fields, no img)", () => {
    const v = normalizeDisplayPayload({ name: "Masqué" });
    expect(v.fields).toEqual([]);
    expect(v.img).toBeUndefined();
  });

  it("drops un-modeled keys so nothing un-revealed can pass through", () => {
    const v = normalizeDisplayPayload({
      name: "Gobelin",
      fields: [{ label: "PV", value: "12" }],
      secretActorData: { ac: 99, notes: "ambush at the bridge" },
    });
    expect(Object.keys(v).sort()).toEqual(["fields", "name", "theme"]);
    expect(JSON.stringify(v)).not.toContain("ambush");
  });

  it("rejects malformed payloads", () => {
    expect(() => normalizeDisplayPayload({})).toThrow();
    expect(() => normalizeDisplayPayload({ name: "  " })).toThrow();
    expect(() => normalizeDisplayPayload({ name: "x".repeat(201) })).toThrow();
    expect(() =>
      normalizeDisplayPayload({ name: "x", fields: [{ label: "", value: "v" }] }),
    ).toThrow();
    expect(() =>
      normalizeDisplayPayload({ name: "x", fields: [{ label: "L", value: "v".repeat(2001) }] }),
    ).toThrow();
    const tooMany = Array.from({ length: 51 }, () => ({ label: "L", value: "v" }));
    expect(() => normalizeDisplayPayload({ name: "x", fields: tooMany })).toThrow();
  });
});

describe("projectorContentHtml", () => {
  it("renders only the supplied fields, escaping every value (sole escaper)", () => {
    const html = projectorContentHtml({
      name: "<b>Orc</b>",
      fields: [{ label: "Note", value: "<script>alert(1)</script>" }],
      theme: "projector",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Orc&lt;/b&gt;");
    // A text-labeled status block (never color-only) and the supplied field.
    expect(html).toContain("tca-projector-status");
    expect(html).toContain("Note");
  });

  it("includes the portrait only when an img is supplied", () => {
    expect(projectorContentHtml(view)).toContain("tca-projector-portrait");
    expect(
      projectorContentHtml({ name: "No portrait", fields: [], theme: "projector" }),
    ).not.toContain("tca-projector-portrait");
  });
});

describe("display broadcast", () => {
  it("round-trips show through build → parse", () => {
    const parsed = parseDisplayBroadcast(buildShowBroadcast(view));
    expect(parsed?.kind).toBe("show");
    expect(parsed?.kind === "show" && parsed.view.name).toBe("Gobelin");
  });

  it("parses a clear broadcast", () => {
    expect(parseDisplayBroadcast({ tcaDisplay: "clear" })?.kind).toBe("clear");
  });

  it("ignores agent-envelope shape, noise, and malformed views", () => {
    expect(parseDisplayBroadcast({ sig: "x", body: "{}" })).toBeNull(); // signed agent envelope
    expect(parseDisplayBroadcast({ v: 1, type: "hello" })).toBeNull(); // bare envelope
    expect(parseDisplayBroadcast(null)).toBeNull();
    expect(parseDisplayBroadcast("nope")).toBeNull();
    expect(parseDisplayBroadcast({ tcaDisplay: "show", view: { name: "" } })).toBeNull();
  });
});

describe("display.show / display.clear procedures", () => {
  it("display.show returns ok and broadcasts the show view to peers", async () => {
    const res = await displayShow(view, {} as never);
    expect(res).toEqual({ ok: true });
    const calls = emitMock().mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(CHANNEL);
    expect(calls[0][1]).toEqual({ tcaDisplay: "show", view });
  });

  it("display.show rejects a malformed payload (no broadcast)", async () => {
    await expect(displayShow({ name: "" }, {} as never)).rejects.toThrow();
    expect(emitMock()).not.toHaveBeenCalled();
  });

  it("display.clear returns ok and broadcasts a clear", async () => {
    const res = await displayClear(undefined, {} as never);
    expect(res).toEqual({ ok: true });
    expect(emitMock()).toHaveBeenCalledWith(CHANNEL, { tcaDisplay: "clear" });
  });

  it("present broadcasts exactly the supplied fields (no leakage on the wire)", async () => {
    await present(view);
    const sent = emitMock().mock.calls[0][1] as { view: DisplayView };
    expect(sent.view.fields).toEqual(view.fields);
  });
});

describe("startDisplayListener", () => {
  it("subscribes to the shared channel and ignores non-display traffic", () => {
    startDisplayListener();
    const calls = onMock().mock.calls;
    expect(calls[0][0]).toBe(CHANNEL);
    const handler = calls[0][1] as (raw: unknown) => void;
    // A peer broadcast and unrelated traffic must both be handled without throwing
    // (render/clear no-op without a live Foundry).
    expect(() => handler({ tcaDisplay: "clear" })).not.toThrow();
    expect(() => handler(buildShowBroadcast(view))).not.toThrow();
    expect(() => handler({ sig: "x", body: "{}" })).not.toThrow();
  });
});

describe("capability advertisement", () => {
  it("advertises display.show and display.clear", () => {
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.capabilities()).toContain("display.show");
    expect(registry.capabilities()).toContain("display.clear");
  });
});

// clearDisplay is exercised via display.clear above; assert its standalone export
// also broadcasts (used by app-driven teardown paths that bypass the procedure).
describe("clearDisplay", () => {
  it("broadcasts a clear", async () => {
    await clearDisplay();
    expect(emitMock()).toHaveBeenCalledWith(CHANNEL, { tcaDisplay: "clear" });
  });
});
