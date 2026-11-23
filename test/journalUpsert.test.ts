import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { journalUpsertV1 } from "../src/procedures/journalUpsert.js";
import type { RpcContext } from "../src/rpc/registry.js";

type Data = Record<string, any>;
const tableId = "11111111-1111-1111-1111-111111111111";
const handoutId = "22222222-2222-2222-2222-222222222222";
const operations = [
  "33333333-3333-3333-3333-333333333333",
  "44444444-4444-4444-4444-444444444444",
  "55555555-5555-5555-5555-555555555555",
];
const initial = {
  schemaVersion: 1,
  tableId,
  handoutId,
  operationId: operations[0],
  kind: "text",
  title: "Rumours",
  body: "A <b>note</b>\nfor tomorrow",
};
const send = (p: Data) => journalUpsertV1(p, {} as RpcContext) as Promise<Data>;
let entries: Map<string, Data>;
let create: ReturnType<typeof vi.fn>;
let page: Data;
const base = (r: Data) => ({
  entryId: r.entryId,
  pageId: r.pageId,
  entryModifiedTime: r.entryModifiedTime,
  pageModifiedTime: r.pageModifiedTime,
});

beforeEach(() => {
  entries = new Map();
  create = vi.fn(async (d: Data) => {
    const first = d.pages[0];
    let flag = first.flags["table-companion"].journalSync;
    page = {
      ...first,
      id: first._id,
      _stats: { modifiedTime: 12 },
      getFlag: () => flag,
      update: vi.fn(async (change: Data) => {
        flag = change["flags.table-companion.journalSync"];
        Object.assign(page, change);
        page._stats.modifiedTime++;
      }),
    };
    const entry = {
      ...d,
      id: d._id,
      pages: new Map([[page.id, page]]),
      _stats: { modifiedTime: 10 },
    };
    Object.assign(entry, {
      update: vi.fn(async (change: Data) => {
        Object.assign(entry, change);
        entry._stats.modifiedTime++;
      }),
    });
    entries.set(d._id, entry);
    return entry;
  });
  vi.stubGlobal("game", {
    user: { isGM: true },
    world: { id: "demo" },
    journal: entries,
    settings: { get: () => "service" },
  });
  vi.stubGlobal("JournalEntry", { implementation: { create } });
});
afterEach(() => vi.unstubAllGlobals());
describe("companion journal", () => {
  it("creates a private journal and page and coalesces concurrent retries", async () => {
    const [a, b] = await Promise.all([send(initial), send(initial)]);
    expect(a).toEqual(b);
    expect(create).toHaveBeenCalledTimes(1);
    expect(entries.get(a.entryId)?.ownership).toEqual({
      default: 0,
      service: 2,
    });
    expect(page.ownership).toEqual({ default: 0, service: 2 });
    expect(page.text.content).toBe(
      "<p>A &lt;b&gt;note&lt;/b&gt;<br>for tomorrow</p>",
    );
    expect(page._id).toMatch(/^[a-f0-9]{16}$/);
    expect(page.getFlag().handoutId).toBe(handoutId);
    await expect(send({ ...initial, body: "other" })).rejects.toMatchObject({
      code: "base_conflict",
    });
  });
  it("commits a long UTF-8 journal through the same private write", async () => {
    const { createHash } = await import("node:crypto");
    const long = { ...initial, body: "Été à la table. ".repeat(4700) };
    const data = Buffer.from(JSON.stringify(long));
    const uploadId = "c".repeat(32);
    await send({
      op: "begin",
      uploadId,
      byteCount: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    for (
      let offset = 0, index = 0;
      offset < data.length;
      offset += 30720, index++
    ) {
      await send({
        op: "chunk",
        uploadId,
        index,
        data: data.subarray(offset, offset + 30720).toString("base64"),
      });
    }
    expect(create).not.toHaveBeenCalled();
    const receipt = await send({ op: "commit", uploadId });
    expect(receipt.operationId).toBe(initial.operationId);
    expect(page.text.content).toContain(long.body);
    expect(page.ownership.default).toBe(0);
  });
  it("updates the page using both revisions, preserving its current audience and siblings", async () => {
    const first = await send(initial);
    page.ownership = { default: 0, player: 2 };
    entries.get(first.entryId)?.pages.set("sibling", { name: "Other page" });
    const update = {
      ...initial,
      title: "Later",
      body: "new",
      operationId: operations[1],
      base: base(first),
    };
    const after = await send(update);
    expect(after.pageModifiedTime).toBeGreaterThan(first.pageModifiedTime);
    expect(page.text.content).toBe("<p>new</p>");
    expect(page.ownership.player).toBe(2);
    expect(entries.get(first.entryId)?.pages.size).toBe(2);
    expect(await send(update)).toEqual(after);
    await expect(
      send({ ...update, operationId: operations[2] }),
    ).rejects.toMatchObject({ code: "base_conflict" });
  });
  it("renames its single-page journal, and resumes an interrupted rename without overwriting native organization", async () => {
    const r = await send(initial);
    const entry = entries.get(r.entryId)!;
    const req = {
      ...initial,
      operationId: operations[1],
      title: "Later",
      base: base(r),
    };
    entry.update.mockRejectedValueOnce(new Error("Interrupted"));
    await expect(send(req)).rejects.toThrow("Interrupted");
    expect(page.name).toBe("Later");
    expect(entry.name).toBe(initial.title);
    const receipt = await send(req);
    expect(entry.name).toBe("Later");
    entry.name = "World archive";
    entry._stats.modifiedTime++;
    await send({
      ...req,
      title: "New page title",
      operationId: operations[2],
      base: { ...base(receipt), entryModifiedTime: entry._stats.modifiedTime },
    });
    expect(entry.name).toBe("World archive");
    expect(page.name).toBe("New page title");
  });
  it("protects a native rich-text edit during a retry or body replacement", async () => {
    const first = await send(initial);
    page.text.content = '<section class="secret">A private draft</section>';
    page._stats.modifiedTime++;
    await expect(send(initial)).rejects.toMatchObject({
      code: "base_conflict",
    });
    const current = {
      ...base(first),
      pageModifiedTime: page._stats.modifiedTime,
    };
    await expect(
      send({
        ...initial,
        base: current,
        operationId: operations[1],
        body: "replace",
      }),
    ).rejects.toMatchObject({ code: "base_conflict" });
    const rename = {
      ...initial,
      base: current,
      operationId: operations[2],
      title: "New title",
    };
    const receipt = await send(rename);
    expect(page.text.content).toContain("private draft");
    expect(await send(rename)).toEqual(receipt);
  });
  it("refuses a removed page, an unknown binding or an arbitrary target", async () => {
    const first = await send(initial);
    page.getFlag = () => ({ tableId, handoutId: "other" });
    await expect(send(initial)).rejects.toMatchObject({
      code: "base_conflict",
    });
    await expect(
      send({
        ...initial,
        operationId: operations[1],
        base: { ...base(first), pageId: "1234567890123456" },
      }),
    ).rejects.toMatchObject({ code: "base_conflict" });
    entries.delete(first.entryId);
    await expect(
      send({ ...initial, operationId: operations[1], base: base(first) }),
    ).rejects.toMatchObject({ code: "base_conflict" });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("permits a file only from the world's journal directory", async () => {
    const sha256 = "f".repeat(64),
      path = "worlds/demo/table-companion/journals/" + sha256 + ".pdf";
    const pdf = {
      ...initial,
      kind: "pdf",
      body: "Appendix",
      asset: { sha256, mediaType: "application/pdf" },
    };
    const browse = vi
      .fn()
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValue({ files: [path] });
    vi.stubGlobal("foundry", {
      applications: { apps: { FilePicker: { browse } } },
    });
    await expect(send(pdf)).rejects.toMatchObject({ code: "not_found" });
    await send(pdf);
    expect(page.src).toBe(path);
    expect(page.image.caption).toBe("Appendix");
  });
});
