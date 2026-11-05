import { afterEach, describe, expect, it, vi } from "vitest";
import {
  indexedDbKeyStore,
  responseKeyRecord,
  type StoredKeyPair,
} from "../src/util/keyStore.js";

/** The slice of IndexedDB the key store uses, in memory: one database of
 * object stores, requests that answer on the next tick, a transaction that
 * completes after its request. `failWrites` makes every readwrite abort. */
function fakeIndexedDb(opts: { failWrites?: boolean } = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  const request = <T>(run: () => T) => {
    const req: {
      result?: T;
      error: Error | null;
      onsuccess?: () => void;
      onerror?: () => void;
      onupgradeneeded?: () => void;
    } = { error: null };
    setTimeout(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  };
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => stores.set(n, new Map()),
    close: vi.fn(),
    transaction(name: string, mode: string) {
      const data = stores.get(name)!;
      const tx: {
        error: Error | null;
        oncomplete?: () => void;
        onerror?: () => void;
        onabort?: () => void;
        objectStore: () => unknown;
      } = {
        error: null,
        objectStore: () => ({
          get: (k: string) => done(request(() => data.get(k))),
          put: (v: unknown, k: string) => done(request(() => data.set(k, v))),
          delete: (k: string) => done(request(() => data.delete(k))),
        }),
      };
      // The transaction settles after its request has answered.
      const done = <R>(req: R): R => {
        setTimeout(() =>
          setTimeout(() => {
            if (mode === "readwrite" && opts.failWrites) {
              tx.error = new Error("quota");
              tx.onabort?.();
            } else tx.oncomplete?.();
          }),
        );
        return req;
      };
      return tx;
    },
  };
  const factory = {
    open: () => {
      // The upgrade runs before success, as in a browser.
      const req = request(() => db);
      const run = () => req.onupgradeneeded?.();
      return new Proxy(req, {
        set(target, key, value) {
          if (key !== "onsuccess") return Reflect.set(target, key, value);
          target.onsuccess = () => (run(), (value as () => void)());
          return true;
        },
      });
    },
  };
  return { factory, stores, db };
}

async function keyPair(): Promise<StoredKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKeyB64: "cHVibGlj" };
}

afterEach(() => vi.unstubAllGlobals());

describe("responseKeyRecord", () => {
  it("names one record per world and user", () => {
    expect(responseKeyRecord("w1", "u1")).toBe("moduleResponseKey:w1:u1");
    expect(responseKeyRecord("w1", "u1")).not.toBe(
      responseKeyRecord("w2", "u1"),
    );
  });
});

describe("indexedDbKeyStore", () => {
  it("is null where IndexedDB is unavailable", () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(indexedDbKeyStore()).toBeNull();
  });

  it("keeps a non-extractable key across loads, per record", async () => {
    const { factory, db } = fakeIndexedDb();
    vi.stubGlobal("indexedDB", factory);
    const a = indexedDbKeyStore(responseKeyRecord("w1", "u1"))!;
    const b = indexedDbKeyStore(responseKeyRecord("w2", "u1"))!;
    expect(await a.load()).toBeNull();
    const pair = await keyPair();
    await a.save(pair);
    const loaded = await a.load();
    expect(loaded?.privateKey).toBe(pair.privateKey);
    expect(loaded?.privateKey.extractable).toBe(false);
    expect(loaded?.publicKeyB64).toBe("cHVibGlj");
    expect(await b.load()).toBeNull();
    expect(db.close).toHaveBeenCalled();
  });

  it("ignores a record that is not a stored key pair", async () => {
    const { factory, stores } = fakeIndexedDb();
    vi.stubGlobal("indexedDB", factory);
    const store = indexedDbKeyStore("r")!;
    await store.save(await keyPair()); // creates the object store
    const keys = stores.get("keys")!;
    for (const bad of [
      "text",
      { privateKey: "not a key", publicKeyB64: "x" },
      { privateKey: (await keyPair()).privateKey, publicKeyB64: "" },
    ]) {
      keys.set("r", bad);
      expect(await store.load()).toBeNull();
    }
  });

  it("clears its record, and a failed clear only warns", async () => {
    const ok = fakeIndexedDb();
    vi.stubGlobal("indexedDB", ok.factory);
    const store = indexedDbKeyStore("r")!;
    await store.save(await keyPair());
    await store.clear();
    expect(await store.load()).toBeNull();

    const failing = fakeIndexedDb({ failWrites: true });
    vi.stubGlobal("indexedDB", failing.factory);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(indexedDbKeyStore("r")!.clear()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    await expect(indexedDbKeyStore("r")!.save(await keyPair())).rejects.toThrow(
      "quota",
    );
  });
});
