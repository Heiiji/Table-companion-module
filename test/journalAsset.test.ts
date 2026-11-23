import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  journalAssetPath,
  journalAssetV1,
} from "../src/procedures/journalAsset.js";

const call = (p: unknown) => journalAssetV1(p, {} as never);
const id = "0123456789abcdef0123456789abcdef";
const bytes = Buffer.from("%PDF-1.7\nreading copy");
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const start = (bytes: Uint8Array, mime = "application/pdf", uploadId = id) => ({
  op: "begin",
  uploadId,
  sha256: sha(bytes),
  byteCount: bytes.length,
  mediaType: mime,
});
const chunk = (b: Uint8Array, index = 0, uploadId = id) => ({
  op: "chunk",
  uploadId,
  index,
  data: Buffer.from(b).toString("base64"),
});
const commit = (uploadId = id) => ({ op: "commit", uploadId });

const upload = vi.fn(async (_source: string, path: string, file: File) => ({
  path: path + "/" + file.name,
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("game", { world: { id: "demo-world" } });
  vi.stubGlobal("foundry", {
    applications: {
      apps: {
        FilePicker: {
          implementation: { upload, createDirectory: vi.fn(async () => true) },
        },
      },
    },
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("journal asset upload", () => {
  it.each([
    ["application/pdf", bytes],
    ["image/jpeg", Buffer.from([255, 216, 255, 0])],
    ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ["image/webp", Buffer.from("RIFFxxxxWEBPVP8 ")],
  ] as const)("writes %s at the digest-derived world path", async (type, b) => {
    for (let repeat = 0; repeat < 2; repeat++) {
      await call(start(b, type));
      await call(chunk(b.subarray(0, 3)));
      await call(chunk(b.subarray(3), 1));
      expect(await call(commit())).toEqual({
        ok: true,
        sha256: sha(b),
        mediaType: type,
      });
    }
    const [source, dir, file] = upload.mock.calls[0];
    expect(source).toBe("data");
    expect(dir + "/" + file.name).toBe(journalAssetPath(sha(b), type));
    expect(Buffer.from(await file.arrayBuffer())).toEqual(b);
    expect(upload.mock.calls[1][2].name).toBe(file.name);
  });
  it("rejects mismatched length, digest and MIME before saving", async () => {
    for (const patch of [
      { byteCount: bytes.length + 1 },
      { sha256: "c".repeat(64) },
      { mediaType: "image/png" },
    ]) {
      await call({ ...start(bytes), ...patch });
      await call(chunk(bytes));
      await expect(call(commit())).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(upload).not.toHaveBeenCalled();
  });
  it("refuses malformed upload descriptors and extra fields", async () => {
    for (const patch of [
      { sha256: "x" },
      { mediaType: "text/plain" },
      { byteCount: 0 },
      { byteCount: 64 * 1024 * 1024 + 1 },
      { path: "arbitrary" },
      { uploadId: "short" },
    ]) {
      await expect(call({ ...start(bytes), ...patch })).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  });
  it("drops an out-of-order upload, bounds simultaneous uploads and expires idle buffers", async () => {
    await call(start(bytes));
    await expect(call(chunk(bytes, 1))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(call(commit())).rejects.toMatchObject({
      code: "upload_unknown",
    });
    await call(start(bytes));
    await call(start(bytes, "application/pdf", "7".repeat(32)));
    await expect(
      call(start(bytes, "application/pdf", "8".repeat(32))),
    ).rejects.toMatchObject({ code: "upload_failed" });
    vi.advanceTimersByTime(61_000);
    await expect(call(commit())).rejects.toMatchObject({
      code: "upload_unknown",
    });
  });
  it("requires an exact file receipt", async () => {
    upload.mockResolvedValueOnce({ path: "another-file.pdf" });
    await call(start(bytes));
    await call(chunk(bytes));
    await expect(call(commit())).rejects.toMatchObject({
      code: "upload_failed",
    });
  });
});
