import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";
import { deleteCachedKeys } from "../cache";

type AttApp = { Bindings: Env; Variables: { user: UserPayload } };

export const attachmentRoutes = new Hono<AttApp>();

export interface AttachmentRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  filename: string;
  type: string;
  size: number;
  memo_id: number | null;
  storage_type: string;
  reference: string;
  payload: string;
}

const nowTs = () => Math.floor(Date.now() / 1000);

function formatAttachment(att: AttachmentRow) {
  return {
    id: att.id,
    name: `attachments/${att.uid}`,
    uid: att.uid,
    creatorId: att.creator_id,
    createTime: new Date(att.created_ts * 1000).toISOString(),
    updateTime: new Date(att.updated_ts * 1000).toISOString(),
    filename: att.filename,
    type: att.type,
    size: att.size,
    memoId: att.memo_id,
    storageType: att.storage_type,
    reference: att.reference,
  };
}

function decodeBase64Content(content: string): ArrayBuffer {
  const base64 = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function resolveMemoId(db: D1Database, memoName?: string | null): Promise<number | null> {
  if (!memoName) {
    return null;
  }

  const uid = memoName.startsWith("memos/") ? memoName.slice("memos/".length) : memoName;
  const memo = await db.prepare("SELECT id FROM memo WHERE uid = ? OR id = ?")
    .bind(uid, Number(uid) || 0)
    .first<{ id: number }>();
  return memo?.id ?? null;
}

async function findAttachmentByToken(db: D1Database, token: string): Promise<AttachmentRow | null> {
  const normalized = token.startsWith("attachments/") ? token.slice("attachments/".length) : token;
  return db.prepare("SELECT * FROM attachment WHERE uid = ? OR id = ?")
    .bind(normalized, Number(normalized) || 0)
    .first<AttachmentRow>();
}

const DEFAULT_MAX_UPLOAD_SIZE_MB = 100;

const getMaxUploadSizeMb = async (db: D1Database) => {
  const setting = await settingDB.getInstanceSetting(db, "STORAGE");
  if (!setting) {
    return DEFAULT_MAX_UPLOAD_SIZE_MB;
  }
  try {
    const parsed = JSON.parse(setting.value) || {};
    const limit = Number(parsed.uploadSizeLimitMb);
    return limit > 0 ? limit : DEFAULT_MAX_UPLOAD_SIZE_MB;
  } catch {
    return DEFAULT_MAX_UPLOAD_SIZE_MB;
  }
};

// Upload attachment
attachmentRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const contentType = c.req.header("content-type") || "";
  const maxUploadSizeMb = await getMaxUploadSizeMb(c.env.DB);
  const maxUploadSize = maxUploadSizeMb * 1024 * 1024;

  let filename: string;
  let fileType: string;
  let fileData: ArrayBuffer;
  let memoId: number | null = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = (formData.get("file") || formData.get("attachment") || formData.get("content")) as File | null;
    if (!file) return c.json({ error: "No file provided" }, 400);
    if (file.size > maxUploadSize) {
      return c.json(
        createErrorBody(`File too large. Maximum upload size is ${maxUploadSizeMb}MB.`, {
          errorKey: "message.maximum-upload-size-is",
          errorParams: { size: maxUploadSizeMb },
        }),
        413,
      );
    }
    filename = file.name;
    fileType = file.type;
    fileData = await file.arrayBuffer();
    memoId = await resolveMemoId(c.env.DB, formData.get("memo")?.toString() || null);
  } else {
    const body = await c.req.json();
    const attachment = body.attachment || body;
    filename = attachment.filename || "unnamed";
    fileType = attachment.type || "application/octet-stream";
    memoId = await resolveMemoId(c.env.DB, attachment.memo);

    if (attachment.content) {
      fileData = decodeBase64Content(attachment.content);
      if (fileData.byteLength > maxUploadSize) {
        return c.json(
          createErrorBody(`File too large. Maximum upload size is ${maxUploadSizeMb}MB.`, {
            errorKey: "message.maximum-upload-size-is",
            errorParams: { size: maxUploadSizeMb },
          }),
          413,
        );
      }
    } else {
      return c.json({ error: "No content provided" }, 400);
    }
  }

  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const r2Key = `attachments/${uid}/${filename}`;

  // Store in R2
  await c.env.BUCKET.put(r2Key, fileData, {
    httpMetadata: { contentType: fileType },
  });

  // Store metadata in D1
  const createdTs = nowTs();
  const att = await c.env.DB.prepare(
    `INSERT INTO attachment (uid, creator_id, created_ts, updated_ts, filename, type, size, memo_id, storage_type, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'R2', ?) RETURNING *`
  )
    .bind(uid, user.id, createdTs, createdTs, filename, fileType, fileData.byteLength, memoId, r2Key)
    .first<AttachmentRow>();

  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json(formatAttachment(att!), 201);
});

// List attachments
attachmentRoutes.get("/", authRequired, async (c) => {
  const user = c.get("user");
  const pageSize = Math.min(Number(c.req.query("pageSize")) || 50, 1000);
  const pageToken = c.req.query("pageToken");
  const filter = c.req.query("filter") || "";
  let offset = 0;
  if (pageToken) {
    try { offset = Number(atob(pageToken)); } catch {}
  }

  const whereConditions = ["creator_id = ?"];
  const params: (string | number | null)[] = [user.id];

  if (filter.includes("memo_id == null") || filter.includes("memo == null")) {
    whereConditions.push("memo_id IS NULL");
  }

  const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM attachment ${whereClause}`
  ).bind(...params).first<{ total: number }>();
  const total = countResult?.total ?? 0;

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM attachment ${whereClause} ORDER BY created_ts DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all<AttachmentRow>();

  const nextPageToken = offset + pageSize < total ? btoa(String(offset + pageSize)) : "";

  return c.json({
    attachments: results.map(formatAttachment),
    nextPageToken,
    totalSize: total,
  });
});

// Get attachment
attachmentRoutes.get("/:id", async (c) => {
  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  return c.json(formatAttachment(att));
});

// Update attachment
attachmentRoutes.patch("/:id", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ filename?: string; memoId?: number | null }>();

  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  if (att.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (body.filename !== undefined) { updates.push("filename = ?"); params.push(body.filename); }
  if (body.memoId !== undefined) { updates.push("memo_id = ?"); params.push(body.memoId); }

  if (updates.length > 0) {
    updates.push("updated_ts = strftime('%s', 'now')");
    params.push(att.id);
    await c.env.DB.prepare(`UPDATE attachment SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...params).run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM attachment WHERE id = ?")
    .bind(att.id).first<AttachmentRow>();
  return c.json(formatAttachment(updated!));
});

// Delete attachment
attachmentRoutes.delete("/:id", authRequired, async (c) => {
  const user = c.get("user");

  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  if (att.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  // Delete from R2
  if (att.reference) {
    await c.env.BUCKET.delete(att.reference);
  }

  await c.env.DB.prepare("DELETE FROM attachment WHERE id = ?").bind(att.id).run();
  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json({});
});

// Batch delete
attachmentRoutes.post("/:action", authRequired, async (c) => {
  const action = c.req.param("action");
  if (action !== "batchDelete") return c.notFound();

  const user = c.get("user");
  const body = await c.req.json<{ ids?: Array<number | string>; names?: string[] }>();

  for (const reference of body.names || body.ids || []) {
    const att = await findAttachmentByToken(c.env.DB, String(reference));
    if (att && (att.creator_id === user.id || user.role === "ADMIN")) {
      if (att.reference) await c.env.BUCKET.delete(att.reference);
      await c.env.DB.prepare("DELETE FROM attachment WHERE id = ?").bind(att.id).run();
    }
  }

  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json({});
});
