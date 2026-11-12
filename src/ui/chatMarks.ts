import { foundryHooks } from "../foundry/runtime.js";
import { escapeHtml } from "../util/html.js";
import { localize } from "../util/log.js";

/**
 * A chat card the companion apps cancelled stays in the chat, greyed under a
 * banner: « Cancelled » (an undo), « Rerolled » (replaced by a reroll) or
 * « Removed by the GM ». The backend marks the card with the
 * `receiptState` flag only; its content, rolls and speaker are never edited, so
 * this is display only. Foundry renders a message again on every update, so a
 * flag set later is drawn by that re-render.
 */

const STATES = new Set(["annulled", "rerolled", "revokedByGM"]);

export interface MarkedMessageLike {
  flags?: Record<string, unknown>;
}

/** Grey one rendered card under its banner; true when the message is marked. */
export function renderChatMark(
  message: MarkedMessageLike,
  html: HTMLElement,
): boolean {
  const flags = message.flags?.["table-companion"] as
    Record<string, unknown> | undefined;
  const state = flags?.receiptState;
  if (typeof state !== "string" || !STATES.has(state)) return false;
  const content = html.querySelector(".message-content");
  if (!content) return false;
  for (const old of html.querySelectorAll(".tca-mark")) old.remove();
  html.classList.add("tca-marked");
  content.insertAdjacentHTML(
    "beforebegin",
    `<div class="tca-mark">${escapeHtml(localize(`chatMark.${state}`))}</div>`,
  );
  return true;
}

/** Hook the chat on every client and system. */
export function startChatMarks(): void {
  foundryHooks()?.on(
    "renderChatMessageHTML",
    (message: MarkedMessageLike, html: HTMLElement) =>
      void renderChatMark(message, html),
  );
}
