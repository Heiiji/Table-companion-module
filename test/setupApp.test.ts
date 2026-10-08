import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, LinkStatus, Pairing } from "../src/rpc/channel.js";
import { openSetupApp } from "../src/ui/SetupApp.js";
import { CAP_RESPONSE_SIG } from "../src/constants.js";

// The setup dialog drives the channel's pairing window and renders the link
// status. These tests stand in a DialogV2 that records its content, and a
// channel object exposing only what the dialog reads.

class FakeDialog {
  static instances: FakeDialog[] = [];
  rendered = false;
  readonly content: string;
  readonly element = { querySelector: () => null };
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
