import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  knightCardData,
  renderKnightRollCard,
  startKnightRollCards,
  type ChatMessageLike,
} from "../src/ui/knightRollCard.js";

const localize = (key: string) => `[${key}]`;

function appRoll(
  extra: Record<string, unknown> = {},
  results = [2, 5],
): ChatMessageLike {
  return {
    flavor: "Combat + Dextérité",
    rolls: [
      {
        formula: "2d6",
        dice: [{ faces: 6, results: results.map((result) => ({ result })) }],
      },
    ],
    flags: {
      "table-companion": {
        eventId: "e1",
        rollMode: "successPool",
        rollSuccesses: 1,
        ...extra,
      },
    },
  };
}

/** The few DOM members the card code touches, without a browser. */
function fakeHtml(withContent = true) {
  const flavor = { remove: vi.fn() };
  const tip = { style: { display: "" } };
  let listener: (() => void) | undefined;
  const diceResult = {
    querySelector: () => tip,
    addEventListener: (_: string, fn: () => void) => (listener = fn),
  };
  const content = {
    innerHTML: "<div class='dice-roll'>generic</div>",
    querySelectorAll: () => [diceResult],
  };
  const html = {
    querySelector: (selector: string) =>
      selector === ".message-content"
        ? withContent
          ? content
          : null
        : selector === ".flavor-text"
          ? flavor
          : null,
  };
  return {
    html: html as unknown as HTMLElement,
    content,
    flavor,
    tip,
    click: () => listener?.(),
  };
}

beforeEach(() => vi.stubGlobal("game", { system: { id: "knight" } }));
afterEach(() => vi.unstubAllGlobals());

describe("knightCardData", () => {
  it("marks even dice as successes and shows the app's count", () => {
    const data = knightCardData(appRoll(), localize)!;
    expect(data.tooltip.parts[0]!.results).toEqual([
      { value: 2, class: "d6 success" },
      { value: 5, class: "d6 fail" },
    ]);
    expect(data.tooltip.parts[0]!.total).toBe(1);
    expect(data.tooltip.parts[0]!.totalBonus).toBeUndefined();
    expect(data.card.flavor).toBe("Combat + Dextérité");
    expect(data.card.content[0]).toMatchObject({
      isSuccess: true,
      base: "2d6",
      total: 1,
    });
    expect(data.card.content[0]!.rollState).toBeUndefined();
  });

  it("shows a bonus beyond the even dice as Knight's added successes", () => {
    const data = knightCardData(appRoll({ rollSuccesses: 3 }), localize)!;
    expect(data.tooltip.parts[0]!.total).toBe(1);
    expect(data.tooltip.parts[0]!.totalBonus).toBe(2);
    expect(data.card.content[0]!.total).toBe(3);
  });

  it("names an exploit and a critical failure with the system's labels", () => {
    expect(
      knightCardData(appRoll({ rollTier: "critSuccess" }), localize)!.card
        .content[0]!.rollState,
    ).toEqual({ label: "[KNIGHT.JETS.Exploit]", class: "explode" });
    expect(
      knightCardData(appRoll({ rollTier: "critFailure" }, [1, 3]), localize)!
        .card.content[0]!.rollState,
    ).toEqual({ label: "[KNIGHT.JETS.EchecCritique]", class: "epicFail" });
  });

  it("keeps an inactive die out of the count", () => {
    const message = appRoll();
    message.rolls![0]!.dice![0]!.results!.push({ result: 4, active: false });
    const data = knightCardData(message, localize)!;
    expect(data.tooltip.parts[0]!.results[2]).toEqual({
      value: 4,
      class: "d6 discarded",
    });
    expect(data.tooltip.parts[0]!.total).toBe(1);
  });

  it("ignores a message that is not an app success-pool roll", () => {
    const none = appRoll();
    delete (none.flags!["table-companion"] as Record<string, unknown>)
      .rollSuccesses;
    expect(knightCardData(none, localize)).toBeNull();
    expect(knightCardData(appRoll({ rollSuccesses: -1 }), localize)).toBeNull();
    expect(
      knightCardData(appRoll({ rollSuccesses: "1" }), localize),
    ).toBeNull();
    expect(knightCardData({ flavor: "x" }, localize)).toBeNull();
    expect(
      knightCardData({ ...appRoll(), rolls: [{ formula: "2d6" }] }, localize),
    ).toBeNull();
  });
});

describe("renderKnightRollCard", () => {
  it("swaps the generic card for the system's templates and drops the duplicate label", async () => {
    const dom = fakeHtml();
    const render = vi.fn(async (path: string, data: object) =>
      path.endsWith("tooltip.html") ? "<tip>" : `card:${JSON.stringify(data)}`,
    );
    expect(
      await renderKnightRollCard(appRoll(), dom.html, render, localize),
    ).toBe(true);
    expect(render.mock.calls.map(([path]) => path)).toEqual([
      "systems/knight/templates/dices/tooltip.html",
      "systems/knight/templates/dices/roll.html",
    ]);
    expect(dom.content.innerHTML).toContain('"tooltip":"<tip>"');
    expect(dom.flavor.remove).toHaveBeenCalled();
    dom.click();
    expect(dom.tip.style.display).toBe("block");
    dom.click();
    expect(dom.tip.style.display).toBe("");
  });

  it("keeps Foundry's card when the templates cannot render", async () => {
    const dom = fakeHtml();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const render = vi.fn(async () => {
      throw new Error("template not found");
    });
    expect(
      await renderKnightRollCard(appRoll(), dom.html, render, localize),
    ).toBe(false);
    expect(dom.content.innerHTML).toContain("generic");
    expect(dom.flavor.remove).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves other systems, hidden blind rolls and foreign messages alone", async () => {
    const render = vi.fn(async () => "card");
    vi.stubGlobal("game", { system: { id: "dnd5e" } });
    expect(
      await renderKnightRollCard(appRoll(), fakeHtml().html, render, localize),
    ).toBe(false);
    vi.stubGlobal("game", { system: { id: "knight" } });
    expect(
      await renderKnightRollCard(
        { ...appRoll(), isContentVisible: false },
        fakeHtml().html,
        render,
        localize,
      ),
    ).toBe(false);
    expect(
      await renderKnightRollCard(
        { flavor: "x" },
        fakeHtml().html,
        render,
        localize,
      ),
    ).toBe(false);
    expect(
      await renderKnightRollCard(
        appRoll(),
        fakeHtml(false).html,
        render,
        localize,
      ),
    ).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });
});

describe("startKnightRollCards", () => {
  it("hooks the chat on a Knight world only", () => {
    const on = vi.fn();
    vi.stubGlobal("Hooks", { on });
    startKnightRollCards();
    expect(on).toHaveBeenCalledWith(
      "renderChatMessageHTML",
      expect.any(Function),
    );

    on.mockClear();
    vi.stubGlobal("game", { system: { id: "pf2e" } });
    startKnightRollCards();
    expect(on).not.toHaveBeenCalled();
  });

  it("renders through Foundry's template function from the hook", async () => {
    const on = vi.fn();
    const renderTemplate = vi.fn(async () => "card");
    vi.stubGlobal("Hooks", { on });
    vi.stubGlobal("foundry", {
      applications: { handlebars: { renderTemplate } },
    });
    vi.stubGlobal("game", {
      system: { id: "knight" },
      i18n: { localize: (k: string) => k },
    });
    startKnightRollCards();
    const hook = on.mock.calls[0]![1] as (m: unknown, h: unknown) => void;
    const dom = fakeHtml();
    hook(appRoll(), dom.html);
    await vi.waitFor(() => expect(dom.content.innerHTML).toBe("card"));
  });
});
