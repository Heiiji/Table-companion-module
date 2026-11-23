import { afterEach, expect, it, vi } from "vitest";
import {
  CAP_RESPONSE_SIG,
  LINK_STALE_MS,
  MODULE_ID,
} from "../src/constants.js";
import type { Channel } from "../src/rpc/channel.js";
import {
  postWelcomeLantern,
  registerWelcomeLantern,
} from "../src/ui/welcomeLantern.js";

function world() {
  const values = new Map<string, unknown>();
  const register = vi.fn(
    (_ns: string, key: string, options: { default: unknown }) =>
      values.set(key, options.default),
  );
  const set = vi.fn(async (_ns: string, key: string, value: unknown) => {
    values.set(key, value);
  });
  const gm = {
    id: "gm",
    isGM: true,
    active: true,
    hasPermission: () => true,
    query: vi.fn(async () => true),
  };
  const player = { ...gm, id: "player", isGM: false };
  const service = { ...player, id: "bridge" };
  const messages = new Map();
  const game = {
    i18n: { lang: "fr", localize: (key: string) => key },
    user: player,
    users: {
      activeGM: gm,
      get: (id: string) => (id === service.id ? service : undefined),
    },
    system: { id: "knight" },
    world: { lastPlayed: "2026-01-01T10:00:00Z" },
    messages,
    settings: {
      register,
      set,
      get: (_ns: string, key: string) => values.get(key),
    },
  };
  const create = vi.fn(async (data: any) => {
    if (messages.has(data._id)) throw new Error("Duplicate id");
    messages.set(data._id, data);
    return data;
  });
  const hook = vi.fn();
  const config = { queries: {} as Record<string, () => boolean> };
  const status = {
    lastAgentHelloAt: Date.now(),
    pairingIssue: null as string | null,
    isResponder: true,
  };
  const channel = {
    getStatus: () => status,
    replyKeyEnrolled: () => true,
    advertisedCapabilities: () => [CAP_RESPONSE_SIG],
  };
  vi.stubGlobal("game", game);
  vi.stubGlobal("ChatMessage", { implementation: { create } });
  vi.stubGlobal("Hooks", { on: hook });
  vi.stubGlobal("CONFIG", config);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: (entries: object[]) => void) {}
      observe(target: unknown) {
        this.callback([{ target, isIntersecting: true }]);
      }
    },
  );
  registerWelcomeLantern(channel as unknown as Channel);
  return {
    game,
    gm,
    player,
    service,
    set,
    register,
    create,
    messages,
    values,
    status,
    hook,
    query: config.queries["table-companion.lanternActive"],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("defaults to one silent self-whisper per account in this world, even after deleting the card", async () => {
  const w = world();
  expect(w.register).toHaveBeenCalledWith(
    MODULE_ID,
    "welcomeMode",
    expect.objectContaining({
      scope: "world",
      restricted: true,
      default: "first",
    }),
  );
  expect(w.register).toHaveBeenCalledWith(
    MODULE_ID,
    "welcomeSeen",
    expect.objectContaining({ scope: "user" }),
  );
  await postWelcomeLantern();
  expect(w.create).toHaveBeenCalledWith(
    expect.objectContaining({ whisper: ["player"], sound: null }),
    { keepId: true, notify: false, scroll: false },
  );
  expect(w.messages.get("player").content).toContain("welcome.greeting.knight");
  expect(w.messages.get("player").content).toContain(
    "https://tablecompanion.app/fr/beta/",
  );
  w.messages.clear();
  await postWelcomeLantern();
  expect(w.create).toHaveBeenCalledTimes(1);
});

it("recovers a failed marker write without posting twice and never marks a vetoed creation", async () => {
  const w = world();
  w.create.mockResolvedValueOnce(undefined);
  await postWelcomeLantern();
  expect(w.set).not.toHaveBeenCalled();
  w.set.mockRejectedValueOnce(new Error("offline"));
  await expect(postWelcomeLantern()).rejects.toThrow("offline");
  await postWelcomeLantern();
  expect(w.messages.size).toBe(1);
  expect(w.create).toHaveBeenCalledTimes(2);
  expect(w.values.get("welcomeSeen")).toBe(true);
});

it("posts one shared card per actual launch, across GM reloads and handovers", async () => {
  const w = world();
  w.values.set("welcomeMode", "world");
  await postWelcomeLantern();
  expect(w.create).not.toHaveBeenCalled();
  w.game.user = w.gm;
  await postWelcomeLantern();
  w.game.user = w.game.users.activeGM = { ...w.gm, id: "gm2" };
  await postWelcomeLantern();
  expect(w.create).toHaveBeenCalledTimes(1);
  w.game.world.lastPlayed = "2026-01-01T10:02:00Z";
  await postWelcomeLantern();
  expect(w.messages.size).toBe(2);
  for (const record of w.messages.values()) expect(record.whisper).toEqual([]);
});

it("keeps off and the service account silent; localizes the link and falls back on other systems", async () => {
  const w = world();
  w.values.set("welcomeMode", "off");
  await postWelcomeLantern();
  w.values.set("welcomeMode", "first");
  w.values.set("agentUserId", w.service.id);
  w.game.user = w.service;
  await postWelcomeLantern();
  expect(w.create).not.toHaveBeenCalled();
  w.game.user = w.player;
  w.game.system.id = "unrecognized";
  w.game.i18n.lang = "en";
  await postWelcomeLantern();
  expect(w.messages.get("player").content).toContain("welcome.greeting.other");
  expect(w.messages.get("player").content).toContain(
    "https://tablecompanion.app/beta/",
  );
});

it("only confirms the public badge for a healthy responder with a fresh link", () => {
  const w = world();
  w.values.set("agentPublicKey", "paired");
  w.values.set("agentUserId", w.service.id);
  expect(w.query()).toBe(false);
  w.game.user = w.gm;
  expect(w.query()).toBe(true);
  w.status.pairingIssue = "world_mismatch";
  expect(w.query()).toBe(false);
  w.status.pairingIssue = null;
  w.status.lastAgentHelloAt -= LINK_STALE_MS;
  expect(w.query()).toBe(false);
});

it.each(["dnd5e", "pf2e"])(
  "picks the welcome for the %s system",
  async (system) => {
    const w = world();
    w.game.system.id = system;
    await postWelcomeLantern();
    expect(w.messages.get("player").content).toContain(
      "welcome.greeting." + system,
    );
  },
);

it("replaces the badge in place after a player's link goes idle; diagnostics stay private", async () => {
  vi.useFakeTimers();
  const w = world();
  w.values.set("agentUserId", w.service.id);
  class Button {}
  const badge = {
    hidden: true,
    textContent: "",
    dataset: {},
    isConnected: true,
  };
  vi.stubGlobal("HTMLButtonElement", Button);
  vi.stubGlobal("document", { createElement: () => badge });
  const content = { innerHTML: "", append: vi.fn() };
  const html = {
    querySelector: (selector: string) =>
      selector === ".message-content"
        ? content
        : selector === ".tca-lantern-status"
          ? badge
          : null,
    classList: { add: vi.fn() },
  };
  const render = w.hook.mock.calls[0][1];
  render(
    {
      flags: { [MODULE_ID]: { welcomeOpening: w.game.world.lastPlayed } },
      isContentVisible: false,
    },
    html,
  );
  expect(content.append).not.toHaveBeenCalled();
  render(
    { flags: { [MODULE_ID]: { welcomeOpening: w.game.world.lastPlayed } } },
    html,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(badge.textContent).toContain("welcome.status.active");
  w.gm.query.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(badge.hidden).toBe(true);
  expect(badge.textContent).toBe("");
  expect(content.append).toHaveBeenCalledTimes(1);
  expect(w.create).not.toHaveBeenCalled();
});
