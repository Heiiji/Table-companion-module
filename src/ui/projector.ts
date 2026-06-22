import { localize, log } from "../util/log.js";

/**
 * The shared-screen / projector popout (PNJ-refactor locked decision #3). A thin
 * Foundry layer over DialogV2 — it only instantiates and renders a pre-built,
 * already-escaped HTML string (built by projectorContentHtml in
 * procedures/display.ts, the sole escaper). No Actor/canvas/scene coupling.
 *
 * The DialogV2 constructor is resolved lazily AND through globalThis, so this
 * module is import- and call-safe even when `foundry` is undefined (a very old
 * Foundry, or a unit test): the resolver yields undefined and openProjector
 * no-ops, rather than a bare-identifier ReferenceError.
 */
const DialogV2 = (): (new (opts: unknown) => unknown) | undefined =>
  (
    globalThis as unknown as {
      foundry?: { applications?: { api?: { DialogV2?: new (opts: unknown) => unknown } } };
    }
  ).foundry?.applications?.api?.DialogV2;

interface DialogInstance {
  rendered: boolean;
  render(options: { force: boolean }): Promise<unknown>;
  close(): Promise<unknown>;
}

// Single live projector popout. A new show REPLACES the prior — the spotlight is a
// singleton ("push a 2nd clears the 1st"), matching the app's NowShowing model.
let projectorDialog: DialogInstance | undefined;

/** Open (or replace) the projector popout with pre-built, already-escaped content.
 * Best-effort: if the Application framework is unavailable (a very old Foundry, or
 * a unit test) this no-ops — the mesh spotlight still drives the app UI, so the
 * canvas popout is pure enrichment and its absence is never fatal. */
export async function openProjector(
  title: string,
  contentHtml: string,
): Promise<void> {
  const Ctor = DialogV2();
  if (!Ctor) return;
  await closeProjector();
  try {
    const dialog = new Ctor({
      // A dedicated class hook for the high-contrast projector theme (styles/module.css).
      classes: ["tca-projector"],
      window: { title, icon: "fa-solid fa-tv" },
      content: contentHtml,
      buttons: [{ action: "close", label: localize("common.close"), default: true }],
    }) as DialogInstance;
    projectorDialog = dialog;
    await dialog.render({ force: true });
  } catch (err) {
    projectorDialog = undefined;
    log.error("could not open the projector display", err);
  }
}

/** Close the projector popout if open. Idempotent — pairs every spotlight clear. */
export async function closeProjector(): Promise<void> {
  const dialog = projectorDialog;
  projectorDialog = undefined;
  if (dialog?.rendered) {
    try {
      await dialog.close();
    } catch (err) {
      log.warn("could not close the projector display", err);
    }
  }
}
