import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showPassword } from "../src/ui/passwordDialog.js";

// The pairing QR's payload, as the app scans it; `qrFails` makes it throw.
const qr = vi.hoisted(() => ({ data: [] as string[], fails: false }));
vi.mock("qrcode-generator", () => ({
  default: () => ({
    addData: (data: string) => qr.data.push(data),
    make: () => {
      if (qr.fails) throw new Error("too long");
    },
    createImgTag: () => "<img>",
  }),
}));

/** The password dialog's content, as far as the dialog's code touches it. */
class FakeDialog {
  static instances: FakeDialog[] = [];
  rendered = false;
  copy?: () => void;
  readonly code = { focus: vi.fn() };
  readonly img = { setAttribute: vi.fn() };
  readonly qrHost = {
    innerHTML: "",
    removed: false,
    querySelector: () => this.img,
    remove: () => {
      this.qrHost.removed = true;
    },
  };
  readonly element = {
    querySelector: (selector: string) =>
      ({
        '[data-tca="copy"]': {
          addEventListener: (_type: string, fn: () => void) => {
            this.copy = fn;
          },
        },
        '[data-tca="qr"]': this.qrHost,
        ".tca-password-box code": this.code,
      })[selector] ?? null,
  };
  constructor(readonly options: { content: string }) {
    FakeDialog.instances.push(this);
  }
  render(): Promise<void> {
    this.rendered = true;
    return Promise.resolve();
  }
  close = vi.fn(() => {
    this.rendered = false;
    return Promise.resolve();
  });
}

const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
let execCommand: ReturnType<typeof vi.fn>;

function stubBrowser(origin: string, clipboard?: object): void {
  vi.stubGlobal("window", {
    location: { origin },
    getSelection: () => selection,
  });
  vi.stubGlobal("navigator", { clipboard });
}

beforeEach(() => {
  FakeDialog.instances = [];
  qr.data.length = 0;
  qr.fails = false;
  execCommand = vi.fn(() => true);
  vi.stubGlobal("foundry", { applications: { api: { DialogV2: FakeDialog } } });
  vi.stubGlobal("ui", { notifications: notify });
  vi.stubGlobal("document", {
    createRange: () => ({ selectNodeContents: vi.fn() }),
    execCommand,
  });
  vi.stubGlobal("game", {
    users: { find: () => undefined, filter: () => [] },
    settings: { get: () => "" },
  });
  stubBrowser("https://foundry.example.com:30000");
  for (const fn of Object.values(notify)) fn.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

const shown = () => FakeDialog.instances.at(-1)!;

describe("the password dialog", () => {
  it("escapes the password and selects it on open", async () => {
    await showPassword("a<b>&c");
    expect(shown().options.content).toContain(
      '<code tabindex="0">a&lt;b&gt;&amp;c</code>',
    );
    expect(shown().code.focus).toHaveBeenCalled();
    expect(selection.addRange).toHaveBeenCalled();
  });

  it("closes the previous reveal before showing a new one", async () => {
    await showPassword("first");
    const first = shown();
    await showPassword("second", true);
    expect(first.close).toHaveBeenCalled();
    expect(FakeDialog.instances).toHaveLength(2);
  });
});

describe("the pairing QR", () => {
  it("encodes the user, the password and the server the browser is on", async () => {
    await showPassword("p&ss w");
    expect(qr.data).toEqual([
      "tablecompanion://pair?u=Companion&p=p%26ss%20w" +
        "&h=https%3A%2F%2Ffoundry.example.com%3A30000",
    ]);
    expect(shown().qrHost.innerHTML).toBe("<img>");
    expect(shown().img.setAttribute).toHaveBeenCalledWith(
      "alt",
      expect.any(String),
    );
  });

  it.each([
    "http://localhost:30000",
    "http://foundry.localhost",
    "http://127.0.0.1:30000",
    "http://[::1]:30000",
    "null",
  ])("leaves out a server the phone cannot reach (%s)", async (origin) => {
    stubBrowser(origin);
    await showPassword("pw");
    expect(qr.data[0]).toBe("tablecompanion://pair?u=Companion&p=pw");
  });

  it("keeps a LAN address", async () => {
    stubBrowser("http://192.168.1.20:30000");
    await showPassword("pw");
    expect(qr.data[0]).toContain("&h=http%3A%2F%2F192.168.1.20%3A30000");
  });

  it("drops the QR block when the code cannot be made", async () => {
    qr.fails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await showPassword("pw");
    expect(shown().qrHost.removed).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe("Copy", () => {
  it("uses the Clipboard API when it is there", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubBrowser("https://f.example", { writeText });
    await showPassword("pw");
    shown().copy!();
    await vi.waitFor(() => expect(notify.info).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith("pw");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a selection copy when the Clipboard API refuses", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("insecure")));
    stubBrowser("http://f.example", { writeText });
    await showPassword("pw");
    shown().copy!();
    await vi.waitFor(() => expect(notify.info).toHaveBeenCalled());
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("asks the Gamemaster to copy by hand when nothing copies", async () => {
    execCommand.mockReturnValue(false);
    await showPassword("pw");
    shown().copy!();
    await vi.waitFor(() => expect(notify.warn).toHaveBeenCalled());
    expect(notify.info).not.toHaveBeenCalled();
  });
});
