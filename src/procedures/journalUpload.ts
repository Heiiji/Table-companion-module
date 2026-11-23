import { RpcError } from "../rpc/errors.js";
import { decodeUploadChunk, sha256Hex } from "../util/fileUpload.js";

interface Upload<T> {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  metadata: T;
  received: number;
  index: number;
  timer: ReturnType<typeof setTimeout>;
  committing: boolean;
}

export function journalUpload<T>(
  maxBytes: number,
  extraKeys: string[],
  metadata: (p: Record<string, unknown>) => T,
  commit: (
    bytes: Uint8Array<ArrayBuffer>,
    sha256: string,
    metadata: T,
  ) => Promise<unknown>,
) {
  const uploads = new Map<string, Upload<T>>();
  const idleMs = 60_000;

  function drop(id: string, u: Upload<T>): void {
    clearTimeout(u.timer);
    uploads.delete(id);
  }

  function expire(id: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => uploads.delete(id), idleMs);
  }

  function exact(p: Record<string, unknown>, names: string[]): void {
    if (
      Object.keys(p).length !== names.length ||
      !names.every((k) => Object.hasOwn(p, k))
    )
      throw new RpcError("invalid_request", "unexpected upload fields");
  }

  return async (payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new RpcError("invalid_request", "upload payload required");
    const p = payload as Record<string, unknown>;
    const id = p.uploadId;
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))
      throw new RpcError("invalid_request", "invalid upload id");
    if (p.op === "begin") {
      exact(p, ["op", "uploadId", "sha256", "byteCount", ...extraKeys]);
      if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256))
        throw new RpcError("invalid_request", "invalid digest");
      const context = metadata(p);
      if (
        typeof p.byteCount !== "number" ||
        !Number.isSafeInteger(p.byteCount) ||
        p.byteCount < 1 ||
        p.byteCount > maxBytes
      )
        throw new RpcError("invalid_request", "invalid journal asset size");
      if (uploads.has(id) || uploads.size >= 2)
        throw new RpcError(
          "upload_failed",
          "another journal upload is in progress",
        );
      uploads.set(id, {
        bytes: new Uint8Array(p.byteCount),
        sha256: p.sha256,
        metadata: context,
        received: 0,
        index: 0,
        committing: false,
        timer: expire(id),
      });
      return { ok: true };
    }
    const u = uploads.get(id);
    if (!u || u.committing)
      throw new RpcError("upload_unknown", "upload is not open");
    if (p.op === "chunk") {
      exact(p, ["op", "uploadId", "index", "data"]);
      const bytes = decodeUploadChunk(p.data);
      if (
        !bytes ||
        u.index !== p.index ||
        bytes.length > u.bytes.length - u.received
      ) {
        drop(id, u);
        throw new RpcError("invalid_request", "invalid or out-of-order chunk");
      }
      u.bytes.set(bytes, u.received);
      u.received += bytes.length;
      u.index++;
      clearTimeout(u.timer);
      u.timer = expire(id);
      return { ok: true, received: u.received };
    }
    if (p.op !== "commit")
      throw new RpcError("invalid_request", "unknown journal upload operation");
    exact(p, ["op", "uploadId"]);
    clearTimeout(u.timer);
    u.committing = true;
    try {
      if (
        u.received !== u.bytes.length ||
        (await sha256Hex(u.bytes)) !== u.sha256
      )
        throw new RpcError(
          "invalid_request",
          "journal file did not match its descriptor",
        );
      return await commit(u.bytes, u.sha256, u.metadata);
    } finally {
      drop(id, u);
    }
  };
}
