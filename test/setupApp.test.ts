import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, LinkStatus, Pairing } from "../src/rpc/channel.js";
import { openSetupApp } from "../src/ui/SetupApp.js";
import { CAP_RESPONSE_SIG } from "../src/constants.js";
import { fakeActor, stubWorld } from "./support/companionWorld.js";

// The setup dialog drives the channel's pairing window and renders the link
// status. These tests stand in a DialogV2 that records its content, and a
// channel object exposing only what the dialog reads.

/** The status panel host: records every repaint. */
class FakeHost {
  writes = 0;
  listener?: (event: unknown) => void;
  private html = "";
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(html: string) {
    this.writes += 1;
    this.html = html;
  }
  addEventListener(_type: string, listener: (event: unknown) => void): void {
    this.listener = listener;
  }
  /** A click whose target sits inside `selector`. */
  click(selector: string): void {
    this.listener?.({
      target: { closest: (s: string) => (s === selector ? {} : null) },
    });
  }
}

class FakeDialog {
  static instances: FakeDialog[] = [];
  static confirm = vi.fn(async (_options: { content: string }) => true);
  rendered = false;
  readonly content: string;
  readonly host = new FakeHost();
  readonly element = {
    querySelector: (selector: string) =>
      selector === ".tca-status-host" ? this.host : null,
  };
  constructor(opts: { content: string }) {
    this.content = opts.content;
    FakeDialog.instances.push(this);
  }
  render(): Promise<void> {
    this.rendered = true;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.rendered = false;
    return Promise.resolve();
  }
}

interface FakeChannel {
  open: boolean;
  status: LinkStatus;
  caps: string[];
  channel: Channel;
}

function fakeChannel(
  status: Partial<LinkStatus> = {},
  caps: string[] = [],
): FakeChannel {
  const fake: FakeChannel = {
    open: false,
    caps,
    status: {
      lastAgentHelloAt: null,
      agentPeer: null,
      isResponder: true,
      ...status,
    } as LinkStatus,
    channel: undefined as unknown as Channel,
  };
  const pairing: Pairing = {
    paired: true,
    fingerprint: "ab:cd",
    agentUserName: "Companion",
    pending: null,
  };
  fake.channel = {
    getStatus: () => fake.status,
    getPairing: () => Promise.resolve(pairing),
    advertisedCapabilities: () => fake.caps,
    openPairingWindow: () => {
      fake.open = true;
    },
    closePairingWindow: () => {
      fake.open = false;
    },
  } as unknown as Channel;
  return fake;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeDialog.instances = [];
  vi.stubGlobal("foundry", { applications: { api: { DialogV2: FakeDialog } } });
  vi.stubGlobal("Hooks", { on: () => 0, off: () => {} });
  vi.stubGlobal("ui", {
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  vi.stubGlobal("game", {
    user: { id: "gm1", isGM: true },
    users: { find: () => undefined },
    settings: { get: () => "" },
  });
});

afterEach(async () => {
  // Close whatever is open so the module-level single dialog does not leak.
  for (const d of FakeDialog.instances) await d.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openSetupApp", () => {
  it("reopening setup within the refresh interval keeps the new dialog's pairing window open", async () => {
    const fake = fakeChannel();
    await openSetupApp(fake.channel);
    const [first] = FakeDialog.instances;
    expect(fake.open).toBe(true);

    await first.close(); // the GM closes setup…
    await openSetupApp(fake.channel); // …and reopens it before the old timer ticks
    expect(FakeDialog.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(4000); // the closed dialog's interval runs
    expect(fake.open).toBe(true);

    await FakeDialog.instances[1].close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fake.open).toBe(false); // the open dialog's own teardown still closes it
  });

  it("shows the key-mismatch verdict with what to do", async () => {
    const fake = fakeChannel({ pairingIssue: "response_key_mismatch" }, [
      CAP_RESPONSE_SIG,
    ]);
    await openSetupApp(fake.channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("setup.status.replySigning");
    expect(content).toContain("setup.status.signingKeyMismatch");
    expect(content).toContain("setup.hint.keyMismatch");
  });

  it("shows that reply signing is unavailable in this browser", async () => {
    const fake = fakeChannel({}, []); // responder, nothing signed
    await openSetupApp(fake.channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("setup.status.signingUnavailable");
    expect(content).toContain("setup.hint.noSigner");
    expect(content).not.toContain("setup.status.clockOffset");
  });

  it("shows a clock offset past 45 seconds", async () => {
    const fake = fakeChannel({ lastSkewMs: -60_000 }, [CAP_RESPONSE_SIG]);
    await openSetupApp(fake.channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("setup.status.signingActive");
    expect(content).toContain("setup.status.clockOffset");
    expect(content).toContain("setup.hint.clockOffset");
  });
});

describe("Players in the app", () => {
  // A fresh module graph per test: the presence store and the single setup
  // dialog are module state.
  let open: typeof openSetupApp;
  let store: typeof import("../src/setup/appPresence.js").appPresence;

  beforeEach(async () => {
    vi.resetModules();
    open = (await import("../src/ui/SetupApp.js")).openSetupApp;
    store = (await import("../src/setup/appPresence.js")).appPresence;
    const actors = new Map([["actor1", { name: "Aria <the Bold>" }]]);
    vi.stubGlobal("game", {
      user: { id: "gm1", isGM: true },
      users: { find: () => undefined },
      settings: { get: () => "" },
      actors: { get: (id: string) => actors.get(id) },
      i18n: {
        localize: (key: string) => key,
        format: (key: string, data: Record<string, string>) =>
          `${key}(${Object.values(data).join(",")})`,
      },
    });
  });

  const feed = (seats: unknown[]) =>
    store.onEvent("app.presence", { v: 1, seats });

  it("is hidden until the backend reports presence", async () => {
    await open(fakeChannel().channel);
    expect(FakeDialog.instances[0].content).not.toContain("setup.players");
  });

  it("names each seat after its actor, else its label, else its position", async () => {
    feed([
      {
        memberId: "m1",
        actorId: "actor1",
        label: "ignored",
        state: "inSession",
      },
      { memberId: "m2", actorId: "gone", label: "Bo & Co", state: "appOpen" },
      { memberId: "m3", state: "offline" },
    ]);
    await open(fakeChannel().channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("setup.players.title");
    expect(content).toContain("Aria &lt;the Bold&gt;");
    expect(content).not.toContain("ignored");
    expect(content).toContain("Bo &amp; Co");
    expect(content).toContain("setup.players.seat(3)");
    expect(content).toContain(
      '<b class="tca-ok">table-companion.setup.players.inSession</b>',
    );
    expect(content).toContain(
      '<b class="tca-off">table-companion.setup.players.appOpen</b>',
    );
    expect(content).toContain("setup.players.offline");
    expect(content).not.toContain("setup.players.unknown");
  });

  it("shows one unknown hint instead of the states once the snapshot is old", async () => {
    feed([
      { memberId: "m1", label: "Aria", state: "inSession" },
      { memberId: "m2", label: "Bo", state: "offline" },
    ]);
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
    await open(fakeChannel().channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("Aria");
    expect(content).toContain("Bo");
    expect(content).not.toContain("setup.players.inSession");
    expect(content).not.toContain("setup.players.offline");
    expect(content.split("setup.players.unknown")).toHaveLength(2);
  });

  it("orders the seats by member id whatever order they arrive in", async () => {
    feed([
      { memberId: "m2", label: "Bo", state: "offline" },
      { memberId: "m1", label: "Aria", state: "appOpen" },
    ]);
    await open(fakeChannel().channel);
    const { content, host } = FakeDialog.instances[0];
    expect(content.indexOf("Aria")).toBeGreaterThan(-1);
    expect(content.indexOf("Aria")).toBeLessThan(content.indexOf("Bo"));

    feed([
      { memberId: "m1", label: "Aria", state: "appOpen" },
      { memberId: "m2", label: "Bo", state: "offline" },
    ]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(host.writes).toBe(0);
  });

  it("repaints the panel only when its content changed", async () => {
    feed([{ memberId: "m1", label: "Aria", state: "appOpen" }]);
    await open(fakeChannel().channel);
    const { host } = FakeDialog.instances[0];

    await vi.advanceTimersByTimeAsync(4000 * 3);
    expect(host.writes).toBe(0); // nothing changed: focus and live region kept

    feed([{ memberId: "m1", label: "Aria", state: "inSession" }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(host.writes).toBe(1);
    expect(host.innerHTML).toContain("setup.players.inSession");

    await vi.advanceTimersByTimeAsync(4000 * 3);
    expect(host.writes).toBe(1);
  });
});

describe("Companion visibility", () => {
  const i18n = {
    localize: (key: string) => key,
    format: (key: string, data: Record<string, string>) =>
      `${key}(${Object.values(data).join(",")})`,
  };
  const world = (actors: ReturnType<typeof fakeActor>[]) =>
    stubWorld(actors, true, { i18n });
  const content = () => FakeDialog.instances[0].content;

  beforeEach(() => FakeDialog.confirm.mockClear());

  it("names the player characters Companion cannot see, escaped", async () => {
    world([
      fakeActor("seen", { ann: 3, comp1: 2 }, "Aria"),
      fakeActor("hostile", { bob: 3 }, '<img src=x onerror="alert(1)">'),
      fakeActor("npc", { default: 0 }, "Guard"),
    ]);
    await openSetupApp(fakeChannel().channel);

    expect(content()).toContain(
      '<b class="tca-off">table-companion.setup.visibility.value(Companion,1,2)</b>',
    );
    expect(content()).toContain(
      "setup.visibility.unseen(Companion,&lt;img src=x onerror=&quot;alert(1)&quot;&gt;)",
    );
    expect(content()).not.toContain("<img src=x");
    expect(content()).not.toContain("Guard");
    expect(content()).toContain('data-tca-share="observer"');
  });

  it("offers nothing to share once every player character is visible", async () => {
    world([fakeActor("seen", { ann: 3, comp1: 2 })]);
    await openSetupApp(fakeChannel().channel);
    expect(content()).toContain(
      '<b class="tca-ok">table-companion.setup.visibility.value(Companion,1,1)</b>',
    );
    expect(content()).not.toContain("data-tca-share");
  });

  it("is hidden when no actor has a player owner", async () => {
    world([fakeActor("npc", { default: 2 })]);
    await openSetupApp(fakeChannel().channel);
    expect(content()).not.toContain("setup.visibility");
  });

  it("shares after a confirmation that names the count, then repaints", async () => {
    const unseen = fakeActor("pc", { ann: 3 }, "Bo & Co");
    const other = fakeActor("other", { bob: 3, comp1: 1 });
    world([unseen, other, fakeActor("npc", { default: 0 })]);
    await openSetupApp(fakeChannel().channel);
    const dialog = FakeDialog.instances[0];

    dialog.host.click("[data-tca-share]");
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeDialog.confirm).toHaveBeenCalledTimes(1);
    expect(FakeDialog.confirm.mock.calls[0][0].content).toBe(
      "<p>table-companion.setup.visibility.confirm(Companion,2)</p>",
    );
    expect(unseen.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
    expect(other.update.mock.calls).toEqual([[{ "ownership.comp1": 2 }]]);
    expect(dialog.host.innerHTML).toContain(
      "setup.visibility.value(Companion,2,2)",
    );
  });

  it("changes nothing when the Gamemaster declines", async () => {
    const unseen = fakeActor("pc", { ann: 3 });
    world([unseen]);
    FakeDialog.confirm.mockResolvedValueOnce(false);
    await openSetupApp(fakeChannel().channel);

    FakeDialog.instances[0].host.click("[data-tca-share]");
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeDialog.confirm).toHaveBeenCalledTimes(1);
    expect(unseen.update).not.toHaveBeenCalled();
  });
});
