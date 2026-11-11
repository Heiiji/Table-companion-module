import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actorImageV1,
  resetActorImageUploads,
} from "../src/procedures/actorImage.js";
import { registerBuiltinProcedures } from "../src/procedures/index.js";
import { ProcedureRegistry } from "../src/rpc/registry.js";
import { MAX_ENVELOPE_BYTES } from "../src/constants.js";

// SYNTHETIC: a world Actor and Foundry's FilePicker as the Foundry 14 client
// source shapes them (`FilePicker.upload` resolves the server's `{path}` and
// never throws; `createDirectory` rejects when the directory exists).

const ACTOR_ID = "kQx3Lr9ZpT2mWv8A";
const DEFAULT_ART = "systems/demo/icons/default-character.webp";
const DIR = "worlds/demo-world/table-companion/portraits";
const CHUNK = 30_720;

class DemoActor {
  img: string;
  prototypeToken = { texture: { src: "tokens/chosen.webp" } };
  update = vi.fn(async (changes: Record<string, unknown>) => {
    Object.assign(this, changes);
  });
  constructor(img: string) {
    this.img = img;
  }
  get _source() {
    return { type: "character", img: this.img };
  }
  static getDefaultArtwork(data: { type?: string }) {
    return {
      img:
        data.type === "character" ? DEFAULT_ART : "icons/svg/mystery-man.svg",
    };
  }
}

let actor: DemoActor;
let upload: ReturnType<typeof vi.fn>;
let createDirectory: ReturnType<typeof vi.fn>;

function stubFoundry(img = DEFAULT_ART) {
  actor = new DemoActor(img);
  upload = vi.fn(async (_source: string, path: string, file: File) => ({
    path: `${path}/${file.name}`,
    status: "success",
  }));
  createDirectory = vi.fn(async () => {
    throw new Error("EEXIST: the directory already exists");
  });
  vi.stubGlobal("game", {
    world: { id: "demo-world" },
    actors: { get: (id: string) => (id === ACTOR_ID ? actor : undefined) },
  });
  vi.stubGlobal("foundry", {
    applications: {
      apps: {
        FilePicker: {
          upload: vi.fn(),
          createDirectory: vi.fn(),
          implementation: { upload, createDirectory },
        },
      },
    },
  });
}

function jpeg(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31) & 0xff;
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}

const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function beginOf(bytes: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    op: "begin",
    uploadId: "upload-0000000001",
    actorId: ACTOR_ID,
    byteCount: bytes.length,
    sha256: hex(bytes),
    mode: "set",
    ...over,
  };
}

async function send(
  bytes: Uint8Array,
  over: Record<string, unknown> = {},
): Promise<unknown> {
  const uploadId = (over.uploadId as string) ?? "upload-0000000001";
  await actorImageV1(beginOf(bytes, over), {} as never);
  for (let i = 0, off = 0; off < bytes.length; i++, off += CHUNK) {
    await actorImageV1(
      {
        op: "chunk",
        uploadId,
        index: i,
        data: b64(bytes.subarray(off, off + CHUNK)),
      },
      {} as never,
    );
  }
  return actorImageV1({ op: "commit", uploadId }, {} as never);
}

async function refusal(p: Promise<unknown> | unknown): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "none";
}

beforeEach(() => {
  resetActorImageUploads();
  stubFoundry();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("actor.image.v1", () => {
  it("is registered on every world as a signed-only mutation", () => {
    const registry = new ProcedureRegistry();
    registerBuiltinProcedures(registry);
    expect(registry.mutations()).toContain("actor.image.v1");
    expect(registry.isSignedOnly("actor.image.v1")).toBe(true);
  });

  it("set: reassembles the chunks, saves the file and sets img only", async () => {
    const bytes = jpeg(3 * CHUNK + 17);
    const name = `${ACTOR_ID}-${hex(bytes).slice(0, 16)}.jpg`;
    const reply = await send(bytes);
    expect(reply).toEqual({
      ok: true,
      applied: true,
      img: `${DIR}/${name}`,
      path: `${DIR}/${name}`,
    });
    expect(createDirectory.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ["data", "worlds/demo-world/table-companion"],
      ["data", DIR],
    ]);
    const [source, dir, file, , options] = upload.mock.calls[0];
    expect([source, dir, options]).toEqual(["data", DIR, { notify: false }]);
    expect((file as File).name).toBe(name);
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(bytes);
    expect(actor.update).toHaveBeenCalledTimes(1);
    expect(actor.update).toHaveBeenCalledWith({ img: `${DIR}/${name}` });
    expect(actor.prototypeToken.texture.src).toBe("tokens/chosen.webp");
  });

  it("answers each chunk with the bytes received so far", async () => {
    const bytes = jpeg(CHUNK + 5);
    await actorImageV1(beginOf(bytes), {} as never);
    await expect(
      actorImageV1(
        {
          op: "chunk",
          uploadId: "upload-0000000001",
          index: 0,
          data: b64(bytes.subarray(0, CHUNK)),
        },
        {} as never,
      ),
    ).resolves.toEqual({ ok: true, received: CHUNK });
  });

  it("ifPlaceholder replaces the default artwork, an icon or an empty img", async () => {
    for (const img of [DEFAULT_ART, "icons/svg/mystery-man.svg", ""]) {
      stubFoundry(img);
      const reply = (await send(jpeg(100), { mode: "ifPlaceholder" })) as {
        applied: boolean;
      };
      expect(reply.applied).toBe(true);
      expect(actor.update).toHaveBeenCalledTimes(1);
    }
  });

  // Knight sets its per-type default in `KnightActor.create`, not through
  // `getDefaultArtwork`, so the default artwork check alone never sees it.
  it("ifPlaceholder replaces a Knight default icon", async () => {
    for (const type of ["knight", "ia", "creature", "bande", "vehicule"]) {
      stubFoundry(`systems/knight/assets/icons/${type}.svg`);
      const reply = (await send(jpeg(100), { mode: "ifPlaceholder" })) as {
        applied: boolean;
      };
      expect(reply.applied).toBe(true);
      expect(actor.update).toHaveBeenCalledTimes(1);
    }
  });

  it("ifPlaceholder keeps a chosen image and files the upload", async () => {
    stubFoundry("worlds/demo-world/art/korry.webp");
    const reply = (await send(jpeg(100), { mode: "ifPlaceholder" })) as Record<
      string,
      unknown
    >;
    expect(reply.applied).toBe(false);
    expect(reply.img).toBe("worlds/demo-world/art/korry.webp");
    expect(String(reply.path)).toMatch(
      /^worlds\/demo-world\/table-companion\/portraits\//,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("clear sets the system's default artwork", async () => {
    stubFoundry("worlds/demo-world/art/korry.webp");
    await expect(
      actorImageV1({ op: "clear", actorId: ACTOR_ID }, {} as never),
    ).resolves.toEqual({ ok: true, applied: true, img: DEFAULT_ART });
    expect(actor.update).toHaveBeenCalledWith({ img: DEFAULT_ART });
    expect(
      await refusal(
        actorImageV1({ op: "clear", actorId: "nobodyNobody0001" }, {} as never),
      ),
    ).toBe("actor_not_found");
  });

  it("refuses an unknown Actor at begin", async () => {
    expect(await refusal(send(jpeg(10), { actorId: "nobodyNobody0001" }))).toBe(
      "actor_not_found",
    );
  });

  it("refuses malformed requests", async () => {
    const bytes = jpeg(10);
    for (const bad of [
      null,
      { op: "rename" },
      beginOf(bytes, { uploadId: "short" }),
      beginOf(bytes, { actorId: "../../etc/passwd" }),
      beginOf(bytes, { byteCount: 0 }),
      beginOf(bytes, { byteCount: 1_048_577 }),
      beginOf(bytes, { sha256: "ABC" }),
      beginOf(bytes, { mode: "always" }),
      { ...beginOf(bytes), path: "modules/x" },
    ]) {
      expect(await refusal(actorImageV1(bad, {} as never))).toBe(
        "invalid_request",
      );
    }
  });

  it("drops the upload on an out-of-order, repeated or overflowing chunk", async () => {
    const bytes = jpeg(CHUNK + 10);
    const chunk = (index: number, data: string) =>
      actorImageV1(
        { op: "chunk", uploadId: "upload-0000000001", index, data },
        {} as never,
      );
    const commit = () =>
      actorImageV1(
        { op: "commit", uploadId: "upload-0000000001" },
        {} as never,
      );
    const first = b64(bytes.subarray(0, CHUNK));

    await actorImageV1(beginOf(bytes), {} as never);
    expect(await refusal(chunk(1, first))).toBe("invalid_request"); // gap
    expect(await refusal(commit())).toBe("upload_unknown");

    await actorImageV1(beginOf(bytes), {} as never);
    await chunk(0, first);
    expect(await refusal(chunk(0, first))).toBe("invalid_request"); // repeat
    expect(await refusal(chunk(1, b64(bytes.subarray(CHUNK))))).toBe(
      "upload_unknown",
    );

    await actorImageV1(beginOf(bytes), {} as never);
    await chunk(0, first);
    expect(await refusal(chunk(1, first))).toBe("invalid_request"); // past byteCount

    await actorImageV1(beginOf(bytes), {} as never);
    expect(await refusal(chunk(0, "not base64!"))).toBe("invalid_request");
    await actorImageV1(beginOf(bytes), {} as never);
    expect(await refusal(chunk(0, b64(jpeg(CHUNK + 3))))).toBe(
      "invalid_request",
    ); // chunk too large
  });

  it("refuses a wrong hash, a short image and a non-JPEG at commit", async () => {
    expect(await refusal(send(jpeg(100), { sha256: "0".repeat(64) }))).toBe(
      "invalid_image",
    );

    const bytes = jpeg(100);
    await actorImageV1(beginOf(bytes, { byteCount: 101 }), {} as never);
    await actorImageV1(
      {
        op: "chunk",
        uploadId: "upload-0000000001",
        index: 0,
        data: b64(bytes),
      },
      {} as never,
    );
    expect(
      await refusal(
        actorImageV1(
          { op: "commit", uploadId: "upload-0000000001" },
          {} as never,
        ),
      ),
    ).toBe("invalid_image");

    const png = jpeg(100);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    expect(await refusal(send(png))).toBe("invalid_image");
    expect(upload).not.toHaveBeenCalled();
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("refuses a chunk or commit for an unknown upload", async () => {
    expect(
      await refusal(
        actorImageV1(
          { op: "commit", uploadId: "upload-unknown-01" },
          {} as never,
        ),
      ),
    ).toBe("upload_unknown");
    expect(
      await refusal(
        actorImageV1(
          {
            op: "chunk",
            uploadId: "upload-unknown-01",
            index: 0,
            data: "AAAA",
          },
          {} as never,
        ),
      ),
    ).toBe("upload_unknown");
  });

  it("a third begin drops the oldest upload", async () => {
    const bytes = jpeg(10);
    for (const id of [
      "upload-a-00000001",
      "upload-b-00000001",
      "upload-c-00000001",
    ])
      await actorImageV1(beginOf(bytes, { uploadId: id }), {} as never);
    const chunk = (uploadId: string) =>
      actorImageV1(
        { op: "chunk", uploadId, index: 0, data: b64(bytes) },
        {} as never,
      );
    expect(await refusal(chunk("upload-a-00000001"))).toBe("upload_unknown");
    await expect(chunk("upload-b-00000001")).resolves.toEqual({
      ok: true,
      received: 10,
    });
    await expect(chunk("upload-c-00000001")).resolves.toEqual({
      ok: true,
      received: 10,
    });
  });

  it("drops an upload 60 s after its last op", async () => {
    vi.useFakeTimers();
    const bytes = jpeg(10);
    await actorImageV1(beginOf(bytes), {} as never);
    vi.advanceTimersByTime(59_000);
    await actorImageV1(
      {
        op: "chunk",
        uploadId: "upload-0000000001",
        index: 0,
        data: b64(bytes),
      },
      {} as never,
    );
    vi.advanceTimersByTime(60_001);
    expect(
      await refusal(
        actorImageV1(
          { op: "commit", uploadId: "upload-0000000001" },
          {} as never,
        ),
      ),
    ).toBe("upload_unknown");
  });

  it("reports upload_failed when Foundry refuses the file", async () => {
    for (const answer of [false, undefined, {}]) {
      stubFoundry();
      upload.mockResolvedValueOnce(answer);
      expect(await refusal(send(jpeg(100)))).toBe("upload_failed");
      expect(actor.update).not.toHaveBeenCalled();
    }
    vi.stubGlobal("foundry", undefined);
    expect(await refusal(send(jpeg(100)))).toBe("upload_failed");
  });

  it("keeps every reply far under the envelope cap", async () => {
    const reply = await send(jpeg(1_048_576));
    expect(JSON.stringify(reply).length).toBeLessThan(MAX_ENVELOPE_BYTES / 16);
  });
});
