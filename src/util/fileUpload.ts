import { filePickerClass } from "../foundry/runtime.js";

const MAX_CHUNK_BYTES = 30_720;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeUploadChunk(data: unknown): Uint8Array | undefined {
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

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Create `dir` and its parent; an existing directory (or any refusal) is
 * left to the upload, which fails if the directory is really missing. */
export async function ensureUploadDirectory(dir: string): Promise<void> {
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
