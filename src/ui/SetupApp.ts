import type { Channel } from "../rpc/channel.js";
import {
  ensureCompanionUser,
  findCompanionUser,
  resetCompanionPassword,
} from "../setup/companion-user.js";
import {
  companionVisibility,
  shareUnseenWithCompanion,
} from "../setup/companionVisibility.js";
import {
  dialogV2Class,
  foundryHooks,
  type DialogInstance,
} from "../foundry/runtime.js";
import { escapeHtml } from "../util/html.js";
import { localize, log } from "../util/log.js";
import {
  currentCompanionName,
  companionName,
  statusHtml,
} from "./statusPanel.js";
import { showPassword, newDialog } from "./passwordDialog.js";

// Single live setup dialog. Re-opening the sidebar button refreshes this one
// instead of stacking a new modal each time.
let setupDialog: DialogInstance | undefined;

/** Ask before a reset the app has to recover from; true only on Yes. */
async function confirmReset(
  kind: "resetPassword" | "resetPairing",
): Promise<boolean> {
  const answer = await dialogV2Class()?.confirm?.({
    window: { title: localize(`setup.confirm.${kind}Title`) },
    content: `<p>${escapeHtml(
      localize(`setup.confirm.${kind}`, { name: currentCompanionName() }),
    )}</p>`,
    yes: { label: localize(`setup.button.${kind}`), default: false },
    rejectClose: false,
    modal: true,
  });
  return answer === true;
}

/** Ask, then give the Companion user Observer on the unseen player characters. */
async function shareWithCompanion(
  channel: Channel,
  dialog: DialogInstance,
): Promise<void> {
  if (!game.user?.isGM) {
    ui.notifications?.warn(localize("setup.error.gmOnly"));
    return;
  }
  const visibility = companionVisibility();
  if (!visibility?.unseen.length) return;
  const name = companionName(visibility.companion.name);
  const confirmed = await dialogV2Class()?.confirm?.({
    window: { title: localize("setup.visibility.confirmTitle") },
    content: `<p>${escapeHtml(
      localize("setup.visibility.confirm", {
        name,
        count: String(visibility.unseen.length),
      }),
    )}</p>`,
    rejectClose: false,
    modal: true,
  });
  if (confirmed !== true) return;
  try {
    const count = await shareUnseenWithCompanion(visibility);
    ui.notifications?.info(
      localize("setup.visibility.shared", { name, count: String(count) }),
    );
  } catch (err) {
    log.error("could not share the player characters", err);
    ui.notifications?.error(localize("setup.visibility.shareFailed", { name }));
  }
  await refreshStatus(channel, dialog);
}

function setupContent(statusBlock: string): string {
  // Actions are in-content buttons (not DialogV2 action buttons) so clicking
  // them never dismisses the dialog — we update the status in place instead.
  const btn = (action: string, icon: string, label: string) =>
    `<button type="button" data-tca="${action}">` +
    `<i class="${icon}" aria-hidden="true"></i> ${escapeHtml(label)}</button>`;

  return (
    `<section class="tca-setup">` +
    `<p>${localize("setup.intro")}</p>` +
    `<div class="tca-status-host" role="status" aria-live="polite">${statusBlock}</div>` +
    `<div class="tca-actions">` +
    btn("create", "fa-solid fa-user-plus", localize("setup.button.create")) +
    btn(
      "resetPassword",
      "fa-solid fa-key",
      localize("setup.button.resetPassword"),
    ) +
    btn("refresh", "fa-solid fa-rotate", localize("common.refresh")) +
    btn(
      "reset",
      "fa-solid fa-link-slash",
      localize("setup.button.resetPairing"),
    ) +
    `</div>` +
    `<p class="tca-hint">${localize("setup.ownershipHint")}</p>` +
    `</section>`
  );
}

// The status markup last written into each panel host. A repaint replaces the
// `aria-live` region and drops keyboard focus (Trust / Ignore), so the panel is
// rewritten only when its markup changed.
const renderedStatus = new WeakMap<Element, string>();

/** Replace just the status panel in the open dialog, leaving wired buttons. */
async function refreshStatus(
  channel: Channel,
  dialog: DialogInstance,
): Promise<void> {
  const host = dialog.element?.querySelector(".tca-status-host");
  if (!host) return;
  const html = await statusHtml(channel);
  if (renderedStatus.get(host) === html) return;
  renderedStatus.set(host, html);
  host.innerHTML = html;
}

/** Keep the open panel current: repaint on a light interval (covers the
 * time-relative "Live/Waiting" decay) and on user connect/disconnect (Companion
 * online/offline). Torn down once the dialog closes, detected via
 * `dialog.rendered` on the next tick. */
function startLiveRefresh(channel: Channel, dialog: DialogInstance): void {
  const hooks = foundryHooks();
  const refresh = () => void refreshStatus(channel, dialog);
  const ids: Array<[string, number | undefined]> = [
    // Fires on a join and on a leave (connected: boolean).
    ["userConnected", hooks?.on("userConnected", refresh)],
  ];
  const timer = setInterval(() => {
    if (dialog.rendered) {
      refresh();
      return;
    }
    clearInterval(timer);
    for (const [hook, id] of ids) hooks?.off?.(hook, id);
    // The pairing window is only open while this dialog is on screen — and a
    // dialog closed and reopened within one interval must not close the new
    // dialog's window.
    if (setupDialog === dialog) channel.closePairingWindow();
  }, 4000);
}

function wireSetupActions(channel: Channel, dialog: DialogInstance): void {
  const on = (action: string, handler: () => Promise<void>) => {
    dialog.element
      .querySelector(`[data-tca="${action}"]`)
      ?.addEventListener("click", () => void handler());
  };

  on("create", async () => {
    await runCreate();
    await refreshStatus(channel, dialog);
  });
  on("resetPassword", async () => {
    // Friendly pre-check so the destructive-sounding error never appears for the
    // common "no user yet" case.
    if (!findCompanionUser()) {
      ui.notifications?.warn(localize("setup.notify.noUser"));
      return;
    }
    if (!(await confirmReset("resetPassword"))) return;
    try {
      const password = await resetCompanionPassword();
      await showPassword(password, true);
      await refreshStatus(channel, dialog);
    } catch (err) {
      log.error("reset password failed", err);
      ui.notifications?.error(localize("setup.error.resetFailed"));
    }
  });
  on("refresh", () => refreshStatus(channel, dialog));
  on("reset", async () => {
    if (!(await confirmReset("resetPairing"))) return;
    await channel.resetPairing();
    ui.notifications?.info(localize("setup.notify.pairingReset"));
    await refreshStatus(channel, dialog);
  });
  wirePendingActions(channel, dialog);
}

/** Trust / Ignore for a held pairing request, and the visibility Share. The
 * buttons are re-rendered with the status panel, so one delegated listener on
 * the panel's host handles them. */
function wirePendingActions(channel: Channel, dialog: DialogInstance): void {
  dialog.element
    .querySelector(".tca-status-host")
    ?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-tca-share]")) {
        void shareWithCompanion(channel, dialog);
        return;
      }
      const action = target
        ?.closest("[data-tca-pending]")
        ?.getAttribute("data-tca-pending");
      if (!action) return;
      void (async () => {
        if (action === "trust") await channel.trustPendingPairing();
        else channel.ignorePendingPairing();
        await refreshStatus(channel, dialog);
      })();
    });
}

/** Open (or focus) the GM-only setup & status dialog. */
export async function openSetupApp(channel: Channel): Promise<void> {
  if (!game.user?.isGM) {
    ui.notifications?.warn(localize("setup.error.gmOnly"));
    return;
  }

  // Already open: refresh it and bring it forward rather than stacking another.
  if (setupDialog?.rendered) {
    await refreshStatus(channel, setupDialog);
    setupDialog.bringToFront?.();
    return;
  }

  try {
    const status = await statusHtml(channel);
    const dialog = newDialog({
      window: { title: localize("setup.title"), icon: "fa-solid fa-dice-d20" },
      content: setupContent(status),
      buttons: [
        { action: "close", label: localize("common.close"), default: true },
      ],
    });
    setupDialog = dialog;
    await dialog.render({ force: true });
    const host = dialog.element?.querySelector(".tca-status-host");
    if (host) renderedStatus.set(host, status);
    // The setup dialog is the explicit pairing window: while it is open, a first
    // agent contact may pair (automatically for the service user this module
    // created, otherwise after Trust). Closed again in startLiveRefresh.
    channel.openPairingWindow();
    wireSetupActions(channel, dialog);
    startLiveRefresh(channel, dialog);
  } catch (err) {
    setupDialog = undefined;
    log.error("could not open setup dialog", err);
  }
}

let setupOffered = false;

/** Once per session, offer a Gamemaster the setup while this world is not
 * linked yet (no Companion user, or no backend paired). A non-modal prompt the
 * GM can dismiss; never shown to a player. */
export async function offerSetupIfNeeded(channel: Channel): Promise<void> {
  if (setupOffered || !game.user?.isGM) return;
  setupOffered = true;
  try {
    if (findCompanionUser() && (await channel.getPairing()).paired) return;
    const open = await dialogV2Class()?.confirm?.({
      window: { title: localize("setup.firstRun.title") },
      content: `<p>${escapeHtml(localize("setup.firstRun.body"))}</p>`,
      yes: { label: localize("setup.firstRun.open"), default: true },
      no: { label: localize("setup.firstRun.later") },
      rejectClose: false,
      modal: false,
    });
    if (open === true) await openSetupApp(channel);
  } catch (err) {
    log.warn("could not offer the setup", err);
  }
}

async function runCreate(): Promise<void> {
  try {
    const result = await ensureCompanionUser();
    if (result.existed) {
      ui.notifications?.info(
        localize("setup.notify.exists", { name: currentCompanionName() }),
      );
      return;
    }
    await showPassword(result.password!);
  } catch (err) {
    log.error("companion setup failed", err);
    ui.notifications?.error(localize("setup.error.createFailed"));
  }
}
