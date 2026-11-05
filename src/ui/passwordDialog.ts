import qrcode from "qrcode-generator";
import { dialogV2Class, type DialogInstance } from "../foundry/runtime.js";
import { escapeHtml } from "../util/html.js";
import { localize, log } from "../util/log.js";
import { currentCompanionName } from "./statusPanel.js";

/** A DialogV2, through the runtime gateway (resolved lazily, so the bundle
 * imports cleanly before the `foundry` global exists). Throws when the
 * Application framework is missing; every caller catches and logs. */
export function newDialog(options: unknown): DialogInstance {
  const DialogV2 = dialogV2Class();
  if (!DialogV2) throw new Error("Foundry's DialogV2 is unavailable");
  return new DialogV2(options);
}

// Single live password reveal. Creating a fresh one each time (Create, then Reset
// password) would stack overlapping modals each showing a different one-time
// secret; we close the prior before opening a new one.
let passwordDialog: DialogInstance | undefined;

/** Show the generated password once. Copy is an in-content button so a failed
 * copy never dismisses the dialog — the password stays visible to copy by hand
 * (it is shown only once). */
export async function showPassword(
  password: string,
  reset = false,
): Promise<void> {
  const name = currentCompanionName();
  const content =
    `<section class="tca-password">` +
    `<p>${escapeHtml(
      localize(reset ? "setup.password.introReset" : "setup.password.intro", {
        name,
      }),
    )}</p>` +
    `<div class="tca-password-box"><code tabindex="0">${escapeHtml(password)}</code></div>` +
    `<button type="button" data-tca="copy" class="tca-copy">` +
    `<i class="fa-solid fa-copy" aria-hidden="true"></i> ${escapeHtml(localize("setup.password.copy"))}</button>` +
    `<p class="tca-hint tca-scan">${escapeHtml(localize("setup.password.scanHint"))}</p>` +
    `<div class="tca-qr" data-tca="qr"></div>` +
    `<p class="tca-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ` +
    `${escapeHtml(localize("setup.password.warning", { name }))}</p>` +
    `<p class="tca-hint">${escapeHtml(localize("setup.password.recover"))}</p>` +
    `</section>`;

  // Close any prior password reveal so two one-time secrets never overlap on screen.
  if (passwordDialog?.rendered) {
    try {
      await passwordDialog.close();
    } catch {
      // Non-fatal: a failed close just means the old dialog lingers.
    }
  }

  const dialog = newDialog({
    window: {
      title: localize("setup.password.title"),
      icon: "fa-solid fa-key",
    },
    content,
    buttons: [
      { action: "done", label: localize("common.done"), default: true },
    ],
  });
  passwordDialog = dialog;
  await dialog.render({ force: true });
  dialog.element
    .querySelector('[data-tca="copy"]')
    ?.addEventListener(
      "click",
      () => void copyPassword(password, dialog.element),
    );
  renderPairingQr(name, password, dialog.element);
  selectPasswordCode(dialog.element);
}

/** Render a pairing QR the Table Companion app can scan, encoding a deep link the
 * app registers. Best-effort: if generation fails the QR block is removed and the
 * password text + Copy button remain the way to pair. (Until the app registers
 * the `tablecompanion://` scheme, a scan still yields the password verbatim.) */
/** The Foundry server origin the GM's browser is on (e.g. "https://foundry.example.com",
 * including any non-default port), as a ready-to-append `&h=` query param — or "" if
 * unavailable. This is the same server URL the app/agent must connect to, so carrying it
 * in the pairing QR lets a single scan fully connect instead of asking the GM to retype
 * the host. Best-effort: a missing/odd `window.location` just omits the param. */
function pairingHostParam(): string {
  try {
    const origin = window.location?.origin;
    if (!origin || origin === "null") return "";
    // A loopback origin (the GM browsing Foundry on the same machine) is useless to a
    // phone scanning the QR — it would point the app at its own device. Omit it so the
    // app prompts for the reachable host instead of silently failing to connect.
    if (isLoopbackOrigin(origin)) return "";
    return `&h=${encodeURIComponent(origin)}`;
  } catch {
    return "";
  }
}

/** True for localhost / 127.0.0.0-8 / ::1 style origins that only resolve on the GM's own box. */
function isLoopbackOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL keeps IPv6 hosts bracketed, e.g. "[::1]".
  const bare = host.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    bare === "::1" ||
    /^127\./.test(bare)
  );
}

function renderPairingQr(
  userName: string,
  password: string,
  root: HTMLElement,
): void {
  const host = root.querySelector('[data-tca="qr"]');
  if (!host) return;
  try {
    const link =
      `tablecompanion://pair?u=${encodeURIComponent(userName)}` +
      `&p=${encodeURIComponent(password)}` +
      pairingHostParam();
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    host.innerHTML = qr.createImgTag(4, 8);
    host
      .querySelector("img")
      ?.setAttribute("alt", localize("setup.password.scanHint"));
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
async function copyPassword(
  password: string,
  root: HTMLElement,
): Promise<void> {
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
