import { MODULE_ID } from "../constants.js";
import {
  foundryGame,
  journalImplementation,
  filePickerClass,
  type Dict,
  type JournalPageLike,
  type JournalEntryLike,
} from "../foundry/runtime.js";
import { RpcError } from "../rpc/errors.js";
import type { Procedure } from "../rpc/registry.js";
import { pairedAgentUserId } from "../setup/identity.js";
import { sha256Hex } from "../util/fileUpload.js";
import { escapeHtml } from "../util/html.js";
import {
  canonicalDigest,
  documentId,
  identifier,
  integer,
  invalid,
  oneOf,
  record,
  text,
  uuid,
} from "./upsertShared.js";
import { journalUpload } from "./journalUpload.js";
import { journalAssetPath } from "./journalAsset.js";

function appID(value: unknown, label: string) {
  const id = identifier(
    typeof value === "string" ? value.toLowerCase() : value,
    label,
    uuid,
  );
  if (id === "00000000-0000-0000-0000-000000000000")
    invalid(label + " is empty");
  return id;
}

function baseRevision(value: unknown) {
  const base =
    value === undefined
      ? undefined
      : record(value, "base", [
          "entryId",
          "pageId",
          "entryModifiedTime",
          "pageModifiedTime",
        ]);
  return (
    base && {
      entryId: identifier(base.entryId, "entryId", documentId),
      pageId: identifier(base.pageId, "pageId", documentId),
      entryModifiedTime: integer(
        base.entryModifiedTime,
        "entryModifiedTime",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      pageModifiedTime: integer(
        base.pageModifiedTime,
        "pageModifiedTime",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    }
  );
}

function request(payload: unknown) {
  const p = record(payload, "journal", [
    "schemaVersion",
    "tableId",
    "handoutId",
    "operationId",
    "kind",
    "title",
    "body",
    "base",
    "asset",
  ]);
  integer(p.schemaVersion, "schemaVersion", 1, 1);
  const kind = oneOf(p.kind, "kind", ["text", "image", "map", "pdf"] as const);
  const asset =
    p.asset === undefined
      ? undefined
      : record(p.asset, "asset", ["sha256", "mediaType"]);
  if (
    (kind === "text") !== !asset ||
    (asset && (kind === "pdf") !== (asset.mediaType === "application/pdf"))
  )
    invalid("attachment type differs from the page type");
  return {
    tableId: appID(p.tableId, "tableId"),
    handoutId: appID(p.handoutId, "handoutId"),
    operationId: appID(p.operationId, "operationId"),
    kind,
    title: text(p.title, "title", 256, true),
    body: text(p.body, "body", 1024 * 1024),
    base: baseRevision(p.base),
    path: asset ? journalAssetPath(asset.sha256, asset.mediaType) : undefined,
  };
}
type Request = ReturnType<typeof request>;

// Stable document ids also make concurrent creates on two GM browsers safe.
async function stableID(key: string) {
  return (await sha256Hex(new TextEncoder().encode(key))).slice(0, 16);
}

function stamp(doc: JournalPageLike | JournalEntryLike) {
  const time = doc._stats?.modifiedTime ?? doc._stats?.createdTime;
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0)
    throw new RpcError(
      "base_conflict",
      "Foundry could not verify the document revision",
    );
  return time;
}

function receipt(
  entry: JournalEntryLike,
  page: JournalPageLike,
  operationId: string,
) {
  return {
    schemaVersion: 1,
    entryId: entry.id,
    pageId: page.id,
    entryModifiedTime: stamp(entry),
    pageModifiedTime: stamp(page),
    operationId,
  };
}

// Page and entry are separate Foundry documents. A stored rename intent lets a
// retry finish the second write without reverting a label the GM chose in Foundry.
async function finishRename(
  entry: JournalEntryLike,
  title: string,
  priorTitleDigest: string | undefined,
) {
  if (!priorTitleDigest || entry.name === title || entry.pages.size !== 1)
    return;
  const seen = entry.name;
  if (
    (await canonicalDigest(seen)) === priorTitleDigest &&
    entry.name === seen &&
    entry.pages.size === 1
  ) {
    await entry.update({ name: title });
  }
}

function conflict(): never {
  throw new RpcError("base_conflict", "The Foundry journal has changed");
}

function plainHTML(body: string) {
  return body === ""
    ? ""
    : "<p>" +
        body
          .split(/\r\n|\r|\n/)
          .map(escapeHtml)
          .join("<br>") +
        "</p>";
}

function pageContent(p: Request): Dict {
  switch (p.kind) {
    case "text":
      return { text: { content: plainHTML(p.body), format: 1 } };
    case "image":
    case "map":
    case "pdf":
      return { src: p.path, image: { caption: p.body } };
  }
}

function isPlainHTML(html: string) {
  // A text edit can replace plain paragraphs. Preserve references, secret blocks,
  // figures, styles, headings and any other content a native editor can add.
  return !/[<>]/.test(html.replace(/<\/?p>|<br\s*\/?>/gi, ""));
}

async function upsert(p: Request, entryId: string, pageId: string) {
  const game = foundryGame();
  if (!game?.user?.isGM)
    throw new RpcError("permission_denied", "A Gamemaster must be present");
  const collection = game.journal;
  const factory = journalImplementation();
  if (!collection || !factory)
    throw new RpcError(
      "unsupported_runtime",
      "Journal documents are unavailable",
    );
  if (p.base && (p.base.entryId !== entryId || p.base.pageId !== pageId))
    conflict();
  const digest = await canonicalDigest([
    p.tableId,
    p.handoutId,
    p.kind,
    p.title,
    p.body,
    p.path ?? null,
    p.base ?? null,
  ]);
  const bodyDigest = await canonicalDigest(p.body);
  const flag = {
    tableId: p.tableId,
    handoutId: p.handoutId,
    operationId: p.operationId,
    kind: p.kind,
    digest,
    bodyDigest,
    priorTitleDigest: "",
    contentDigest: await canonicalDigest(
      p.kind === "text" ? plainHTML(p.body) : p.body,
    ),
  };
  const type = p.kind === "map" ? "image" : p.kind;
  if (p.path) {
    const directory = p.path.slice(0, p.path.lastIndexOf("/"));
    const listing = await filePickerClass()?.browse?.("data", directory);
    if (!listing?.files?.includes(p.path))
      throw new RpcError("not_found", "The journal attachment is unavailable");
  }
  let entry = collection.get(entryId);
  if (!entry) {
    if (p.base) conflict();
    const service = pairedAgentUserId();
    if (!service || service === "default")
      throw new RpcError(
        "permission_denied",
        "The companion service must be paired",
      );
    const ownership = { default: 0, [service]: 2 };
    const page = {
      _id: pageId,
      name: p.title,
      type,
      ownership,
      flags: { [MODULE_ID]: { journalSync: flag } },
      ...pageContent(p),
    };
    try {
      entry = await factory.create(
        { _id: entryId, name: p.title, ownership, pages: [page] },
        { keepId: true, keepEmbeddedIds: true },
      );
    } catch (err) {
      entry = collection.get(entryId);
      if (!entry) throw err;
    }
  }
  const page = entry?.pages.get(pageId);
  if (!entry || !page) conflict();
  const previous = page.getFlag(MODULE_ID, "journalSync") as Partial<
    typeof flag
  > | null;
  if (previous?.tableId !== p.tableId || previous.handoutId !== p.handoutId)
    conflict();
  if (previous.operationId === p.operationId) {
    if (previous.digest !== digest) conflict();
    // An edit in Foundry since the successful write must not become the new
    // optimistic base of a replayed request.
    const currentContent =
      p.kind === "text"
        ? (page.text?.content ?? "")
        : (page.image?.caption ?? "");
    if (
      page.name !== p.title ||
      page.type !== type ||
      (p.path && page.src !== p.path) ||
      previous.contentDigest !== (await canonicalDigest(currentContent))
    )
      conflict();
    await finishRename(entry, p.title, previous.priorTitleDigest);
    return receipt(entry, page, p.operationId);
  }
  if (
    !p.base ||
    stamp(entry) !== p.base.entryModifiedTime ||
    stamp(page) !== p.base.pageModifiedTime ||
    page.type !== type
  )
    conflict();
  if (
    entry.pages.size === 1 &&
    entry.name === page.name &&
    page.name !== p.title
  ) {
    flag.priorTitleDigest = await canonicalDigest(entry.name);
  }
  const changes: Dict = {
    name: p.title,
    ["flags." + MODULE_ID + ".journalSync"]: flag,
  };
  if (p.kind === "text") {
    if (previous.bodyDigest !== bodyDigest) {
      if (!isPlainHTML(page.text?.content ?? "") || page.text?.format === 2)
        conflict();
      Object.assign(changes, pageContent(p));
    } else {
      flag.contentDigest = await canonicalDigest(page.text?.content ?? "");
    }
  } else Object.assign(changes, pageContent(p));
  // Update only this page, preserving sibling pages, journal organization and
  // both ownership maps, including subsequent changes by a world Gamemaster.
  if (
    stamp(entry) !== p.base.entryModifiedTime ||
    stamp(page) !== p.base.pageModifiedTime
  )
    conflict();
  await page.update(changes);
  const updated = collection.get(entryId);
  const updatedPage = updated?.pages.get(pageId);
  if (
    !updated ||
    !updatedPage ||
    (
      updatedPage.getFlag(MODULE_ID, "journalSync") as Partial<
        typeof flag
      > | null
    )?.digest !== digest
  )
    conflict();
  await finishRename(updated, p.title, flag.priorTitleDigest);
  return receipt(updated, updatedPage, p.operationId);
}

const writes = new Map<string, Promise<unknown>>();
async function onJournal<T>(
  tableId: string,
  handoutId: string,
  action: (entryId: string, pageId: string) => Promise<T>,
) {
  const key = tableId + ":" + handoutId;
  const write = (writes.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const [entryId, pageId] = await Promise.all([
        stableID("journal-entry:" + key),
        stableID("journal-page:" + key),
      ]);
      return action(entryId, pageId);
    });
  writes.set(key, write);
  try {
    return await write;
  } finally {
    if (writes.get(key) === write) writes.delete(key);
  }
}

function writeJournal(payload: unknown) {
  const p = request(payload);
  return onJournal(p.tableId, p.handoutId, (entryId, pageId) =>
    upsert(p, entryId, pageId),
  );
}

export const journalDeleteV1: Procedure = async (payload) => {
  const p = record(payload, "journal", [
    "schemaVersion",
    "tableId",
    "handoutId",
    "operationId",
    "base",
  ]);
  integer(p.schemaVersion, "schemaVersion", 1, 1);
  const tableId = appID(p.tableId, "tableId");
  const handoutId = appID(p.handoutId, "handoutId");
  const operationId = appID(p.operationId, "operationId");
  const base = baseRevision(p.base);
  if (!base) return invalid("a journal base is required");
  return onJournal(tableId, handoutId, async (entryId, pageId) => {
    const game = foundryGame();
    if (!game?.user?.isGM)
      throw new RpcError("permission_denied", "A Gamemaster must be present");
    if (!game.journal)
      throw new RpcError(
        "unsupported_runtime",
        "Journal documents are unavailable",
      );
    if (base.entryId !== entryId || base.pageId !== pageId) conflict();
    const entry = game.journal.get(entryId);
    const page = entry?.pages.get(pageId);
    if (entry && page) {
      const flag = page.getFlag(MODULE_ID, "journalSync") as Dict | null;
      if (
        flag?.tableId !== tableId ||
        flag.handoutId !== handoutId ||
        stamp(entry) !== base.entryModifiedTime ||
        stamp(page) !== base.pageModifiedTime
      )
        conflict();
      await page.delete();
      if (game.journal.get(entryId)?.pages.get(pageId)) conflict();
    }
    return { schemaVersion: 1, operationId, entryId, pageId, deleted: true };
  });
};

const receiveText = journalUpload(
  1024 * 1024,
  [],
  () => undefined,
  async (bytes) => {
    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return invalid("invalid journal JSON");
    }
    return writeJournal(payload);
  },
);
export const journalUpsertV1: Procedure = (payload) => {
  if (payload && typeof payload === "object" && Object.hasOwn(payload, "op"))
    return receiveText(payload);
  return writeJournal(payload);
};
