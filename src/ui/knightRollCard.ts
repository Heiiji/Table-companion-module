import {
  foundryHooks,
  renderTemplateFn,
  systemId,
} from "../foundry/runtime.js";
import { log } from "../util/log.js";

/**
 * Knight: a roll the companion app posts to the chat (a plain Foundry roll plus
 * this module's `rollSuccesses` flag) is drawn with the Knight system's own roll
 * card — even dice as successes, « N Succès », Exploit / Échec critique — instead
 * of Foundry's generic sum card. Display only: the stored message is untouched,
 * and any failure (another system, an older Knight without the templates, a
 * hidden blind roll) leaves Foundry's own card in place.
 *
 * The damage / violence buttons are not drawn: they run the system's own damage
 * roll from its weapon flags, and the app rolls its damage itself.
 */

const CARD_TEMPLATE = "systems/knight/templates/dices/roll.html";
const TOOLTIP_TEMPLATE = "systems/knight/templates/dices/tooltip.html";

interface DieLike {
  faces?: number;
  results?: { result: number; active?: boolean }[];
}

export interface ChatMessageLike {
  flavor?: string | null;
  rolls?: { formula?: string; dice?: DieLike[] }[];
  /** False for a blind roll the viewer may not see. */
  isContentVisible?: boolean;
  flags?: Record<string, unknown>;
}

interface DieResult {
  value: number;
  class: string;
}

export interface KnightCard {
  /** Data for `tooltip.html`. */
  tooltip: {
    parts: {
      base: string;
      bonus: never[];
      total: number;
      totalBonus?: number;
      results: DieResult[];
    }[];
  };
  /** Data for `roll.html`, its `tooltip` filled once rendered. */
  card: {
    flavor: string;
    content: {
      isSuccess: true;
      base: string;
      bonus: never[];
      total: number;
      tooltip: string;
      rollState?: { label: string; class: string };
    }[];
  };
}

/** The Knight card data for an app roll, or null when the message is not one. */
export function knightCardData(
  message: ChatMessageLike,
  localize: (key: string) => string,
): KnightCard | null {
  const flags = message.flags?.["table-companion"] as
    Record<string, unknown> | undefined;
  const successes = flags?.rollSuccesses;
  if (!Number.isInteger(successes) || (successes as number) < 0) return null;
  const roll = message.rolls?.[0];
  if (!roll?.dice?.length) return null;

  let even = 0;
  const results: DieResult[] = roll.dice.flatMap((die) =>
    (die.results ?? []).map(({ result, active }) => {
      if (active === false)
        return { value: result, class: `d${die.faces} discarded` };
      const success = result % 2 === 0;
      if (success) even += 1;
      return {
        value: result,
        class: `d${die.faces} ${success ? "success" : "fail"}`,
      };
    }),
  );
  const total = successes as number;
  const formula = roll.formula ?? "";
  const tier = flags?.rollTier;
  const rollState =
    tier === "critSuccess"
      ? { label: localize("KNIGHT.JETS.Exploit"), class: "explode" }
      : tier === "critFailure"
        ? { label: localize("KNIGHT.JETS.EchecCritique"), class: "epicFail" }
        : undefined;

  return {
    tooltip: {
      parts: [
        {
          base: formula,
          bonus: [],
          total: even,
          ...(total > even ? { totalBonus: total - even } : {}),
          results,
        },
      ],
    },
    card: {
      flavor: message.flavor ?? "",
      content: [
        {
          isSuccess: true,
          base: formula,
          bonus: [],
          total,
          tooltip: "",
          ...(rollState ? { rollState } : {}),
        },
      ],
    },
  };
}

/** Redraw one rendered app roll as a Knight card; true when it did. */
export async function renderKnightRollCard(
  message: ChatMessageLike,
  html: HTMLElement,
  render: (path: string, data: object) => Promise<string>,
  localize: (key: string) => string,
): Promise<boolean> {
  if (systemId() !== "knight" || message.isContentVisible === false)
    return false;
  const data = knightCardData(message, localize);
  const target = html.querySelector(".message-content");
  if (!data || !target) return false;
  try {
    data.card.content[0]!.tooltip = await render(
      TOOLTIP_TEMPLATE,
      data.tooltip,
    );
    const content = await render(CARD_TEMPLATE, data.card);
    target.innerHTML = content;
  } catch (error) {
    log.warn("kept Foundry's roll card:", error);
    return false;
  }
  // The card carries the label itself, as the system's own rolls do.
  html.querySelector(".flavor-text")?.remove();
  for (const result of target.querySelectorAll<HTMLElement>(".dice-result")) {
    result.addEventListener("click", () => {
      const tip = result.querySelector<HTMLElement>(".dice-tooltip");
      if (tip) tip.style.display = tip.style.display === "block" ? "" : "block";
    });
  }
  return true;
}

/** Hook the chat on a Knight world; inert on every other system. */
export function startKnightRollCards(): void {
  if (systemId() !== "knight") return;
  foundryHooks()?.on(
    "renderChatMessageHTML",
    (message: ChatMessageLike, html: HTMLElement) => {
      const render = renderTemplateFn();
      if (!render) return;
      void renderKnightRollCard(message, html, render, (key) =>
        game.i18n ? game.i18n.localize(key) : key,
      );
    },
  );
}
