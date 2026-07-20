import { CHANNEL } from "../constants.js";
import type { Procedure } from "../rpc/registry.js";
import { closeProjector, openProjector } from "../ui/projector.js";
import { escapeHtml } from "../util/html.js";
import { localize } from "../util/log.js";

/**
 * Shared-screen / projector display (PNJ-refactor locked decision #3, "Pousser sur
 * l'écran partagé"). Two additive procedures the agent relays over the signed RPC
 * channel:
 *
 *   display.show({ name, img?, fields:[{label,value}], theme:"projector" }) -> { ok }
 *   display.clear() -> { ok }
 *
 * The payload is GM-authored and ALREADY redacted — it carries only revealed
 * content (visibility/reveal live in the apps + mesh). The module does NO redaction
 * and NO Actor/document lookup, so nothing un-revealed can leak; it only renders
 * the supplied fields. It IS the sole HTML escaper (projectorContentHtml), so even
 * a raw/un-escaped caller cannot inject markup. Standalone tables never reach here.
 *
 * Fan-out: display.show runs on the elected responder only (the channel gates
 * rpc.request by isResponder). To reach every player's browser, the responder
 * renders locally AND broadcasts on the shared socket; peers render via the
 * listener (startDisplayListener). `game.socket.emit` does not echo to the sender,
 * so each client renders exactly once.
 */

// Bounds mirror the agent's ValidateDisplayShow — defense in depth: the agent is
// the only authenticated caller, but re-validating rejects a malformed push at the
// edge so it never reaches the popout.
const MAX_NAME = 200;
const MAX_FIELDS = 50;
const MAX_LABEL = 100;
const MAX_VALUE = 2000;
const MAX_IMG = 1000;

export interface DisplayField {
  label: string;
  value: string;
}
export interface DisplayView {
  name: string;
  img?: string;
  fields: DisplayField[];
  theme: "projector";
}

/** Validate & normalize a display.show payload into a safe view model. Throws on
 * malformed input (→ rpc.error). Carries ONLY the supplied, GM-authored content —
 * there is no document lookup, so nothing un-revealed can leak. */
export function normalizeDisplayPayload(payload: unknown): DisplayView {
  const p = (payload ?? {}) as Record<string, unknown>;

  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) throw new Error("display.show requires a non-empty 'name'");
  if (name.length > MAX_NAME) throw new Error("display.show name is too long");

  const rawFields = Array.isArray(p.fields) ? p.fields : [];
  if (rawFields.length > MAX_FIELDS) {
    throw new Error("display.show has too many fields");
  }
  const fields: DisplayField[] = [];
  for (const f of rawFields) {
    const fr = (f ?? {}) as Record<string, unknown>;
    const label = typeof fr.label === "string" ? fr.label.trim() : "";
    const value = typeof fr.value === "string" ? fr.value : "";
    if (!label) throw new Error("display.show field needs a non-empty 'label'");
    if (label.length > MAX_LABEL)
      throw new Error("display.show field label is too long");
    if (value.length > MAX_VALUE)
      throw new Error("display.show field value is too long");
    fields.push({ label, value });
  }

  const imgRaw = typeof p.img === "string" ? p.img.trim() : "";

  // The wire may carry any theme; this build only knows the high-contrast
  // projector style, so it is the single rendered theme. img is omitted (not set
  // to undefined) when absent, keeping the view to exactly its modeled keys.
  const out: DisplayView = { name, fields, theme: "projector" };
  if (imgRaw && imgRaw.length <= MAX_IMG) out.img = imgRaw;
  return out;
}

/** Discriminator tag marking a player-facing projector broadcast on the shared
 * `module.table-companion` socket. Distinct from the agent's signed-envelope shape
 * ({ sig, body }), so the channel listener and the display listener never misread
 * each other's traffic. */
const DISPLAY_TAG = "tcaDisplay";

export type DisplayBroadcast =
  | { tcaDisplay: "show"; view: DisplayView }
  | { tcaDisplay: "clear" };

export function buildShowBroadcast(view: DisplayView): DisplayBroadcast {
  return { [DISPLAY_TAG]: "show", view };
}
export function buildClearBroadcast(): DisplayBroadcast {
  return { [DISPLAY_TAG]: "clear" };
}

/** Parse a raw socket payload as a projector broadcast, or null if it is anything
 * else (an agent envelope, another module's traffic, noise). Re-normalizes the
 * embedded view, so a forged or oversized broadcast can't drive the popout. */
export function parseDisplayBroadcast(
  raw: unknown,
): { kind: "show"; view: DisplayView } | { kind: "clear" } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tag = (raw as Record<string, unknown>)[DISPLAY_TAG];
  if (tag === "clear") return { kind: "clear" };
  if (tag === "show") {
    try {
      return {
        kind: "show",
        view: normalizeDisplayPayload((raw as { view?: unknown }).view),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Build the projector board HTML from a view. PURE and the sole escaper: every
 * GM-authored string is escapeHtml'd, so even a raw caller cannot inject markup.
 * Renders only the supplied fields (no document lookup → no leakage). The status is
 * a TEXT label ("En jeu"), never color-only, so a color-blind player across the
 * room can read it (spec §8.7). */
export function projectorContentHtml(view: DisplayView): string {
  const portrait = view.img
    ? `<img class="tca-projector-portrait" src="${escapeHtml(view.img)}" alt="${escapeHtml(view.name)}" />`
    : "";
  const status = `<div class="tca-projector-status">${escapeHtml(localize("display.status"))}</div>`;
  const rows = view.fields
    .map(
      (f) =>
        `<li><span class="tca-field-label">${escapeHtml(f.label)}</span>` +
        `<span class="tca-field-value">${escapeHtml(f.value)}</span></li>`,
    )
    .join("");
  const fieldList = rows ? `<ul class="tca-projector-fields">${rows}</ul>` : "";
  return (
    `<section class="tca-projector-board">` +
    portrait +
    `<h1 class="tca-projector-name">${escapeHtml(view.name)}</h1>` +
    status +
    fieldList +
    `</section>`
  );
}

/** game.socket, narrowed to the two methods we use. */
interface SocketLike {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, fn: (raw: unknown) => void): void;
}
function socket(): SocketLike | undefined {
  return (game as unknown as { socket?: SocketLike }).socket;
}

/** Render the projector locally on THIS client (no broadcast). Used by the
 * responder via present() and by every other client via the socket listener. */
async function renderLocal(view: DisplayView): Promise<void> {
  await openProjector(view.name, projectorContentHtml(view));
}

/** Show a projection: render locally and broadcast to every other Foundry client.
 * `game.socket.emit` does not echo to the sender, so the responder renders here and
 * peers render via the listener — exactly one render per client. */
export async function present(view: DisplayView): Promise<void> {
  await renderLocal(view);
  socket()?.emit(CHANNEL, buildShowBroadcast(view));
}

/** Clear the projection locally and on every other client. */
export async function clearDisplay(): Promise<void> {
  await closeProjector();
  socket()?.emit(CHANNEL, buildClearBroadcast());
}

/**
 * Listen for player-facing projector broadcasts on the shared socket and apply them
 * locally (NO re-broadcast — avoids loops). Registered on every client at `ready`,
 * alongside the agent channel; both ignore the other's traffic by shape.
 *
 * Trust model: Foundry's `module.*` relay carries no trustworthy sender, and only
 * the agent holds a signing key (the GM browser does not), so a broadcast cannot be
 * cryptographically attributed. This is accepted: the only client that emits a
 * show/clear is the elected responder running display.show; the content is
 * GM-authored, already-revealed material; and a popout is a transient overlay a GM
 * can dismiss — the same posture as Foundry core's "Show to Players". The
 * AUTHENTICATED gate is upstream: the agent (Ed25519-signed) decides who may
 * initiate a push from the app.
 */
export function startDisplayListener(): void {
  socket()?.on(CHANNEL, (raw) => {
    const msg = parseDisplayBroadcast(raw);
    if (!msg) return;
    if (msg.kind === "show") void renderLocal(msg.view);
    else void closeProjector();
  });
}

/** display.show — render a GM-authored, already-redacted projection to ALL Foundry
 * clients. The payload carries ONLY revealed content; no redaction, no Actor lookup. */
export const displayShow: Procedure = async (payload) => {
  const view = normalizeDisplayPayload(payload);
  await present(view);
  return { ok: true };
};

/** display.clear — tear down the projector popout on all clients. */
export const displayClear: Procedure = async () => {
  await clearDisplay();
  return { ok: true };
};
