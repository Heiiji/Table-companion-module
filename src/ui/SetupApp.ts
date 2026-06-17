import qrcode from "qrcode-generator";
import type { Channel } from "../rpc/channel.js";
import { LINK_STALE_MS } from "../constants.js";
import {
  COMPANION_USER_NAME,
  ensureCompanionUser,
  findCompanionUser,
  resetCompanionPassword,
} from "../setup/companion-user.js";
import { escapeHtml } from "../util/html.js";
import { localize, log } from "../util/log.js";

// The ApplicationV2/DialogV2 generics in fvtt-types are intentionally loose to
// keep this UI robust across Foundry 13/14 point releases; we touch only the
// stable, documented surface (the DialogV2 instance API + a content string).
// Accessed lazily (not at module load) so the bundle imports cleanly even before
// the `foundry` global exists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DialogV2 = () => (foundry as any).applications.api.DialogV2;

// Minimal structural shape of the DialogV2 instance bits we touch — keeps us off
// `any` for everything except the constructor accessor above.
interface DialogInstance {
  element: HTMLElement;
  rendered: boolean;
  render(options: { force: boolean }): Promise<unknown>;
  bringToFront?: () => void;
  close(): Promise<unknown>;
}

// Single live setup dialog. Re-opening the sidebar button refreshes this one
// instead of stacking a new modal each time.
let setupDialog: DialogInstance | undefined;

async function statusHtml(channel: Channel): Promise<string> {
  const status = channel.getStatus();
  const pairing = await channel.getPairing();
  const companion = findCompanionUser();
  const online = companion?.active ?? false;
  const last = status.lastAgentHelloAt;
  const linkLive = last !== null && Date.now() - last < LINK_STALE_MS;

  const row = (label: string, value: string, ok: boolean) =>
    `<div class="tca-status-row"><span>${escapeHtml(label)}</span>` +
    `<b class="${ok ? "tca-ok" : "tca-off"}">${escapeHtml(value)}</b></div>`;

  const agentVer = status.agentPeer?.version
    ? ` (v${status.agentPeer.version})`
    : "";

  const pairingValue = pairing.paired
    ? `${localize("setup.status.paired")} · ${pairing.fingerprint}`
    : localize("setup.status.notPaired");

  return (
    `<div class="tca-status">` +
    row(
      localize("setup.status.userExists"),
      companion ? localize("common.yes") : localize("common.no"),
      !!companion,
    ) +
    row(
      localize("setup.status.userOnline"),
      online ? localize("common.yes") : localize("common.no"),
      online,
    ) +
    row(
      localize("setup.status.link"),
      linkLive
        ? localize("setup.status.linkLive") + agentVer
        : localize("setup.status.linkIdle"),
      linkLive,
    ) +
    row(localize("setup.status.pairing"), pairingValue, pairing.paired) +
    `</div>` +
    (linkLive
      ? `<p class="tca-hint tca-linked">` +
        `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> ` +
        `${escapeHtml(localize("setup.status.linkedHint"))}</p>`
      : "")
  );
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

/** Replace just the status panel in the open dialog, leaving wired buttons. */
async function refreshStatus(channel: Channel, dialog: DialogInstance): Promise<void> {
  const host = dialog.element?.querySelector(".tca-status-host");
  if (host) host.innerHTML = await statusHtml(channel);
}

/** Keep the open panel current: repaint on a light interval (covers the
 * time-relative "Live/Waiting" decay) and on user connect/disconnect (Companion
 * online/offline). Torn down once the dialog closes, detected via
 * `dialog.rendered` on the next tick. */
function startLiveRefresh(channel: Channel, dialog: DialogInstance): void {
  const hooks = Hooks as unknown as {
    on(hook: string, fn: () => void): number;
    off(hook: string, id: number): void;
  };
  const refresh = () => void refreshStatus(channel, dialog);
  const ids: Array<[string, number]> = [
    ["userConnected", hooks.on("userConnected", refresh)],
    ["userDisconnected", hooks.on("userDisconnected", refresh)],
  ];
  const timer = setInterval(() => {
    if (dialog.rendered) {
      refresh();
      return;
    }
    clearInterval(timer);
    for (const [hook, id] of ids) hooks.off(hook, id);
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
    try {
      const password = await resetCompanionPassword();
      await showPassword(password);
      await refreshStatus(channel, dialog);
    } catch (err) {
      log.error("reset password failed", err);
      ui.notifications?.error(localize("setup.error.resetFailed"));
    }
  });
  on("refresh", () => refreshStatus(channel, dialog));
  on("reset", async () => {
    await channel.resetPairing();
    ui.notifications?.info(localize("setup.notify.pairingReset"));
    await refreshStatus(channel, dialog);
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
    const dialog = new (DialogV2())({
      window: { title: localize("setup.title"), icon: "fa-solid fa-dice-d20" },
      content: setupContent(await statusHtml(channel)),
      buttons: [{ action: "close", label: localize("common.close"), default: true }],
    }) as DialogInstance;
    setupDialog = dialog;
    await dialog.render({ force: true });
    wireSetupActions(channel, dialog);
    startLiveRefresh(channel, dialog);
  } catch (err) {
    setupDialog = undefined;
    log.error("could not open setup dialog", err);
  }
}

async function runCreate(): Promise<void> {
  try {
    const result = await ensureCompanionUser();
    if (result.existed) {
      ui.notifications?.info(
        localize("setup.notify.exists", { name: COMPANION_USER_NAME }),
      );
      return;
    }
    await showPassword(result.password!);
  } catch (err) {
    log.error("companion setup failed", err);
    ui.notifications?.error(localize("setup.error.createFailed"));
  }
}

/** Show the generated password once. Copy is an in-content button so a failed
 * copy never dismisses the dialog — the password stays visible to copy by hand
 * (it is shown only once). */
async function showPassword(password: string): Promise<void> {
  const content =
    `<section class="tca-password">` +
    `<p>${localize("setup.password.intro", { name: COMPANION_USER_NAME })}</p>` +
    `<div class="tca-password-box"><code tabindex="0">${escapeHtml(password)}</code></div>` +
    `<button type="button" data-tca="copy" class="tca-copy">` +
    `<i class="fa-solid fa-copy" aria-hidden="true"></i> ${escapeHtml(localize("setup.password.copy"))}</button>` +
    `<p class="tca-hint tca-scan">${escapeHtml(localize("setup.password.scanHint"))}</p>` +
    `<div class="tca-qr" data-tca="qr"></div>` +
    `<p class="tca-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ` +
    `${localize("setup.password.warning", { name: COMPANION_USER_NAME })}</p>` +
    `<p class="tca-hint">${localize("setup.password.recover", { name: COMPANION_USER_NAME })}</p>` +
    `</section>`;

  const dialog = new (DialogV2())({
    window: { title: localize("setup.password.title"), icon: "fa-solid fa-key" },
    content,
    buttons: [{ action: "done", label: localize("common.done"), default: true }],
  }) as DialogInstance;
  await dialog.render({ force: true });
  dialog.element
    .querySelector('[data-tca="copy"]')
    ?.addEventListener("click", () => void copyPassword(password, dialog.element));
  renderPairingQr(password, dialog.element);
  selectPasswordCode(dialog.element);
}

/** Render a pairing QR the Table Companion app can scan, encoding a deep link the
 * app registers. Best-effort: if generation fails the QR block is removed and the
 * password text + Copy button remain the way to pair. (Until the app registers
 * the `tablecompanion://` scheme, a scan still yields the password verbatim.) */
function renderPairingQr(password: string, root: HTMLElement): void {
  const host = root.querySelector('[data-tca="qr"]');
  if (!host) return;
  try {
    const link =
      `tablecompanion://pair?u=${encodeURIComponent(COMPANION_USER_NAME)}` +
      `&p=${encodeURIComponent(password)}`;
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    host.innerHTML = qr.createImgTag(4, 8);
    host.querySelector("img")?.setAttribute("alt", localize("setup.password.scanHint"));
  } catch (err) {
    host.remove();
    log.warn("could not render the pairing QR code", err);
  }
}

/** Select the password text on open so a screen reader announces it and Ctrl-C
 * copies it without reaching for the button (it is shown only once). */
function selectPasswordCode(root: HTMLElement): void {
  const code = root.querySelector<HTMLElement>(".tca-password-box code");
  if (!code) return;
  try {
    code.focus();
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    // Non-fatal: selection is only a convenience.
  }
}

/** Copy the password, trying the async Clipboard API then a legacy selection
 * copy (which works on Firefox over plain HTTP, where the Clipboard API is
 * blocked). Falls back to a "select it yourself" notice — the dialog stays open
 * either way. */
async function copyPassword(password: string, root: HTMLElement): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(password);
      ui.notifications?.info(localize("setup.password.copied"));
      return;
    }
  } catch {
    // Fall through to the legacy path.
  }

  if (execCommandCopy(root)) {
    ui.notifications?.info(localize("setup.password.copied"));
    return;
  }

  ui.notifications?.warn(localize("setup.password.copyManual"));
}

/** Select the password `<code>` and copy via the legacy execCommand path. */
function execCommandCopy(root: HTMLElement): boolean {
  const code = root.querySelector(".tca-password-box code");
  if (!code) return false;
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand("copy");
    selection?.removeAllRanges();
    return ok;
  } catch {
    return false;
  }
}
