import { MODULE_ID } from "../constants.js";

const PREFIX = "Table Companion |";

export const log = {
  info(...args: unknown[]): void {
    console.log(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};

/** Localize a key under this module's namespace, e.g. localize("setup.title"). */
export function localize(key: string, data?: Record<string, string>): string {
  const full = `${MODULE_ID}.${key}`;
  const i18n = game.i18n;
  if (!i18n) return full;
  return data ? i18n.format(full, data) : i18n.localize(full);
}
