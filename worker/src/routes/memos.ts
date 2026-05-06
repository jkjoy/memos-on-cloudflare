import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired, authOptional } from "../middleware/auth";
import * as memoDB from "../db/memo";
import * as relationDB from "../db/relation";
import * as reactionDB from "../db/reaction";
import * as shareDB from "../db/share";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";

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
    name: `memos/${memo.id}`,
    uid: memo.uid,
    creator: `users/${creatorUsername || memo.creator_id}`,
    creatorId: memo.creator_id,
    createTime: new Date(memo.created_ts * 1000).toISOString(),
    updateTime: new Date(memo.updated_ts * 1000).toISOString(),
    rowStatus: memo.row_status,
    content: memo.content,
    visibility: memo.visibility,
    pinned: memo.pinned === 1,
    tags: payload.tags || [],
    property: payload.property || {},
    location: payload.location || null,
  };
}

async function resolveCreatorUsernames(db: D1Database, memos: memoDB.MemoRow[]): Promise<Map<number, string>> {
  const creatorIds = [...new Set(memos.map((m) => m.creator_id))];
  const usernameMap = new Map<number, string>();
  if (creatorIds.length === 0) return usernameMap;

  for (const id of creatorIds) {
    const user = await db.prepare("SELECT username FROM user WHERE id = ?").bind(id).first<{ username: string }>();
    if (user) usernameMap.set(id, user.username);
  }
  return usernameMap;
}

// Create memo
memoRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const { content, visibility, createTime, updateTime } = body;

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
  const payload = parseMemoPayload(content || "");

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

  return c.json(formatMemo(memo, user.username), 201);
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

    const contentMatch = filter.match(/content\.contains\("([^"]+)"\)/);
    if (contentMatch) opts.contentSearch = contentMatch[1];

    const tagMatch = filter.match(/tag\s*==\s*"([^"]+)"/);
    if (tagMatch) opts.tagSearch = tagMatch[1];

    const pinnedMatch = filter.match(/pinned\s*==\s*(true|false)/);
    if (pinnedMatch) opts.pinned = pinnedMatch[1] === "true";
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
    memos: filtered.map((m) => formatMemo(m, usernameMap.get(m.creator_id))),
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
  return c.json(formatMemo(memo, creatorUser?.username));
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
  return c.json(formatMemo(updated, creatorName));
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

  await memoDB.deleteMemo(c.env.DB, memo.id);
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
  const payload = parseMemoPayload(body.content || "");

  const comment = await memoDB.createMemo(c.env.DB, {
    uid,
    creatorId: user.id,
    content: body.content || "",
    visibility: body.visibility || parentMemo.visibility,
    payload: JSON.stringify(payload),
  });

  await relationDB.createRelation(c.env.DB, {
    memoId: parentMemo.id,
    relatedMemoId: comment.id,
    type: "COMMENT",
  });

  return c.json(formatMemo(comment, user.username), 201);
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
  return c.json({ memos: comments.map((m) => formatMemo(m, usernameMap.get(m.creator_id))) });
});

// --- Memo Reactions ---
memoRoutes.get("/:id/reactions", authOptional, async (c) => {
  const id = c.req.param("id");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);

  const reactions = await reactionDB.listReactions(c.env.DB, memo.uid);
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
  return c.json(reaction);
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
  return c.json({ shares });
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
  return c.json(share);
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

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM attachment WHERE memo_id = ?"
  ).bind(memo.id).all();

  return c.json({ attachments: results });
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

  const body = await c.req.json<{ attachmentIds: number[] }>();
  const ids = body.attachmentIds || [];

  // Clear existing memo_id references
  await c.env.DB.prepare("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?").bind(memo.id).run();

  // Set new references
  for (const attId of ids) {
    await c.env.DB.prepare("UPDATE attachment SET memo_id = ? WHERE id = ? AND creator_id = ?")
      .bind(memo.id, attId, user.id).run();
  }

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
  return c.json(formatMemo(memo, creatorUser?.username));
});

// --- Link metadata ---
memoRoutes.get("/-/linkMetadata", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "URL required" }, 400);

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "cfmemos-bot/1.0" },
      redirect: "follow",
    });
    const html = await resp.text();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const imageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

    return c.json({
      title: titleMatch?.[1]?.trim() || "",
      description: descMatch?.[1]?.trim() || "",
      image: imageMatch?.[1]?.trim() || "",
    });
  } catch {
    return c.json({ title: "", description: "", image: "" });
  }
});
