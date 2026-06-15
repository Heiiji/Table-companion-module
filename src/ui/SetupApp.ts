import type { Channel } from "../rpc/channel.js";
import { LINK_STALE_MS } from "../constants.js";
import {
  COMPANION_USER_NAME,
  ensureCompanionUser,
  findCompanionUser,
} from "../setup/companion-user.js";
import { localize, log } from "../util/log.js";

// The ApplicationV2/DialogV2 generics in fvtt-types are intentionally loose to
// keep this UI robust across Foundry 13/14 point releases; we touch only the
// stable, documented surface (DialogV2.wait + buttons + a content string).
const DialogV2 = (foundry as any).applications.api.DialogV2;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

function statusHtml(channel: Channel): string {
  const status = channel.getStatus();
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
    `</div>`
  );
}

/** Open the GM-only setup & status dialog. */
export async function openSetupApp(channel: Channel): Promise<void> {
  if (!game.user?.isGM) {
    ui.notifications?.warn(localize("setup.error.gmOnly"));
    return;
  }

  const content =
    `<section class="tca-setup">` +
    `<p>${localize("setup.intro")}</p>` +
    statusHtml(channel) +
    `<p class="tca-hint">${localize("setup.ownershipHint")}</p>` +
    `</section>`;

  await DialogV2.wait({
    window: { title: localize("setup.title"), icon: "fa-solid fa-dice-d20" },
    content,
    buttons: [
      {
        action: "create",
        label: localize("setup.button.create"),
        icon: "fa-solid fa-user-plus",
        callback: async () => {
          await runCreate();
          // Re-open so the status panel reflects the new user.
          await openSetupApp(channel);
        },
      },
      {
        action: "refresh",
        label: localize("common.refresh"),
        icon: "fa-solid fa-rotate",
        // The dialog renders a one-time snapshot; re-open for a fresh read of
        // the live link status.
        callback: async () => {
          await openSetupApp(channel);
        },
      },
      {
        action: "close",
        label: localize("common.close"),
        default: true,
      },
    ],
  });
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

/** Show the generated password once, with a copy button and the hard warning. */
async function showPassword(password: string): Promise<void> {
  const content =
    `<section class="tca-password">` +
    `<p>${localize("setup.password.intro", { name: COMPANION_USER_NAME })}</p>` +
    `<div class="tca-password-box"><code>${escapeHtml(password)}</code></div>` +
    `<p class="tca-warn"><i class="fa-solid fa-triangle-exclamation"></i> ` +
    `${localize("setup.password.warning", { name: COMPANION_USER_NAME })}</p>` +
    `<p class="tca-hint">${localize("setup.password.recover", { name: COMPANION_USER_NAME })}</p>` +
    `</section>`;

  await DialogV2.wait({
    window: {
      title: localize("setup.password.title"),
      icon: "fa-solid fa-key",
    },
    content,
    buttons: [
      {
        action: "copy",
        label: localize("setup.password.copy"),
        icon: "fa-solid fa-copy",
        callback: async () => {
          // navigator.clipboard is undefined on insecure (HTTP) contexts; only
          // claim success when the write actually resolved, otherwise tell the
          // GM to select-and-copy the password manually (it is shown once).
          try {
            if (!navigator.clipboard) throw new Error("no clipboard");
            await navigator.clipboard.writeText(password);
            ui.notifications?.info(localize("setup.password.copied"));
          } catch {
            ui.notifications?.warn(localize("setup.password.copyManual"));
          }
        },
      },
      { action: "done", label: localize("common.done"), default: true },
    ],
  });
}
