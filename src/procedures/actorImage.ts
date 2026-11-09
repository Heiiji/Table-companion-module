import {
  filePickerClass,
  gameActors,
  worldId,
  type ActorLike,
} from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";

/**
 * A character image sent from the app becomes a world Actor's `img`
 * (`actor.image.v1`). The backend relays the JPEG in chunks, each a signed
 * request under the envelope cap, and nothing is stored on its side: this
 * GM browser reassembles the bytes in memory, checks them, saves them into
 * the world's folder and updates the Actor.
 *
 * Ops: `begin` {uploadId, actorId, byteCount, sha256, mode}, `chunk`
 * {uploadId, index, data (base64)}, `commit` {uploadId}, `clear` {actorId}.
 *
 * The first procedure that writes a file on the Foundry host, so it is kept
 * narrow: one fixed directory, a file name built only from the validated
 * Actor id and the image's own hash, JPEG only, at most 1 MiB, and only a
 * world Actor (`game.actors.get`). `prototypeToken` is never written: Foundry
 * and the system decide whether the token follows the portrait.
 */

const MAX_BYTES = 1_048_576;
const MAX_CHUNK_BYTES = 30_720;
/** Uploads held at once; a further `begin` drops the oldest. */
const MAX_UPLOADS = 2;
/** An upload is dropped this long after its last op. */
const IDLE_MS = 60_000;
/** Foundry's default token (`CONST.DEFAULT_TOKEN`), when the Actor class has
 * no `getDefaultArtwork`. */
const FALLBACK_ARTWORK = "icons/svg/mystery-man.svg";
const DIRECTORY = "table-companion/portraits";

const UPLOAD_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ACTOR_ID = /^[A-Za-z0-9]{16}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MODES = ["set", "ifPlaceholder"] as const;
type Mode = (typeof MODES)[number];

interface Upload {
  actorId: string;
  sha256: string;
  mode: Mode;
  bytes: Uint8Array;
  received: number;
  next: number;
  touched: number;
}

const uploads = new Map<string, Upload>();

/** Test hook: forget every upload. */
export function resetActorImageUploads(): void {
  uploads.clear();
}

/** The Actor and the image members this procedure reads. */
interface ImageActor extends ActorLike {
  img?: string | null;
  _source?: unknown;
  toObject?(): unknown;
}

function refuse(
  code:
    | "invalid_request"
    | "actor_not_found"
    | "upload_unknown"
    | "invalid_image"
    | "upload_failed",
  message: string,
): never {
  throw new RpcError(code, message);
}

function fields(
  payload: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    refuse("invalid_request", "payload must be an object");
  const p = payload as Record<string, unknown>;
  const got = Object.keys(p);
  if (got.length !== keys.length || got.some((k) => !keys.includes(k)))
    refuse("invalid_request", `payload must have exactly ${keys.join(", ")}`);
  return p;
}

function matching(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== "string" || !pattern.test(value))
    refuse("invalid_request", `${name} is malformed`);
  return value;
}

function worldActor(actorId: string): ImageActor {
  const actor = gameActors()?.get(actorId) as ImageActor | undefined;
  if (!actor) refuse("actor_not_found", `no world Actor ${actorId}`);
  return actor;
}

/** The system's default artwork for this Actor (Foundry's `getDefaultArtwork`). */
function defaultArtwork(actor: ImageActor): string {
  const cls = actor.constructor as {
    getDefaultArtwork?(data: unknown): { img?: unknown } | undefined;
  };
  try {
    const img = cls.getDefaultArtwork?.(
      actor._source ?? actor.toObject?.(),
    )?.img;
    if (typeof img === "string" && img !== "") return img;
  } catch {
    // fall through: a system override that throws is no artwork
  }
  return FALLBACK_ARTWORK;
}

/** Not an image someone chose: empty, a core icon, or the default artwork. */
function isPlaceholder(actor: ImageActor): boolean {
  const img = actor.img ?? "";
  return (
    img === "" || img.startsWith("icons/svg/") || img === defaultArtwork(actor)
  );
}

function prune(now: number): void {
  for (const [id, u] of uploads)
    if (now - u.touched > IDLE_MS) uploads.delete(id);
}

function held(uploadId: string): Upload {
  const u = uploads.get(uploadId);
  if (!u)
    refuse(
      "upload_unknown",
      "no such upload (expired, dropped or never begun)",
    );
  return u;
}

function decodeBase64(data: unknown): Uint8Array | undefined {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    data.length > (MAX_CHUNK_BYTES / 3) * 4 ||
    !BASE64.test(data)
  )
    return undefined;
  try {
    return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Create `dir` and its parent; an existing directory (or any refusal) is
 * left to the upload, which fails if the directory is really missing. */
async function ensureDirectory(dir: string): Promise<void> {
  const picker = filePickerClass();
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  for (const target of [parent, dir]) {
    try {
      await picker?.createDirectory("data", target, {});
    } catch {
      // « already exists » is the common case
    }
  }
}

function begin(p: Record<string, unknown>, now: number) {
  fields(p, ["op", "uploadId", "actorId", "byteCount", "sha256", "mode"]);
  const uploadId = matching(p.uploadId, UPLOAD_ID, "uploadId");
  const actorId = matching(p.actorId, ACTOR_ID, "actorId");
  const sha256 = matching(p.sha256, SHA256_HEX, "sha256");
  const byteCount = p.byteCount;
  if (
    !Number.isSafeInteger(byteCount) ||
    (byteCount as number) < 1 ||
    (byteCount as number) > MAX_BYTES
  )
    refuse("invalid_request", `byteCount must be 1 to ${MAX_BYTES}`);
  if (!MODES.includes(p.mode as Mode))
    refuse("invalid_request", "mode must be set or ifPlaceholder");
  worldActor(actorId);
  uploads.delete(uploadId);
  while (uploads.size >= MAX_UPLOADS)
    uploads.delete(uploads.keys().next().value as string);
  uploads.set(uploadId, {
    actorId,
    sha256,
    mode: p.mode as Mode,
    bytes: new Uint8Array(byteCount as number),
    received: 0,
    next: 0,
    touched: now,
  });
  return { ok: true };
}

function chunk(p: Record<string, unknown>, now: number) {
  fields(p, ["op", "uploadId", "index", "data"]);
  const uploadId = matching(p.uploadId, UPLOAD_ID, "uploadId");
  const u = held(uploadId);
  const bytes = decodeBase64(p.data);
  if (
    p.index !== u.next ||
    !bytes ||
    u.received + bytes.length > u.bytes.length
  ) {
    uploads.delete(uploadId);
    refuse(
      "invalid_request",
      `chunk ${String(p.index)} is out of order, malformed or past byteCount; the upload is dropped`,
    );
  }
  u.bytes.set(bytes, u.received);
  u.received += bytes.length;
  u.next += 1;
  u.touched = now;
  return { ok: true, received: u.received };
}

async function commit(p: Record<string, unknown>) {
  fields(p, ["op", "uploadId"]);
  const uploadId = matching(p.uploadId, UPLOAD_ID, "uploadId");
  const u = held(uploadId);
  uploads.delete(uploadId);
  const b = u.bytes;
  if (u.received !== b.length)
    refuse("invalid_image", "the image is shorter than byteCount");
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff)
    refuse("invalid_image", "not a JPEG");
  if ((await sha256Hex(b)) !== u.sha256)
    refuse("invalid_image", "sha256 does not match");
  const actor = worldActor(u.actorId);
  const world = worldId();
  const picker = filePickerClass();
  if (!world || !picker)
    refuse("upload_failed", "Foundry's file picker or world id is unavailable");
  const dir = `worlds/${world}/${DIRECTORY}`;
  await ensureDirectory(dir);
  const name = `${u.actorId}-${u.sha256.slice(0, 16)}.jpg`;
  let result: unknown;
  try {
    result = await picker.upload(
      "data",
      dir,
      new File([b as BlobPart], name, { type: "image/jpeg" }),
      {},
      { notify: false },
    );
  } catch {
    result = undefined;
  }
  const path = (result as { path?: unknown } | null | undefined)?.path;
  if (typeof path !== "string" || path === "")
    refuse("upload_failed", "Foundry refused the file");
  if (actor.img === path) return { ok: true, applied: true, img: path, path };
  if (u.mode === "ifPlaceholder" && !isPlaceholder(actor))
    return { ok: true, applied: false, img: actor.img ?? "", path };
  await actor.update({ img: path });
  return { ok: true, applied: true, img: path, path };
}

async function clear(p: Record<string, unknown>) {
  fields(p, ["op", "actorId"]);
  const actor = worldActor(matching(p.actorId, ACTOR_ID, "actorId"));
  const img = defaultArtwork(actor);
  if (actor.img !== img) await actor.update({ img });
  return { ok: true, applied: true, img };
}

export const actorImageV1: Procedure = async (payload) => {
  const now = Date.now();
  prune(now);
  const p = (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as Record<string, unknown>;
  switch (p.op) {
    case "begin":
      return begin(p, now);
    case "chunk":
      return chunk(p, now);
    case "commit":
      return commit(p);
    case "clear":
      return clear(p);
    default:
      return refuse(
        "invalid_request",
        "op must be begin, chunk, commit or clear",
      );
  }
};
