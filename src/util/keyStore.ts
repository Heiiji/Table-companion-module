import { log } from "./log.js";

/** A signing keypair as persisted by a {@link KeyStore}: the private key stays a
 * live `CryptoKey` (never exported), the public half travels as base64. */
export interface StoredKeyPair {
  privateKey: CryptoKey;
  publicKeyB64: string;
}

/** Where the responder GM's response-signing key lives between sessions. */
export interface KeyStore {
  load(): Promise<StoredKeyPair | null>;
  save(pair: StoredKeyPair): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "table-companion";
const DB_VERSION = 1;
const STORE = "keys";
/** The browser-wide record of builds before per-world keys: every world and
 * user of this browser shared it. Now only an adoption source (see
 * loadOrCreateSigner), so a key the backend already pinned keeps working. */
const LEGACY_RECORD = "moduleResponseKey";

/** The record of one world's key for one Foundry user: « Reset pairing » in one
 * world, or another user of this browser, never rotates another world's key. */
export function responseKeyRecord(worldId: string, userId: string): string {
  return `${LEGACY_RECORD}:${worldId}:${userId}`;
}

/**
 * A {@link KeyStore} backed by this browser's IndexedDB for the Foundry origin.
 *
 * IndexedDB stores a `CryptoKey` by structured clone, so a key generated with
 * `extractable: false` can be persisted and reused without its private bytes
 * ever being readable by script — unlike the JWK the module used to keep in a
 * client setting (localStorage), which any macro or add-on in the GM's browser
 * could copy out. `record` names the key (one per world and user, see
 * responseKeyRecord; the default is the legacy browser-wide one). Returns null
 * where IndexedDB is unavailable; the caller then keeps the JWK path.
 */
export function indexedDbKeyStore(
  record: string = LEGACY_RECORD,
): KeyStore | null {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  const run = async <T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = op(tx.objectStore(STORE));
        let result: T;
        req.onsuccess = () => {
          result = req.result;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? req.error);
      });
    } finally {
      db.close();
    }
  };

  return {
    async load() {
      const v = (await run("readonly", (s) => s.get(record))) as unknown;
      if (!v || typeof v !== "object") return null;
      const pair = v as Partial<StoredKeyPair>;
      if (!(pair.privateKey instanceof CryptoKey)) return null;
      if (typeof pair.publicKeyB64 !== "string" || !pair.publicKeyB64) {
        return null;
      }
      return { privateKey: pair.privateKey, publicKeyB64: pair.publicKeyB64 };
    },
    async save(pair) {
      await run("readwrite", (s) => s.put(pair, record));
    },
    async clear() {
      try {
        await run("readwrite", (s) => s.delete(record));
      } catch (err) {
        log.warn("could not clear the stored response-signing key", err);
      }
    },
  };
}
