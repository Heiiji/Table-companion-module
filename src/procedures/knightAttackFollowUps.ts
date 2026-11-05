import { MODULE_ID } from "../constants.js";
import { foundryHooks } from "../foundry/runtime.js";
import { isResponder } from "../setup/election.js";
import { log } from "../util/log.js";
import {
  type RollLike,
  facesOf,
  type CardMessage,
  knightFlags,
  laneFlags,
  messages,
  ATTACK_LANE,
  supportsKnightAttackV1Runtime,
  PROCEDURE,
} from "./knightAttack.js";

// ------------------------------------------------------------ follow-ups

function rollKey(rolls: unknown[]): string {
  return rolls
    .map((roll) => {
      const r = (
        typeof roll === "string" ? (JSON.parse(roll) as unknown) : roll
      ) as RollLike | null;
      return `${r?.formula ?? ""}:${r?.total ?? ""}:${facesOf(r).join(",")}`;
    })
    .join("|");
}

const DICE_TOTAL = /class="[^"]*\bdice-total\b[^"]*"[^>]*>\s*(-?\d+(?:\.\d+)?)/;

/** Stamp a damage / violence card rolled from a lane attack card with that
 * attack's `eventId`; true when it did. Responder GM only. */
export async function stampFollowUp(message: CardMessage): Promise<boolean> {
  if (!isResponder()) return false;
  const knight = knightFlags(message);
  const attaque = knight?.attaque;
  if (!Array.isArray(attaque) || attaque.length === 0) return false;
  const own = laneFlags(message);
  if (own?.followUp || own?.eventId) return false;
  const key = rollKey(attaque);
  const card = [...messages()]
    .reverse()
    .find(
      (m) =>
        laneFlags(m)?.lane === ATTACK_LANE &&
        (m.rolls?.length ?? 0) > 0 &&
        rollKey(m.rolls!) === key,
    );
  const attackEventId = card ? laneFlags(card)?.eventId : undefined;
  if (typeof attackEventId !== "string") return false;
  const rollType = (knight?.weapon as { rollType?: unknown } | undefined)
    ?.rollType;
  const kind =
    rollType === "damage" || rollType === "violence"
      ? rollType
      : /violence/i.test(message.flavor ?? "")
        ? "violence"
        : "damage";
  const match = DICE_TOTAL.exec(message.content ?? "");
  await message.setFlag?.(MODULE_ID, "followUp", {
    attackEventId,
    kind,
    total: match ? Number(match[1]) : null,
  });
  return true;
}

/** Watch the chat for follow-ups on a Knight world the lane runs on. */
export function startKnightAttackFollowUps(): void {
  if (!supportsKnightAttackV1Runtime()) return;
  const onMessage = (message: CardMessage) => {
    void stampFollowUp(message).catch((error: unknown) =>
      log.warn(`${PROCEDURE}: follow-up stamp failed`, error),
    );
  };
  foundryHooks()?.on("createChatMessage", onMessage);
  foundryHooks()?.on("updateChatMessage", onMessage);
}
