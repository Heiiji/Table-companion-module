import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderChatMark,
  startChatMarks,
  type MarkedMessageLike,
} from "../src/ui/chatMarks.js";

const lang = (code: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../lang/${code}.json`, import.meta.url), "utf8"),
    ) as { "table-companion": { chatMark: Record<string, string> } }
  )["table-companion"].chatMark;

/** Stub `game.i18n` with one of the module's real translation files. */
function useLanguage(code: string) {
  const strings = lang(code);
  vi.stubGlobal("game", {
    i18n: {
      localize: (key: string) =>
        strings[key.replace("table-companion.chatMark.", "")] ?? key,
    },
  });
}

const CONTENT = "<p>Combat + Dextérité : 3 réussites</p>";

/** The few DOM members the mark touches, without a browser: the message `li`,
 * its `.message-content`, and the banners inserted before that content. */
function fakeHtml() {
  const classes = new Set<string>();
  const banners: { html: string; remove: () => void }[] = [];
  const content = {
    innerHTML: CONTENT,
    insertAdjacentHTML: vi.fn((position: string, html: string) => {
      expect(position).toBe("beforebegin");
      const banner = {
        html,
        remove: () => banners.splice(banners.indexOf(banner), 1),
      };
      banners.push(banner);
    }),
  };
  const html = {
    classList: { add: (c: string) => classes.add(c) },
    querySelector: (s: string) => (s === ".message-content" ? content : null),
    querySelectorAll: (s: string) => (s === ".tca-mark" ? [...banners] : []),
  };
  return { html: html as unknown as HTMLElement, classes, banners, content };
}

const marked = (receiptState: unknown): MarkedMessageLike => ({
  flags: { "table-companion": { eventId: "e1", origin: "app", receiptState } },
});

afterEach(() => vi.unstubAllGlobals());

describe("renderChatMark", () => {
  const cases = [
    ["annulled", "Cancelled", "Annulé"],
    ["rerolled", "Rerolled", "Relancé"],
    ["revokedByGM", "Removed by the GM", "Retiré par le MJ"],
  ] as const;

  for (const [state, en, fr] of cases) {
    for (const [code, label] of [
      ["en", en],
      ["fr", fr],
    ] as const) {
      it(`greys a ${state} card under « ${label} » (${code})`, () => {
        useLanguage(code);
        const dom = fakeHtml();
        expect(renderChatMark(marked(state), dom.html)).toBe(true);
        expect(dom.classes.has("tca-marked")).toBe(true);
        expect(dom.banners).toHaveLength(1);
        expect(dom.banners[0]!.html).toBe(
          `<div class="tca-mark">${label}</div>`,
        );
        expect(dom.content.innerHTML).toBe(CONTENT);
      });
    }
  }

  it("leaves an unknown state, no state and a foreign message untouched", () => {
    useLanguage("en");
    for (const message of [
      marked("struck"),
      marked(undefined),
      { flags: { "table-companion": { eventId: "e1" } } },
      { flags: { other: { receiptState: "annulled" } } },
      {},
    ] as MarkedMessageLike[]) {
      const dom = fakeHtml();
      expect(renderChatMark(message, dom.html)).toBe(false);
      expect(dom.classes.size).toBe(0);
      expect(dom.banners).toHaveLength(0);
      expect(dom.content.innerHTML).toBe(CONTENT);
    }
  });

  it("keeps one banner when the same card is rendered twice", () => {
    useLanguage("en");
    const dom = fakeHtml();
    renderChatMark(marked("annulled"), dom.html);
    renderChatMark(marked("rerolled"), dom.html);
    expect(dom.banners.map((b) => b.html)).toEqual([
      `<div class="tca-mark">Rerolled</div>`,
    ]);
  });

  it("escapes the label", () => {
    vi.stubGlobal("game", { i18n: { localize: () => "<b>&" } });
    const dom = fakeHtml();
    renderChatMark(marked("annulled"), dom.html);
    expect(dom.banners[0]!.html).toBe(
      `<div class="tca-mark">&lt;b&gt;&amp;</div>`,
    );
  });
});

describe("startChatMarks", () => {
  it("marks a card when a later update of the flag re-renders it", () => {
    useLanguage("en");
    const on = vi.fn();
    vi.stubGlobal("Hooks", { on });
    startChatMarks();
    expect(on.mock.calls[0]![0]).toBe("renderChatMessageHTML");
    const hook = on.mock.calls[0]![1] as (m: unknown, h: unknown) => void;

    // First render: the app's line, not marked yet.
    const first = fakeHtml();
    hook(marked(undefined), first.html);
    expect(first.banners).toHaveLength(0);

    // `updateChatMessage` sets the flag; Foundry renders the message again.
    const second = fakeHtml();
    hook(marked("annulled"), second.html);
    expect(second.classes.has("tca-marked")).toBe(true);
    expect(second.banners.map((b) => b.html)).toEqual([
      `<div class="tca-mark">Cancelled</div>`,
    ]);
  });
});
