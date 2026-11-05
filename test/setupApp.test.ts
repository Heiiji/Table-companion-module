import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, LinkStatus, Pairing } from "../src/rpc/channel.js";
import { openSetupApp } from "../src/ui/SetupApp.js";
import {
  CAP_RESPONSE_SIG,
  SETTING_COMPANION_ANCHOR,
} from "../src/constants.js";
import { fakeActor, stubWorld } from "./support/companionWorld.js";

// The pairing QR's payload, as the app scans it.
const qrData = vi.hoisted(() => [] as string[]);
vi.mock("qrcode-generator", () => ({
  default: () => ({
    addData: (data: string) => qrData.push(data),
    make: () => {},
    createImgTag: () => "<img>",
  }),
}));

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
  /** The in-content buttons, by `data-tca` action. */
  readonly buttons = new Map<string, () => void>();
  readonly element = {
    querySelector: (selector: string) => {
      if (selector === ".tca-status-host") return this.host;
      const action = /^\[data-tca="(\w+)"\]$/.exec(selector)?.[1];
      if (!action) return null;
      if (action === "qr")
        return { innerHTML: "", querySelector: () => null, remove: () => {} };
      return {
        addEventListener: (_type: string, fn: () => void) =>
          this.buttons.set(action, fn),
      };
    },
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
  withheld?: Record<string, string>;
  /** What replyKeyEnrolled() answers (null: no key, or a single-key backend). */
  enrolled?: boolean | null;
  channel: Channel;
}

function fakeChannel(
  status: Partial<LinkStatus> = {},
  caps: string[] = [],
  pending: Pairing["pending"] = null,
): FakeChannel {
  const fake: FakeChannel = {
    open: false,
    caps,
    status: {
      lastAgentHelloAt: null,
      agentPeer: null,
      isResponder: true,
      enrolledKeys: null,
      ...status,
    } as LinkStatus,
    channel: undefined as unknown as Channel,
  };
  const pairing: Pairing = {
    paired: true,
    fingerprint: "ab:cd",
    agentUserName: "Companion",
    pending,
  };
  fake.channel = {
    getStatus: () => fake.status,
    getPairing: () => Promise.resolve(pairing),
    advertisedCapabilities: () => fake.caps,
    withheldProcedures: () => fake.withheld,
    replyKeyEnrolled: () => fake.enrolled ?? null,
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
    users: { find: () => undefined, filter: () => [] },
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

  it("escapes every translated sentence it writes into the dialog", async () => {
    vi.stubGlobal("game", {
      user: { id: "gm1", isGM: true },
      users: { find: () => undefined, filter: () => [] },
      settings: { get: () => "" },
      i18n: {
        localize: (k: string) => `${k} <b>&`,
        format: (k: string) => `${k} <b>&`,
      },
    });
    await openSetupApp(fakeChannel().channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("setup.intro &lt;b&gt;&amp;");
    expect(content).toContain("setup.ownershipHint &lt;b&gt;&amp;");
    expect(content).not.toContain("<b>");
  });

  it("shows a pending request's fingerprint with the sentence to compare it", async () => {
    vi.stubGlobal("game", {
      user: { id: "gm1", isGM: true },
      users: { find: () => undefined, filter: () => [] },
      settings: { get: () => "" },
      i18n: {
        localize: (k: string) => k,
        format: (k: string, d: Record<string, string>) =>
          `${k}(${Object.values(d).join("|")})`,
      },
    });
    const fake = fakeChannel({}, [], {
      userId: "agentUser0000001",
      userName: "Companion",
      fingerprint: "56:47:5a:a7:54:63:47:4c",
    });
    await openSetupApp(fake.channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("56:47:5a:a7:54:63:47:4c");
    expect(content).toContain("setup.pendingCompare");
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

  it("names a not-yet-enrolled browser when the backend enrolls several", async () => {
    const fake = fakeChannel(
      { pairingIssue: "response_key_mismatch", enrolledKeys: ["other-key"] },
      [CAP_RESPONSE_SIG],
    );
    fake.enrolled = false;
    await openSetupApp(fake.channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("setup.status.signingNotEnrolled");
    expect(content).toContain("setup.hint.keyNotEnrolled");
    expect(content).not.toContain("setup.hint.keyMismatch");
  });

  it("tells another Gamemaster browser whether its key is enrolled", async () => {
    const standby = fakeChannel({ isResponder: false, enrolledKeys: ["k"] });
    standby.enrolled = true;
    await openSetupApp(standby.channel);
    expect(FakeDialog.instances[0].content).toContain(
      "setup.status.signingStandby",
    );
    expect(FakeDialog.instances[0].content).not.toContain(
      "setup.hint.keyNotEnrolled",
    );
  });

  it("says nothing about reply signing on a non-responder of a single-key backend", async () => {
    const fake = fakeChannel({ isResponder: false });
    await openSetupApp(fake.channel);
    expect(FakeDialog.instances[0].content).not.toContain(
      "setup.status.replySigning",
    );
  });

  it("shows that reply signing is unavailable in this browser", async () => {
    const fake = fakeChannel({}, []); // responder, nothing signed
    await openSetupApp(fake.channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("setup.status.signingUnavailable");
    expect(content).toContain("setup.hint.noSigner");
    expect(content).not.toContain("setup.status.clockOffset");
  });

  it("names each withheld procedure with its reason, escaped", async () => {
    const fake = fakeChannel({}, [CAP_RESPONSE_SIG]);
    fake.withheld = {
      "actor.upsert.v1": "requires Knight 3.58.33 or later <b>",
    };
    await openSetupApp(fake.channel);
    const { content } = FakeDialog.instances[0];
    expect(content).toContain("actor.upsert.v1");
    expect(content).toContain("requires Knight 3.58.33 or later &lt;b&gt;");
  });

  it("explains that plain http blocks the backend's signatures", async () => {
    const { checkSignatureSupport } =
      await import("../src/rpc/signatureSupport.js");
    vi.stubGlobal("isSecureContext", false);
    await checkSignatureSupport();
    const fake = fakeChannel({}, [CAP_RESPONSE_SIG]);
    await openSetupApp(fake.channel);
    expect(FakeDialog.instances[0].content).toContain(
      "setup.hint.insecureContext",
    );
    vi.stubGlobal("isSecureContext", true);
    await checkSignatureSupport(); // back to ok for the other tests
  });

  it("says nothing about the connection when signatures can be checked", async () => {
    const fake = fakeChannel({}, [CAP_RESPONSE_SIG]);
    await openSetupApp(fake.channel);
    expect(FakeDialog.instances[0].content).not.toContain(
      "setup.hint.insecureContext",
    );
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
      users: { find: () => undefined, filter: () => [] },
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

describe("setup resets and first run", () => {
  const i18n = {
    localize: (k: string) => k,
    format: (k: string, d: Record<string, string>) =>
      `${k}(${Object.values(d).join("|")})`,
  };
  /** A world whose Companion user the GM renamed. */
  function renamedCompanion() {
    const user = { id: "comp1", name: "Table <Bot>", update: vi.fn() };
    vi.stubGlobal("game", {
      user: { id: "gm1", isGM: true },
      users: { find: () => user, filter: () => [] },
      // The user this module created.
      settings: {
        get: (_scope: string, key: string) =>
          key === SETTING_COMPANION_ANCHOR ? "comp1" : "",
      },
      i18n,
    });
    return user;
  }
  beforeEach(() => {
    FakeDialog.confirm.mockClear();
    qrData.length = 0;
  });

  it("resets the password only after a confirmation naming the user, then shows its current name", async () => {
    const user = renamedCompanion();
    FakeDialog.confirm.mockResolvedValueOnce(false);
    await openSetupApp(fakeChannel().channel);
    const setup = FakeDialog.instances[0];

    setup.buttons.get("resetPassword")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeDialog.confirm).toHaveBeenCalledTimes(1);
    expect(FakeDialog.confirm.mock.calls[0][0].content).toBe(
      "<p>table-companion.setup.confirm.resetPassword(Table &lt;Bot&gt;)</p>",
    );
    expect(user.update).not.toHaveBeenCalled();

    setup.buttons.get("resetPassword")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(user.update).toHaveBeenCalledTimes(1);
    const shown = FakeDialog.instances.at(-1)!.content;
    expect(shown).toContain("setup.password.introReset(Table &lt;Bot&gt;)");
    expect(shown).toContain("setup.password.warning(Table &lt;Bot&gt;)");
    expect(shown).not.toContain("<Bot>");
    expect(qrData).toHaveLength(1);
    expect(qrData[0]).toMatch(
      /^tablecompanion:\/\/pair\?u=Table%20%3CBot%3E&p=/,
    );
  });

  it("resets the pairing only after a confirmation", async () => {
    renamedCompanion();
    const fake = fakeChannel();
    const resetPairing = vi.fn(async () => {});
    (
      fake.channel as unknown as { resetPairing: () => Promise<void> }
    ).resetPairing = resetPairing;
    FakeDialog.confirm.mockResolvedValueOnce(false);
    await openSetupApp(fake.channel);
    const setup = FakeDialog.instances[0];

    setup.buttons.get("reset")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeDialog.confirm.mock.calls[0][0].content).toBe(
      "<p>table-companion.setup.confirm.resetPairing(Table &lt;Bot&gt;)</p>",
    );
    expect(resetPairing).not.toHaveBeenCalled();

    setup.buttons.get("reset")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(resetPairing).toHaveBeenCalledTimes(1);
  });

  it("offers a Gamemaster the setup once per session while the world is not linked, never a player", async () => {
    const fresh = async () => {
      vi.resetModules();
      return (await import("../src/ui/SetupApp.js")).offerSetupIfNeeded;
    };
    const unpaired = fakeChannel();
    (await unpaired.channel.getPairing()).paired = false;

    // A player: nothing.
    vi.stubGlobal("game", {
      user: { id: "p1", isGM: false },
      users: { find: () => undefined, filter: () => [] },
      settings: { get: () => "" },
    });
    let offer = await fresh();
    await offer(unpaired.channel);
    expect(FakeDialog.confirm).not.toHaveBeenCalled();

    // A GM, no Companion user: offered once, non-modal; Open opens the setup.
    renamedCompanion();
    vi.stubGlobal("game", {
      ...game,
      users: { find: () => undefined, filter: () => [] },
    });
    offer = await fresh();
    await offer(unpaired.channel);
    await offer(unpaired.channel);
    expect(FakeDialog.confirm).toHaveBeenCalledTimes(1);
    const prompt = FakeDialog.confirm.mock.calls[0][0] as unknown as {
      content: string;
      modal: boolean;
    };
    expect(prompt.content).toBe("<p>table-companion.setup.firstRun.body</p>");
    expect(prompt.modal).toBe(false);
    expect(FakeDialog.instances).toHaveLength(1); // the setup it opened

    // A GM with the Companion user but no backend paired: offered.
    renamedCompanion();
    FakeDialog.confirm.mockResolvedValueOnce(false);
    offer = await fresh();
    await offer(unpaired.channel);
    expect(FakeDialog.confirm).toHaveBeenCalledTimes(2);
    expect(FakeDialog.instances).toHaveLength(1); // declined: nothing opened

    // Linked (user and pairing): never offered.
    offer = await fresh();
    await offer(fakeChannel().channel);
    expect(FakeDialog.confirm).toHaveBeenCalledTimes(2);
  });
});
