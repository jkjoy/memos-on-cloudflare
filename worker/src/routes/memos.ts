import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired, authOptional } from "../middleware/auth";
import * as memoDB from "../db/memo";
import * as relationDB from "../db/relation";
import * as reactionDB from "../db/reaction";
import * as shareDB from "../db/share";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";
import { deleteCachedKeys, getCachedJson, putCachedJson, sha256Hex } from "../cache";

type MemoApp = { Bindings: Env; Variables: { user: UserPayload } };

export const memoRoutes = new Hono<MemoApp>();

const getUtf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

const getMemoContentLengthLimit = async (db: D1Database) => {
  const setting = await settingDB.getInstanceSetting(db, "MEMO_RELATED");
  if (!setting) {
    return 0;
  }
  try {
    const parsed = JSON.parse(setting.value) || {};
    return Number(parsed.contentLengthLimit) || 0;
  } catch {
    return 0;
  }
};

function generateUid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 22);
}

interface LinkMetadata {
  url?: string;
  title: string;
  description: string;
  image: string;
}

function parseMemoPayload(content: string) {
  const tags: string[] = [];
  const tagRegex = /#([a-zA-Z0-9_一-鿿぀-ゟ゠-ヿ/\-]+)/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    tags.push(match[1]);
  }

  const hasLink = /https?:\/\/[^\s]+/.test(content);
  const hasTaskList = /- \[[ x]\]/.test(content);
  const hasCode = /```[\s\S]*?```/.test(content) || /`[^`]+`/.test(content);
  const hasIncompleteTask = /- \[ \]/.test(content);

  const lines = content.split("\n");
  let title = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      title = trimmed.replace(/^#+\s*/, "").slice(0, 100);
      break;
    }
  }

  return {
    tags,
    property: { hasLink, hasTaskList, hasCode, hasIncompleteTask, title },
  };
}

function formatMemo(memo: memoDB.MemoRow, creatorUsername?: string) {
  const payload = JSON.parse(memo.payload || "{}");
  return {
    name: `memos/${memo.uid}`,
    creator: `users/${creatorUsername || memo.creator_id}`,
    createTime: new Date(memo.created_ts * 1000).toISOString(),
    updateTime: new Date(memo.updated_ts * 1000).toISOString(),
    state: memo.row_status === "ARCHIVED" ? "ARCHIVED" : "NORMAL",
    content: memo.content,
    visibility: memo.visibility,
    pinned: memo.pinned === 1,
    tags: payload.tags || [],
    property: payload.property || {},
    location: payload.location || null,
    parent: payload.parent || "",
  };
}

function createPlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function getMemoAttachments(db: D1Database, memoId: number, memoUid: string) {
  const { results } = await db.prepare("SELECT * FROM attachment WHERE memo_id = ? ORDER BY created_ts ASC").bind(memoId).all<any>();
  return results.map((att) => ({
    id: att.id,
    name: `attachments/${att.uid}`,
    uid: att.uid,
    createTime: new Date(att.created_ts * 1000).toISOString(),
    updateTime: new Date((att.updated_ts || att.created_ts) * 1000).toISOString(),
    filename: att.filename,
    type: att.type,
    size: att.size,
    memo: `memos/${memoUid}`,
    externalLink: "",
    motionMedia: (() => {
      try {
        return att.payload ? JSON.parse(att.payload).motionMedia : undefined;
      } catch {
        return undefined;
      }
    })(),
  }));
}

async function getMemoRelations(db: D1Database, memoId: number) {
  const relations = await relationDB.listRelations(db, memoId);
  return Promise.all(
    relations.map(async (relation) => {
      const memo = await memoDB.getMemoById(db, relation.memo_id);
      const relatedMemo = await memoDB.getMemoById(db, relation.related_memo_id);
      return {
        memo: memo ? { name: `memos/${memo.uid}`, snippet: memo.content.slice(0, 120) } : undefined,
        relatedMemo: relatedMemo ? { name: `memos/${relatedMemo.uid}`, snippet: relatedMemo.content.slice(0, 120) } : undefined,
        type: relation.type,
      };
    }),
  );
}

function formatReaction(reaction: reactionDB.ReactionRow, creatorUsername?: string) {
  return {
    id: reaction.id,
    creator: `users/${creatorUsername || reaction.creator_id}`,
    contentId: reaction.content_id,
    reactionType: reaction.reaction_type,
    createTime: new Date(reaction.created_ts * 1000).toISOString(),
  };
}

async function resolveUsernamesByIds(db: D1Database, ids: number[]): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isFinite(id));
  const usernameMap = new Map<number, string>();
  if (uniqueIds.length === 0) return usernameMap;

  for (const chunk of chunkValues(uniqueIds, 900)) {
    const { results } = await db.prepare(
      `SELECT id, username FROM user WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).all<{ id: number; username: string }>();

    for (const user of results) {
      usernameMap.set(user.id, user.username);
    }
  }
  return usernameMap;
}

async function getMemoReactions(db: D1Database, memoUid: string) {
  const reactions = await reactionDB.listReactions(db, memoUid);
  const usernameMap = await resolveUsernamesByIds(db, reactions.map((r) => r.creator_id));
  return reactions.map((r) => formatReaction(r, usernameMap.get(r.creator_id)));
}

function formatShare(share: shareDB.ShareRow, memoUid: string) {
  return {
    name: `memos/${memoUid}/shares/${share.uid}`,
    uid: share.uid,
    createTime: new Date(share.created_ts * 1000).toISOString(),
    expireTime: share.expires_ts ? new Date(share.expires_ts * 1000).toISOString() : null,
  };
}

async function enrichMemo(db: D1Database, memo: memoDB.MemoRow, creatorUsername?: string) {
  const [attachments, relations, reactions] = await Promise.all([
    getMemoAttachments(db, memo.id, memo.uid),
    getMemoRelations(db, memo.id),
    getMemoReactions(db, memo.uid),
  ]);
  return {
    ...formatMemo(memo, creatorUsername),
    attachments,
    relations,
    reactions,
  };
}

async function resolveCreatorUsernames(db: D1Database, memos: memoDB.MemoRow[]): Promise<Map<number, string>> {
  return resolveUsernamesByIds(db, memos.map((m) => m.creator_id));
}

async function listAttachmentRowsByMemoIds(db: D1Database, memoIds: number[]) {
  const rows: any[] = [];
  for (const chunk of chunkValues(memoIds, 900)) {
    const { results } = await db.prepare(
      `SELECT * FROM attachment WHERE memo_id IN (${createPlaceholders(chunk.length)}) ORDER BY memo_id ASC, created_ts ASC`
    ).bind(...chunk).all<any>();
    rows.push(...results);
  }
  return rows;
}

async function listRelationRowsByMemoIds(db: D1Database, memoIds: number[]) {
  const rows: relationDB.RelationRow[] = [];
  for (const chunk of chunkValues(memoIds, 450)) {
    const placeholders = createPlaceholders(chunk.length);
    const { results } = await db.prepare(
      `SELECT * FROM memo_relation WHERE memo_id IN (${placeholders}) OR related_memo_id IN (${placeholders})`
    ).bind(...chunk, ...chunk).all<relationDB.RelationRow>();
    rows.push(...results);
  }
  return rows;
}

async function listReactionRowsByContentIds(db: D1Database, contentIds: string[]) {
  const rows: reactionDB.ReactionRow[] = [];
  for (const chunk of chunkValues(contentIds, 900)) {
    const { results } = await db.prepare(
      `SELECT * FROM reaction WHERE content_id IN (${createPlaceholders(chunk.length)}) ORDER BY content_id ASC, created_ts ASC`
    ).bind(...chunk).all<reactionDB.ReactionRow>();
    rows.push(...results);
  }
  return rows;
}

async function getMemoSnippetMapByIds(db: D1Database, memoIds: number[]) {
  const memoMap = new Map<number, { uid: string; content: string }>();
  const uniqueIds = [...new Set(memoIds)];
  for (const chunk of chunkValues(uniqueIds, 900)) {
    const { results } = await db.prepare(
      `SELECT id, uid, content FROM memo WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).all<{ id: number; uid: string; content: string }>();
    for (const memo of results) {
      memoMap.set(memo.id, memo);
    }
  }
  return memoMap;
}

async function enrichMemos(db: D1Database, memos: memoDB.MemoRow[], creatorUsernameMap?: Map<number, string>) {
  if (memos.length === 0) {
    return [];
  }

  const memoIds = memos.map((m) => m.id);
  const memoUids = memos.map((m) => m.uid);
  const memoUidById = new Map(memos.map((m) => [m.id, m.uid]));
  const memoIdSet = new Set(memoIds);

  const [
    attachmentRows,
    relationRows,
    reactionRows,
  ] = await Promise.all([
    listAttachmentRowsByMemoIds(db, memoIds),
    listRelationRowsByMemoIds(db, memoIds),
    listReactionRowsByContentIds(db, memoUids),
  ]);

  const attachmentsByMemoId = new Map<number, any[]>();
  for (const att of attachmentRows) {
    const memoUid = memoUidById.get(att.memo_id);
    if (!memoUid) continue;
    const attachments = attachmentsByMemoId.get(att.memo_id) || [];
    attachments.push({
      id: att.id,
      name: `attachments/${att.uid}`,
      uid: att.uid,
      createTime: new Date(att.created_ts * 1000).toISOString(),
      updateTime: new Date((att.updated_ts || att.created_ts) * 1000).toISOString(),
      filename: att.filename,
      type: att.type,
      size: att.size,
      memo: `memos/${memoUid}`,
      externalLink: "",
      motionMedia: (() => {
        try {
          return att.payload ? JSON.parse(att.payload).motionMedia : undefined;
        } catch {
          return undefined;
        }
      })(),
    });
    attachmentsByMemoId.set(att.memo_id, attachments);
  }

  const relationMemoIds = relationRows.flatMap((relation) => [relation.memo_id, relation.related_memo_id]);
  const relationMemoMap = await getMemoSnippetMapByIds(db, relationMemoIds);

  const relationsByMemoId = new Map<number, any[]>();
  for (const relation of relationRows) {
    const memo = relationMemoMap.get(relation.memo_id);
    const relatedMemo = relationMemoMap.get(relation.related_memo_id);
    const formattedRelation = {
      memo: memo ? { name: `memos/${memo.uid}`, snippet: memo.content.slice(0, 120) } : undefined,
      relatedMemo: relatedMemo ? { name: `memos/${relatedMemo.uid}`, snippet: relatedMemo.content.slice(0, 120) } : undefined,
      type: relation.type,
    };

    if (memoIdSet.has(relation.memo_id)) {
      const relations = relationsByMemoId.get(relation.memo_id) || [];
      relations.push(formattedRelation);
      relationsByMemoId.set(relation.memo_id, relations);
    }
    if (memoIdSet.has(relation.related_memo_id) && relation.related_memo_id !== relation.memo_id) {
      const relations = relationsByMemoId.get(relation.related_memo_id) || [];
      relations.push(formattedRelation);
      relationsByMemoId.set(relation.related_memo_id, relations);
    }
  }

  const reactionUsernameMap = await resolveUsernamesByIds(db, reactionRows.map((r) => r.creator_id));
  const reactionsByContentId = new Map<string, ReturnType<typeof formatReaction>[]>();
  for (const reaction of reactionRows) {
    const reactions = reactionsByContentId.get(reaction.content_id) || [];
    reactions.push(formatReaction(reaction, reactionUsernameMap.get(reaction.creator_id)));
    reactionsByContentId.set(reaction.content_id, reactions);
  }

  return memos.map((memo) => ({
    ...formatMemo(memo, creatorUsernameMap?.get(memo.creator_id)),
    attachments: attachmentsByMemoId.get(memo.id) || [],
    relations: relationsByMemoId.get(memo.id) || [],
    reactions: reactionsByContentId.get(memo.uid) || [],
  }));
}

async function invalidateMemoDerivedCaches(cache: KVNamespace | undefined, usernames: Array<string | undefined>) {
  const keys = ["user:stats:all", "instance:stats"];
  for (const username of usernames) {
    if (username) {
      keys.push(`user:stats:${username}`);
    }
  }
  await deleteCachedKeys(cache, keys);
}

function getAttachmentReference(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const attachment = value as { name?: unknown; uid?: unknown; id?: unknown };
    if (typeof attachment.name === "string") return attachment.name;
    if (typeof attachment.uid === "string") return attachment.uid;
    if (typeof attachment.id === "number" || typeof attachment.id === "string") return String(attachment.id);
  }
  return "";
}

async function getLinkMetadata(env: Env, url: string, includeUrl = false): Promise<LinkMetadata> {
  const cacheKey = `link-metadata:${await sha256Hex(url)}`;
  const cached = await getCachedJson<LinkMetadata>(env.CACHE, cacheKey);
  if (cached) {
    return includeUrl ? { ...cached, url } : cached;
  }

  let metadata: LinkMetadata;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "cfmemos-bot/1.0" },
      redirect: "follow",
    });
    const html = await resp.text();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const imageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

    metadata = {
      title: titleMatch?.[1]?.trim() || "",
      description: descMatch?.[1]?.trim() || "",
      image: imageMatch?.[1]?.trim() || "",
    };
  } catch {
    metadata = { title: "", description: "", image: "" };
  }

  await putCachedJson(env.CACHE, cacheKey, metadata, 60 * 60 * 24 * 14);
  return includeUrl ? { ...metadata, url } : metadata;
}

async function resolveAttachmentIds(db: D1Database, user: UserPayload, references: unknown[]): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<number>();

  for (const referenceValue of references) {
    const reference = getAttachmentReference(referenceValue);
    if (!reference) continue;

    const token = reference.startsWith("attachments/") ? reference.slice("attachments/".length) : reference;
    const row = await db.prepare("SELECT id, creator_id FROM attachment WHERE uid = ? OR id = ?")
      .bind(token, Number(token) || 0)
      .first<{ id: number; creator_id: number }>();

    if (!row) continue;
    if (row.creator_id !== user.id && user.role !== "ADMIN") continue;
    if (!seen.has(row.id)) {
      ids.push(row.id);
      seen.add(row.id);
    }
  }

  return ids;
}

async function setMemoAttachments(db: D1Database, memoId: number, user: UserPayload, references: unknown[]) {
  const attachmentIds = await resolveAttachmentIds(db, user, references);

  await db.prepare("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?").bind(memoId).run();
  for (const attId of attachmentIds) {
    if (user.role === "ADMIN") {
      await db.prepare("UPDATE attachment SET memo_id = ? WHERE id = ?").bind(memoId, attId).run();
    } else {
      await db.prepare("UPDATE attachment SET memo_id = ? WHERE id = ? AND creator_id = ?").bind(memoId, attId, user.id).run();
    }
  }
}

// Create memo
memoRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { content, visibility, createTime, updateTime, location } = body;

  if (!content && content !== "") {
    return c.json({ error: "Content is required" }, 400);
  }

  const contentLengthLimit = await getMemoContentLengthLimit(c.env.DB);
  if (contentLengthLimit > 0 && getUtf8ByteLength(content || "") > contentLengthLimit) {
    return c.json(
      createErrorBody(`Memo content exceeds the maximum allowed length of ${contentLengthLimit} bytes.`, {
        errorKey: "message.memo-content-too-long",
        errorParams: { size: contentLengthLimit },
      }),
      400,
    );
  }

  const uid = generateUid();
  const payload = {
    ...parseMemoPayload(content || ""),
    ...(location ? { location } : {}),
  };

  const createdTs = createTime ? Math.floor(new Date(createTime).getTime() / 1000) : undefined;
  const updatedTs = updateTime ? Math.floor(new Date(updateTime).getTime() / 1000) : undefined;

  const memo = await memoDB.createMemo(c.env.DB, {
    uid,
    creatorId: user.id,
    content: content || "",
    visibility: visibility || "PRIVATE",
    payload: JSON.stringify(payload),
    createdTs,
    updatedTs,
  });

  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    await setMemoAttachments(c.env.DB, memo.id, user, body.attachments);
  }

  await invalidateMemoDerivedCaches(c.env.CACHE, [user.username]);
  return c.json(await enrichMemo(c.env.DB, memo, user.username), 201);
});

// List memos
memoRoutes.get("/", authOptional, async (c) => {
  const user = c.get("user");
  const pageSize = Math.min(Number(c.req.query("pageSize")) || 50, 1000);
  const pageToken = c.req.query("pageToken");
  const filter = c.req.query("filter") || "";
  const orderBy = c.req.query("orderBy") || "";
  const state = c.req.query("state") || "NORMAL";

  let offset = 0;
  if (pageToken) {
    try {
      offset = Number(atob(pageToken));
    } catch { /* invalid token, start from 0 */ }
  }

  const opts: memoDB.ListMemosOpts = {
    pageSize,
    offset,
    orderBy,
    rowStatus: state === "ARCHIVED" ? "ARCHIVED" : "NORMAL",
    excludeComments: true,
  };

  // Parse filter string (simplified CEL-like: key == "value" && key2 == "value2")
  if (filter) {
    const creatorMatch = filter.match(/creator_id\s*==\s*(\d+)/);
    if (creatorMatch) opts.creatorId = Number(creatorMatch[1]);

    const creatorNameMatch = filter.match(/creator\s*==\s*"users\/([^"]+)"/);
    if (creatorNameMatch) {
      const { findUserByUsername } = await import("../db/user");
      const creatorUser = await findUserByUsername(c.env.DB, creatorNameMatch[1]);
      if (creatorUser) opts.creatorId = creatorUser.id;
    }

    const visMatch = filter.match(/visibility\s*==\s*"?(\w+)"?/);
    if (visMatch) opts.visibility = visMatch[1];
    const visInMatch = filter.match(/visibility\s+in\s*\[([^\]]+)\]/);
    if (visInMatch) opts.visibilities = visInMatch[1].match(/\w+/g) || [];

    const contentMatch = filter.match(/content\.contains\(("(?:[^"\\]|\\.)*")\)/);
    if (contentMatch) opts.contentSearch = JSON.parse(contentMatch[1]);

    const tagMatch = filter.match(/tag\s*(?:==\s*"([^"]+)"|in\s*\["([^"]+)"\])/);
    if (tagMatch) opts.tagSearch = tagMatch[1] || tagMatch[2];

    const pinnedMatch = filter.match(/pinned\s*==\s*(true|false)/);
    if (pinnedMatch) opts.pinned = pinnedMatch[1] === "true";
    else if (/\bpinned\b/.test(filter) && !filter.includes("pinned ==")) opts.pinned = true;

    const createdAfterMatch = filter.match(/created_ts\s*>=\s*(\d+(?:\.\d+)?)/);
    if (createdAfterMatch) opts.createdTsAfter = Math.floor(Number(createdAfterMatch[1]));

    const createdBeforeMatch = filter.match(/created_ts\s*<\s*(\d+(?:\.\d+)?)/);
    if (createdBeforeMatch) opts.createdTsBefore = Math.floor(Number(createdBeforeMatch[1]));
  }

  // Visibility enforcement
  if (!user) {
    opts.visibility = "PUBLIC";
  } else if (!opts.creatorId || opts.creatorId !== user.id) {
    if (!opts.visibility) {
      // Non-owner can see PUBLIC and PROTECTED
      // We'll handle this in a custom way
    }
  }

  const { memos, total } = await memoDB.listMemos(c.env.DB, opts);

  // Filter by visibility for non-owners
  let filtered = memos;
  if (user && !opts.visibility && (!opts.creatorId || opts.creatorId !== user.id)) {
    filtered = memos.filter(
      (m) => m.visibility === "PUBLIC" || m.visibility === "PROTECTED" || m.creator_id === user.id
    );
  }

  const nextPageToken = offset + pageSize < total ? btoa(String(offset + pageSize)) : "";

  const usernameMap = await resolveCreatorUsernames(c.env.DB, filtered);

  return c.json({
    memos: await enrichMemos(c.env.DB, filtered, usernameMap),
    nextPageToken,
    totalSize: total,
  });
});

// Get memo by ID (supports both numeric id and uid)
memoRoutes.get("/:id", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }

  // Visibility check
  if (memo.visibility === "PRIVATE" && (!user || user.id !== memo.creator_id)) {
    return c.json({ error: "Permission denied" }, 403);
  }
  if (memo.visibility === "PROTECTED" && !user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const creatorUser = await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(memo.creator_id).first<{ username: string }>();
  return c.json(await enrichMemo(c.env.DB, memo, creatorUser?.username));
});

// Update memo
memoRoutes.patch("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const updateData: Parameters<typeof memoDB.updateMemo>[2] = {};

  if (body.content !== undefined) {
    const contentLengthLimit = await getMemoContentLengthLimit(c.env.DB);
    if (contentLengthLimit > 0 && getUtf8ByteLength(body.content) > contentLengthLimit) {
      return c.json(
        createErrorBody(`Memo content exceeds the maximum allowed length of ${contentLengthLimit} bytes.`, {
          errorKey: "message.memo-content-too-long",
          errorParams: { size: contentLengthLimit },
        }),
        400,
      );
    }
    updateData.content = body.content;
    const payload = parseMemoPayload(body.content);
    const existingPayload = JSON.parse(memo.payload || "{}");
    updateData.payload = JSON.stringify({ ...existingPayload, ...payload });
  }
  if (body.location !== undefined) {
    const existingPayload = JSON.parse((updateData.payload as string) || memo.payload || "{}");
    updateData.payload = JSON.stringify({
      ...existingPayload,
      ...(body.location ? { location: body.location } : { location: null }),
    });
  }
  if (body.visibility !== undefined) updateData.visibility = body.visibility;
  if (body.pinned !== undefined) updateData.pinned = body.pinned ? 1 : 0;
  if (body.rowStatus !== undefined) updateData.row_status = body.rowStatus;
  if (body.createTime) updateData.created_ts = Math.floor(new Date(body.createTime).getTime() / 1000);
  if (body.updateTime) updateData.updated_ts = Math.floor(new Date(body.updateTime).getTime() / 1000);

  const updated = await memoDB.updateMemo(c.env.DB, memo.id, updateData);
  if (!updated) {
    return c.json({ error: "Update failed" }, 500);
  }

  const creatorName = updated.creator_id === user.id ? user.username : (await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(updated.creator_id).first<{ username: string }>())?.username;
  await invalidateMemoDerivedCaches(c.env.CACHE, [creatorName]);
  return c.json(await enrichMemo(c.env.DB, updated, creatorName));
});

// Delete memo
memoRoutes.delete("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const creatorName = memo.creator_id === user.id ? user.username : (await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(memo.creator_id).first<{ username: string }>())?.username;
  await memoDB.deleteMemo(c.env.DB, memo.id);
  await invalidateMemoDerivedCaches(c.env.CACHE, [creatorName]);
  return c.json({});
});

// --- Memo Relations ---
memoRoutes.get("/:id/relations", authOptional, async (c) => {
  const id = c.req.param("id");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);

  const relations = await relationDB.listRelations(c.env.DB, memo.id);
  return c.json({ relations });
});

memoRoutes.patch("/:id/relations", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ relations: { relatedMemoId: number; type: string }[] }>();
  await relationDB.setRelations(c.env.DB, memo.id, body.relations || []);
  const relations = await relationDB.listRelations(c.env.DB, memo.id);
  return c.json({ relations });
});

// --- Memo Comments ---
memoRoutes.post("/:id/comments", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const parentMemo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!parentMemo) return c.json({ error: "Memo not found" }, 404);

  const body = await c.req.json();
  const uid = generateUid();
  const payload = {
    ...parseMemoPayload(body.content || ""),
    ...(body.location ? { location: body.location } : {}),
  };

  const comment = await memoDB.createMemo(c.env.DB, {
    uid,
    creatorId: user.id,
    content: body.content || "",
    visibility: body.visibility || parentMemo.visibility,
    payload: JSON.stringify({
      ...payload,
      parent: `memos/${parentMemo.uid}`,
    }),
  });

  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    await setMemoAttachments(c.env.DB, comment.id, user, body.attachments);
  }

  await relationDB.createRelation(c.env.DB, {
    memoId: parentMemo.id,
    relatedMemoId: comment.id,
    type: "COMMENT",
  });

  if (parentMemo.creator_id !== user.id) {
    const message = JSON.stringify({
      type: "MEMO_COMMENT",
      memo: `memos/${comment.uid}`,
      relatedMemo: `memos/${parentMemo.uid}`,
      memoSnippet: comment.content.slice(0, 150),
      relatedMemoSnippet: parentMemo.content.slice(0, 150),
    });
    await c.env.DB.prepare(
      "INSERT INTO inbox (sender_id, receiver_id, status, message) VALUES (?, ?, ?, ?)"
    ).bind(user.id, parentMemo.creator_id, "UNREAD", message).run();
  }

  await invalidateMemoDerivedCaches(c.env.CACHE, [user.username]);
  return c.json(await enrichMemo(c.env.DB, comment, user.username), 201);
});

memoRoutes.get("/:id/comments", authOptional, async (c) => {
  const id = c.req.param("id");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);

  const relations = await relationDB.listRelations(c.env.DB, memo.id);
  const commentRelations = relations.filter((r) => r.type === "COMMENT");
  const comments: memoDB.MemoRow[] = [];

  for (const rel of commentRelations) {
    const comment = await memoDB.getMemoById(c.env.DB, rel.related_memo_id);
    if (comment) comments.push(comment);
  }

  const usernameMap = await resolveCreatorUsernames(c.env.DB, comments);
  return c.json({
    memos: await enrichMemos(c.env.DB, comments, usernameMap),
    nextPageToken: "",
    totalSize: comments.length,
  });
});

// --- Memo Reactions ---
memoRoutes.get("/:id/reactions", authOptional, async (c) => {
  const id = c.req.param("id");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);

  const reactions = await getMemoReactions(c.env.DB, memo.uid);
  return c.json({ reactions });
});

memoRoutes.post("/:id/reactions", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);

  const body = await c.req.json<{ reactionType: string }>();
  const reaction = await reactionDB.upsertReaction(c.env.DB, {
    creatorId: user.id,
    contentId: memo.uid,
    reactionType: body.reactionType,
  });
  return c.json(formatReaction(reaction, user.username));
});

memoRoutes.delete("/:id/reactions/:reactionId", authRequired, async (c) => {
  const reactionId = Number(c.req.param("reactionId"));
  const user = c.get("user");

  await reactionDB.deleteReaction(c.env.DB, reactionId, user.id);
  return c.json({});
});

// --- Memo Shares ---
memoRoutes.get("/:id/shares", authOptional, async (c) => {
  const id = c.req.param("id");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);

  const shares = await shareDB.listShares(c.env.DB, memo.id);
  return c.json({ shares: shares.map((s) => formatShare(s, memo.uid)) });
});

memoRoutes.post("/:id/shares", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ expiresTs?: number }>();
  const share = await shareDB.createShare(c.env.DB, {
    memoId: memo.id,
    creatorId: user.id,
    expiresTs: body.expiresTs,
  });
  return c.json(formatShare(share, memo.uid));
});

memoRoutes.delete("/:id/shares/:shareId", authRequired, async (c) => {
  const shareId = c.req.param("shareId");
  const user = c.get("user");

  await shareDB.deleteShare(c.env.DB, shareId, user.id);
  return c.json({});
});

// --- Memo Attachments ---
memoRoutes.get("/:id/attachments", authOptional, async (c) => {
  const id = c.req.param("id");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);

  const attachments = await getMemoAttachments(c.env.DB, memo.id, memo.uid);
  return c.json({ attachments });
});

memoRoutes.patch("/:id/attachments", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ attachmentIds?: Array<number | string>; attachments?: unknown[] }>();
  await setMemoAttachments(c.env.DB, memo.id, user, body.attachments || body.attachmentIds || []);

  return c.json({});
});

// --- Get memo by share token ---
memoRoutes.get("/shares/:token", async (c) => {
  const token = c.req.param("token");
  const share = await shareDB.getShareByUid(c.env.DB, token);

  if (!share) {
    return c.json({ error: "Share not found" }, 404);
  }

  if (share.expires_ts && share.expires_ts < Math.floor(Date.now() / 1000)) {
    return c.json({ error: "Share expired" }, 410);
  }

  const memo = await memoDB.getMemoById(c.env.DB, share.memo_id);
  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }

  const creatorUser = await c.env.DB.prepare("SELECT username FROM user WHERE id = ?").bind(memo.creator_id).first<{ username: string }>();
  return c.json(await enrichMemo(c.env.DB, memo, creatorUser?.username));
});

// --- Link metadata ---
memoRoutes.get("/-/linkMetadata", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "URL required" }, 400);

  return c.json(await getLinkMetadata(c.env, url));
});

memoRoutes.post("/-/linkMetadata\\:batchGet", async (c) => {
  const body = await c.req.json<{ urls: string[] }>();
  const urls = body.urls || [];

  const linkMetadata = await Promise.all(
    urls.map((url) => getLinkMetadata(c.env, url, true)),
  );

  return c.json({ linkMetadata });
});
