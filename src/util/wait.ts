import { foundryHooks } from "../foundry/runtime.js";

/** `read()` once it is truthy, re-read after every one of `hookNames` rather
 * than on a timer chain a hidden tab would throttle; null at the deadline. */
export function waitFor<T>(
  read: () => T | null | undefined,
  hookNames: readonly string[],
  ms: number,
): Promise<T | null> {
  const now = read();
  if (now) return Promise.resolve(now);
  const hooks = foundryHooks();
  return new Promise((resolve) => {
    const finish = (value: T | null | undefined) => {
      clearTimeout(timer);
      ids.forEach(([name, id]) => hooks?.off?.(name, id));
      resolve(value ?? null);
    };
    const check = () => {
      const value = read();
      if (value) finish(value);
    };
    const ids = hookNames.map(
      (name) => [name, hooks?.on(name, check)] as const,
    );
    const timer = setTimeout(() => finish(read()), ms);
  });
}

/** `promise`'s value, or null once `ms` has passed. */
export function within<T>(
  promise: Promise<T | null>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => (timer = setTimeout(resolve, ms, null))),
  ]).finally(() => clearTimeout(timer));
}
