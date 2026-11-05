import { dialogV2Class, type DialogInstance } from "../foundry/runtime.js";
import { localize, log } from "../util/log.js";

/**
 * The shared-screen / projector popout: one per client, replaced by each new
 * show. A thin Foundry layer over DialogV2 — it only instantiates and renders a pre-built,
 * already-escaped HTML string (built by projectorContentHtml in
 * procedures/display.ts, the sole escaper). No Actor/canvas/scene coupling.
 *
 * The DialogV2 constructor is resolved lazily through the runtime gateway, so
 * this module is import- and call-safe even when `foundry` is undefined (a very
 * old Foundry, or a unit test): the resolver yields undefined and openProjector
 * no-ops, rather than a bare-identifier ReferenceError.
 */

// Single live projector popout. A new show REPLACES the prior — the spotlight is a
// singleton ("push a 2nd clears the 1st"), matching the app's NowShowing model.
let projectorDialog: DialogInstance | undefined;

// Every show and clear runs after the previous one has settled: a clear (or a
// second show) arriving while a popout is still rendering would otherwise find
// it not yet `rendered`, skip it, and leave it open with nothing tracking it.
// ponytail: a render that never settles blocks later shows/clears until reload.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  queue = run.catch(() => undefined);
  return run;
}

/** Open (or replace) the projector popout with pre-built, already-escaped content.
 *
 * Returns whether it actually rendered. Best-effort remains the POLICY — if the
 * Application framework is unavailable (a very old Foundry, or a unit test) the
 * mesh spotlight still drives the app UI, so the popout's absence is never fatal
 * — but the caller is told, rather than the failure being swallowed into a
 * blanket success. The GM is the one who has to know the projector did not come
 * up, because they are standing in front of a screen that is still blank. */
export function openProjector(
  title: string,
  contentHtml: string,
): Promise<boolean> {
  return serialized(async () => {
    const Ctor = dialogV2Class();
    if (!Ctor) return false;
    await closeNow();
    try {
      const dialog = new Ctor({
        // A dedicated class hook for the high-contrast projector theme (styles/module.css).
        classes: ["tca-projector"],
        window: { title, icon: "fa-solid fa-tv" },
        content: contentHtml,
        buttons: [
          { action: "close", label: localize("common.close"), default: true },
        ],
      });
      projectorDialog = dialog;
      await dialog.render({ force: true });
      return true;
    } catch (err) {
      projectorDialog = undefined;
      log.error("could not open the projector display", err);
      return false;
    }
  });
}

/** Close the projector popout if open. Idempotent — pairs every spotlight clear. */
export function closeProjector(): Promise<void> {
  return serialized(closeNow);
}

async function closeNow(): Promise<void> {
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
