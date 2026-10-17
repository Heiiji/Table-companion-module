import qrcode from "qrcode-generator";
import type { Channel } from "../rpc/channel.js";
import {
  CAP_RESPONSE_SIG,
  CLOCK_SKEW_WARN_MS,
  LINK_STALE_MS,
} from "../constants.js";
import {
  COMPANION_USER_NAME,
  ensureCompanionUser,
  findCompanionUser,
  resetCompanionPassword,
} from "../setup/companion-user.js";
import { APP_PRESENCE_STALE_MS, appPresence } from "../setup/appPresence.js";
import { dialogV2Class, gameActors } from "../foundry/runtime.js";
import { escapeHtml } from "../util/html.js";
import { localize, log } from "../util/log.js";

// Minimal structural shape of the DialogV2 instance bits we touch: the stable,
// documented surface (the instance API + a content string), robust across
// Foundry 13/14 point releases.
interface DialogInstance {
  element: HTMLElement;
  rendered: boolean;
  render(options: { force: boolean }): Promise<unknown>;
  bringToFront?: () => void;
  close(): Promise<unknown>;
}

/** A DialogV2, through the runtime gateway (resolved lazily, so the bundle
 * imports cleanly before the `foundry` global exists). Throws when the
 * Application framework is missing; every caller catches and logs. */
function newDialog(options: unknown): DialogInstance {
  const DialogV2 = dialogV2Class();
  if (!DialogV2) throw new Error("Foundry's DialogV2 is unavailable");
  return new DialogV2(options) as DialogInstance;
}

// Single live setup dialog. Re-opening the sidebar button refreshes this one
// instead of stacking a new modal each time.
let setupDialog: DialogInstance | undefined;

// Single live password reveal. Creating a fresh one each time (Create, then Reset
// password) would stack overlapping modals each showing a different one-time
// secret; we close the prior before opening a new one.
let passwordDialog: DialogInstance | undefined;

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

  const pairingValue = !pairing.paired
    ? localize("setup.status.notPaired")
    : pairing.agentUserName
      ? localize("setup.status.pairedAs", {
          fingerprint: pairing.fingerprint,
          name: pairing.agentUserName,
        })
      : `${localize("setup.status.paired")} · ${pairing.fingerprint}`;

  // A pairing request from a user other than the one this module created waits
  // here for the GM. The buttons live inside the status panel, which is repainted
  // every few seconds, so their clicks are handled by delegation (wirePendingActions).
  const pending = pairing.pending
    ? `<div class="tca-pending" role="alert">` +
      row(
        localize("setup.status.pendingPairing"),
        localize("setup.status.pendingValue", {
          name: pairing.pending.userName,
          fingerprint: pairing.pending.fingerprint,
        }),
        false,
      ) +
      `<p class="tca-hint">${escapeHtml(
        localize("setup.pendingHint", { name: pairing.pending.userName }),
      )}</p>` +
      `<div class="tca-actions">` +
      `<button type="button" data-tca-pending="trust">` +
      `<i class="fa-solid fa-check" aria-hidden="true"></i> ${escapeHtml(localize("setup.button.trust"))}</button>` +
      `<button type="button" data-tca-pending="ignore">` +
      `<i class="fa-solid fa-xmark" aria-hidden="true"></i> ${escapeHtml(localize("setup.button.ignore"))}</button>` +
      `</div></div>`
    : "";

  const { signingRows, signingHints } = replySigningHtml(channel, status, row);

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
    signingRows +
    `</div>` +
    signingHints +
    pending +
    (linkLive
      ? `<p class="tca-hint tca-linked">` +
        `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> ` +
        `${escapeHtml(localize("setup.status.linkedHint"))}</p>`
      : "") +
    appPlayersHtml(row)
  );
}

/** « Players in the app »: one row per seat the backend last reported, named
 * after the seat's Foundry Actor, else the app's label, else its position.
 * Hidden until a snapshot arrives (a backend that does not report presence);
 * past APP_PRESENCE_STALE_MS the states give way to one « unknown » hint. */
function appPlayersHtml(
  row: (label: string, value: string, ok: boolean) => string,
): string {
  const snapshot = appPresence.get();
  if (!snapshot?.seats.length) return "";
  const stale = Date.now() - snapshot.receivedAt > APP_PRESENCE_STALE_MS;
  // Ordered by member id, not by arrival order, so the same seats always render
  // the same HTML (the repaint guard) and keep their « Seat n » number.
  const rows = [...snapshot.seats]
    .sort((a, b) =>
      a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
    )
    .map((seat, i) => {
      const name =
        (seat.actorId && gameActors()?.get(seat.actorId)?.name) ||
        seat.label ||
        localize("setup.players.seat", { n: String(i + 1) });
      return stale
        ? `<div class="tca-status-row"><span>${escapeHtml(name)}</span></div>`
        : row(
            name,
            localize(`setup.players.${seat.state}`),
            seat.state === "inSession",
          );
    })
    .join("");
  return (
    `<h4>${escapeHtml(localize("setup.players.title"))}</h4>` +
    `<div class="tca-status">${rows}</div>` +
    (stale
      ? `<p class="tca-hint">${escapeHtml(localize("setup.players.unknown"))}</p>`
      : "")
  );
}

/** The responder's « Reply signing » and « Clock offset » rows. The handshake
 * still flows when the backend drops every reply this browser signs, so « Live »
 * alone hid a total outage: the backend's verdict comes first, then whether this
 * browser can sign at all, each with what to do. */
function replySigningHtml(
  channel: Channel,
  status: ReturnType<Channel["getStatus"]>,
  row: (label: string, value: string, ok: boolean) => string,
): { signingRows: string; signingHints: string } {
  if (!status.isResponder) return { signingRows: "", signingHints: "" };
  const signs = channel.advertisedCapabilities().includes(CAP_RESPONSE_SIG);
  const [value, hint] =
    status.pairingIssue === "response_key_mismatch"
      ? ["setup.status.signingKeyMismatch", "setup.hint.keyMismatch"]
      : status.pairingIssue === "world_mismatch"
        ? ["setup.status.signingWorldMismatch", "setup.hint.worldMismatch"]
        : !signs
          ? ["setup.status.signingUnavailable", "setup.hint.noSigner"]
          : ["setup.status.signingActive", ""];
  let signingRows = row(
    localize("setup.status.replySigning"),
    localize(value),
    hint === "",
  );
  const hints = hint ? [localize(hint)] : [];
  const skew = status.lastSkewMs;
  if (skew !== null && Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
    signingRows += row(
      localize("setup.status.clockOffset"),
      localize("setup.status.clockOffsetValue", {
        seconds: String(Math.round(Math.abs(skew) / 1000)),
      }),
      false,
    );
    hints.push(localize("setup.hint.clockOffset"));
  }
  return {
    signingRows,
    signingHints: hints
      .map((h) => `<p class="tca-hint">${escapeHtml(h)}</p>`)
      .join(""),
  };
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
  const hooks = Hooks as unknown as {
    on(hook: string, fn: () => void): number;
    off(hook: string, id: number): void;
  };
  const refresh = () => void refreshStatus(channel, dialog);
  const ids: Array<[string, number]> = [
    // Fires on a join and on a leave (connected: boolean).
    ["userConnected", hooks.on("userConnected", refresh)],
  ];
  const timer = setInterval(() => {
    if (dialog.rendered) {
      refresh();
      return;
    }
    clearInterval(timer);
    for (const [hook, id] of ids) hooks.off(hook, id);
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
  wirePendingActions(channel, dialog);
}

/** Trust / Ignore for a held pairing request. The buttons are re-rendered with
 * the status panel, so one delegated listener on the panel's host handles them. */
function wirePendingActions(channel: Channel, dialog: DialogInstance): void {
  dialog.element
    .querySelector(".tca-status-host")
    ?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
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
  renderPairingQr(password, dialog.element);
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

function renderPairingQr(password: string, root: HTMLElement): void {
  const host = root.querySelector('[data-tca="qr"]');
  if (!host) return;
  try {
    const link =
      `tablecompanion://pair?u=${encodeURIComponent(COMPANION_USER_NAME)}` +
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
