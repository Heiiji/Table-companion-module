import type { Channel } from "../rpc/channel.js";
import { signatureSupport } from "../rpc/signatureSupport.js";
import {
  CAP_RESPONSE_SIG,
  CLOCK_SKEW_WARN_MS,
  LINK_STALE_MS,
} from "../constants.js";
import {
  COMPANION_USER_NAME,
  findCompanionUser,
} from "../setup/companion-user.js";
import { APP_PRESENCE_STALE_MS, appPresence } from "../setup/appPresence.js";
import { companionVisibility } from "../setup/companionVisibility.js";
import { gameActors } from "../foundry/runtime.js";
import { escapeHtml } from "../util/html.js";
import { localize } from "../util/log.js";

export async function statusHtml(channel: Channel): Promise<string> {
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
      `<p class="tca-hint">${escapeHtml(localize("setup.pendingCompare"))}</p>` +
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

  // On plain http the browser has no WebCrypto, so nothing the backend sends
  // can be verified: say so above the rows that would otherwise just wait.
  const insecure =
    signatureSupport() === "ok"
      ? ""
      : `<p class="tca-hint" role="alert">${escapeHtml(
          localize("setup.hint.insecureContext"),
        )}</p>`;

  return (
    insecure +
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
    // A procedure this runtime withholds (e.g. sheet sync on an unsupported
    // system version), named with its reason so a silent lane explains itself.
    Object.entries(channel.withheldProcedures() ?? {})
      .map(([name, reason]) => row(name, reason, false))
      .join("") +
    `</div>` +
    signingHints +
    pending +
    (linkLive
      ? `<p class="tca-hint tca-linked">` +
        `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> ` +
        `${escapeHtml(localize("setup.status.linkedHint"))}</p>`
      : "") +
    companionVisibilityHtml(row) +
    appPlayersHtml(row)
  );
}

/** The display name of the Companion user, for the visibility copy. */
export function companionName(name: string | null | undefined): string {
  return name || COMPANION_USER_NAME;
}

/** The Companion user's current name: the GM may have renamed it, and the
 * app logs in under that name. */
export function currentCompanionName(): string {
  return companionName(findCompanionUser()?.name);
}

/** « Companion can see N of M »: the player characters the backend can read,
 * naming the others and offering to share them. Hidden without a Companion user
 * or without any player character. */
function companionVisibilityHtml(
  row: (label: string, value: string, ok: boolean) => string,
): string {
  const visibility = companionVisibility();
  if (!visibility?.total) return "";
  const { companion, total, unseen } = visibility;
  const name = companionName(companion.name);
  const html =
    `<div class="tca-status">` +
    row(
      localize("setup.visibility.label"),
      localize("setup.visibility.value", {
        name,
        n: String(total - unseen.length),
        m: String(total),
      }),
      unseen.length === 0,
    ) +
    `</div>`;
  if (unseen.length === 0) return html;
  const names = unseen.map((actor) => actor.name || actor.id || "").join(", ");
  return (
    html +
    `<p class="tca-hint">${escapeHtml(localize("setup.visibility.unseen", { name, names }))}</p>` +
    `<div class="tca-actions"><button type="button" data-tca-share="observer">` +
    `<i class="fa-solid fa-eye" aria-hidden="true"></i> ` +
    `${escapeHtml(localize("setup.visibility.share", { name }))}</button></div>`
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

/** The « Reply signing » and « Clock offset » rows. The handshake still flows
 * when the backend drops every reply this browser signs, so « Live » alone hid a
 * total outage: on the responder, the backend's verdict comes first, then
 * whether this browser can sign at all, each with what to do. Another Gamemaster
 * browser sees whether the backend enrolled its key (a backend that lists its
 * keys enrolls one per GM browser while this setup is open). */
function replySigningHtml(
  channel: Channel,
  status: ReturnType<Channel["getStatus"]>,
  row: (label: string, value: string, ok: boolean) => string,
): { signingRows: string; signingHints: string } {
  const enrolled = channel.replyKeyEnrolled();
  if (!status.isResponder) {
    if (enrolled === null) return { signingRows: "", signingHints: "" };
    return {
      signingRows: row(
        localize("setup.status.replySigning"),
        localize(
          enrolled
            ? "setup.status.signingStandby"
            : "setup.status.signingNotEnrolled",
        ),
        enrolled,
      ),
      signingHints: enrolled
        ? ""
        : `<p class="tca-hint">${escapeHtml(localize("setup.hint.keyNotEnrolled"))}</p>`,
    };
  }
  const signs = channel.advertisedCapabilities().includes(CAP_RESPONSE_SIG);
  const [value, hint] =
    status.pairingIssue === "response_key_mismatch"
      ? status.enrolledKeys !== null
        ? ["setup.status.signingNotEnrolled", "setup.hint.keyNotEnrolled"]
        : ["setup.status.signingKeyMismatch", "setup.hint.keyMismatch"]
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
