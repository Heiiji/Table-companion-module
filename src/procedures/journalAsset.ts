import { filePickerClass, worldId } from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { ensureUploadDirectory } from "../util/fileUpload.js";
import { journalUpload } from "./journalUpload.js";

const extensions = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

/** World and name are derived locally; the caller never supplies a path. */
export function journalAssetPath(sha256: unknown, mediaType: unknown): string {
  const ext = typeof mediaType === "string" && extensions.get(mediaType);
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || !ext)
    throw new RpcError("invalid_request", "invalid journal asset descriptor");
  const world = worldId();
  if (!world || !/^[A-Za-z0-9_-]+$/.test(world))
    throw new RpcError("upload_failed", "world directory unavailable");
  return `worlds/${world}/table-companion/journals/${sha256}.${ext}`;
}

function matchesType(b: Uint8Array, type: string): boolean {
  const starts = (s: string, offset = 0) =>
    Array.from(s).every((c, i) => b[offset + i] === c.charCodeAt(0));
  switch (type) {
    case "application/pdf":
      return starts("%PDF-");
    case "image/png":
      return starts("\x89PNG\r\n\x1a\n");
    case "image/jpeg":
      return starts("\xff\xd8\xff");
    case "image/webp":
      return starts("RIFF") && starts("WEBPVP", 8);
    default:
      return false;
  }
}

export const journalAssetV1: Procedure = journalUpload(
  64 * 1024 * 1024,
  ["mediaType"],
  (p) => ({
    path: journalAssetPath(p.sha256, p.mediaType),
    mediaType: p.mediaType as string,
  }),
  async (bytes, sha256, { path, mediaType }) => {
    if (!matchesType(bytes, mediaType))
      throw new RpcError(
        "invalid_request",
        "journal file type differs from its contents",
      );
    if (journalAssetPath(sha256, mediaType) !== path)
      throw new RpcError("upload_failed", "world changed during upload");
    const picker = filePickerClass();
    if (!picker)
      throw new RpcError("upload_failed", "Foundry file picker is unavailable");
    const at = path.lastIndexOf("/");
    const dir = path.slice(0, at);
    await ensureUploadDirectory(dir);
    const file = new File([bytes], path.slice(at + 1), {
      type: mediaType,
    });
    const result = (await picker.upload(
      "data",
      dir,
      file,
      {},
      { notify: false },
    )) as { path?: unknown } | null | undefined;
    if (result?.path !== path)
      throw new RpcError(
        "upload_failed",
        "Foundry did not confirm the content-addressed file",
      );
    return { ok: true, sha256: sha256, mediaType: mediaType };
  },
);
