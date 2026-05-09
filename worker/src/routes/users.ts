import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired, authOptional } from "../middleware/auth";
import * as userDB from "../db/user";
import * as settingDB from "../db/setting";
import * as memoDB from "../db/memo";
import * as webhookDB from "../db/webhook";
import { hashPassword } from "../auth/password";
import { generatePAT, hashPAT } from "../auth/pat";
import { exchangeOAuthCode } from "../auth/oauth";
import { createErrorBody } from "../error";
import { buildIdentityProviderName, extractIdentityProviderUid } from "../idp";
import { deleteCachedKeys, getCachedJson, putCachedJson } from "../cache";

type UserApp = { Bindings: Env; Variables: { user: UserPayload } };

export const userRoutes = new Hono<UserApp>();

const getGeneralSetting = async (db: D1Database) => {
  const setting = await settingDB.getInstanceSetting(db, "GENERAL");
  if (!setting) {
    return {};
  }
  try {
    return JSON.parse(setting.value) || {};
  } catch {
    return {};
  }
};

export function formatUser(user: userDB.UserRow) {
  return {
    name: `users/${user.username}`,
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.nickname,
    nickname: user.nickname,
    email: user.email,
    avatarUrl: user.avatar_url,
    description: user.description,
    rowStatus: user.row_status,
    createTime: new Date(user.created_ts * 1000).toISOString(),
    updateTime: new Date(user.updated_ts * 1000).toISOString(),
  };
}

function formatPersonalAccessToken(username: string, token: {
  hash: string;
  description?: string;
  createdAt?: string;
  expiresAt?: string | null;
  lastUsedAt?: string;
}) {
  return {
    name: `users/${username}/personalAccessTokens/${token.hash}`,
    description: token.description || "",
    createdAt: token.createdAt || new Date().toISOString(),
    expiresAt: token.expiresAt || undefined,
    lastUsedAt: token.lastUsedAt || undefined,
    hash: token.hash,
  };
}

// List users
userRoutes.get("/", authOptional, async (c) => {
  const users = await userDB.listUsers(c.env.DB, { rowStatus: "NORMAL" });
  return c.json({ users: users.map(formatUser), nextPageToken: "", totalSize: users.length });
});

// Batch get users
userRoutes.post("/:batchGet", async (c) => {
  const action = c.req.param("batchGet");
  if (action !== "batchGet") return c.notFound();

  const body = await c.req.json<{ usernames: string[] }>();
  const users: userDB.UserRow[] = [];
  for (const username of body.usernames || []) {
    const user = await userDB.findUserByUsername(c.env.DB, username);
    if (user) users.push(user);
  }
  return c.json({ users: users.map(formatUser) });
});

// Get user stats
userRoutes.get("/:username/stats", authOptional, async (c) => {
  const username = c.req.param("username");
  const cacheKey = `user:stats:${username}`;
  const cached = await getCachedJson(c.env.CACHE, cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);

  const { results: memos } = await c.env.DB.prepare(
    "SELECT created_ts, payload, pinned FROM memo WHERE creator_id = ? AND row_status = 'NORMAL'"
  ).bind(user.id).all<{ created_ts: number; payload: string; pinned: number }>();

  const tagCounts: Record<string, number> = {};
  let linkCount = 0, codeCount = 0, todoCount = 0, undoCount = 0;
  const pinnedMemos: number[] = [];

  for (const m of memos) {
    const payload = JSON.parse(m.payload || "{}");
    if (payload.tags) {
      for (const tag of payload.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    if (payload.property?.hasLink) linkCount++;
    if (payload.property?.hasCode) codeCount++;
    if (payload.property?.hasTaskList) todoCount++;
    if (payload.property?.hasIncompleteTask) undoCount++;
    if (m.pinned) pinnedMemos.push(m.created_ts);
  }

  const response = {
    name: `users/${username}/stats`,
    memoCount: memos.length,
    tagCount: tagCounts,
    memoTypeStats: { linkCount, codeCount, todoCount, undoCount },
    pinnedMemos,
    memoDisplayTimestamps: memos.map((m) => m.created_ts),
  };

  await putCachedJson(c.env.CACHE, cacheKey, response, 60);
  return c.json(response);
});

// Get all user stats
userRoutes.get("/:action", async (c) => {
  const action = c.req.param("action");
  if (action === "stats") {
    const cached = await getCachedJson(c.env.CACHE, "user:stats:all");
    if (cached) {
      return c.json(cached);
    }

    const users = await userDB.listUsers(c.env.DB);
    const stats = [];
    for (const user of users) {
      const { results: memos } = await c.env.DB.prepare(
        "SELECT payload FROM memo WHERE creator_id = ? AND row_status = 'NORMAL'"
      ).bind(user.id).all<{ payload: string }>();

      const tagCount: Record<string, number> = {};
      for (const m of memos) {
        const payload = JSON.parse(m.payload || "{}");
        if (payload.tags) {
          for (const tag of payload.tags) {
            tagCount[tag] = (tagCount[tag] || 0) + 1;
          }
        }
      }

      stats.push({
        name: `users/${user.username}/stats`,
        username: user.username,
        memoCount: memos.length,
        tagCount,
      });
    }
    const response = { stats };
    await putCachedJson(c.env.CACHE, "user:stats:all", response, 60);
    return c.json(response);
  }

  // Get user by username (or numeric ID as fallback)
  const username = action;
  let user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user && /^\d+$/.test(username)) {
    user = await c.env.DB.prepare("SELECT * FROM user WHERE id = ?").bind(Number(username)).first<userDB.UserRow>();
  }
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json(formatUser(user));
});

// Create user (admin, or self-registration when allowed)
userRoutes.post("/", async (c) => {
  const userCount = await userDB.countUsers(c.env.DB);

  // First user is always allowed (becomes admin)
  if (userCount === 0) {
    const body = await c.req.json();
    const userData = body.user || body;
    const username = userData.username;
    const password = userData.password;

    if (!username || !password) {
      return c.json({ error: "Username and password required" }, 400);
    }

    const passwordHash = await hashPassword(password);
    const user = await userDB.createUser(c.env.DB, { username, passwordHash, role: "ADMIN" });
    await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all"]);
    return c.json(formatUser(user), 201);
  }

  // Check if self-registration is allowed
  const generalSetting = await getGeneralSetting(c.env.DB);
  const disallowRegistration = generalSetting.disallowUserRegistration === true;
  const disallowPasswordAuth = generalSetting.disallowPasswordAuth === true;

  // Check auth header
  const authHeader = c.req.header("Authorization");
  let isAdmin = false;

  if (authHeader?.startsWith("Bearer ")) {
    const { verifyAccessToken } = await import("../auth/jwt");
    try {
      const claims = await verifyAccessToken(authHeader.slice(7), c.env.JWT_SECRET);
      isAdmin = claims.role === "ADMIN";
    } catch {}
  }

  // Admin can always create users; non-admin can self-register if allowed
  if (!isAdmin && (disallowRegistration || disallowPasswordAuth)) {
    return c.json(createErrorBody("User registration is disabled", { errorKey: "message.user-registration-disabled" }), 403);
  }

  const body = await c.req.json();
  const userData = body.user || body;
  const username = userData.username;
  const password = userData.password;

  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const existing = await userDB.findUserByUsername(c.env.DB, username);
  if (existing) return c.json({ error: "Username taken" }, 409);

  // Only admin can create admin users
  const role = isAdmin && userData.role === 2 ? "ADMIN" : "USER";
  const passwordHash = await hashPassword(password);
  const user = await userDB.createUser(c.env.DB, { username, passwordHash, role });
  await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all"]);

  return c.json(formatUser(user), 201);
});

// Update user
userRoutes.patch("/:username", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);

  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json();
  const updateData: Parameters<typeof userDB.updateUser>[2] = {};

  const generalSetting = await getGeneralSetting(c.env.DB);

  if (body.nickname !== undefined || body.displayName !== undefined) {
    if (user.id === currentUser.id && currentUser.role !== "ADMIN" && generalSetting.disallowChangeNickname === true) {
      return c.json(createErrorBody("Changing nickname is disabled", { errorKey: "message.nickname-change-disabled" }), 403);
    }
    updateData.nickname = body.nickname ?? body.displayName;
  }
  if (body.email !== undefined) updateData.email = body.email;
  if (body.avatarUrl !== undefined) updateData.avatar_url = body.avatarUrl;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.password) updateData.password_hash = await hashPassword(body.password);
  if (body.role && currentUser.role === "ADMIN") updateData.role = body.role;
  if (body.rowStatus !== undefined) updateData.row_status = body.rowStatus;
  if (body.username !== undefined) {
    if (currentUser.role === "ADMIN") {
      updateData.username = body.username;
    } else if (user.id === currentUser.id) {
      if (generalSetting.disallowChangeUsername === true) {
        return c.json(createErrorBody("Changing username is disabled", { errorKey: "message.username-change-disabled" }), 403);
      }
      if (body.username !== user.username) {
        return c.json(createErrorBody("Changing username requires admin privileges", { errorKey: "message.username-change-admin-only" }), 403);
      }
    }
  }

  const updated = await userDB.updateUser(c.env.DB, user.id, updateData);
  if (!updated) return c.json({ error: "Update failed" }, 500);
  await deleteCachedKeys(c.env.CACHE, [
    "instance:profile",
    "user:stats:all",
    `user:stats:${user.username}`,
    `user:stats:${updated.username}`,
  ]);

  return c.json(formatUser(updated));
});

// Delete user
userRoutes.delete("/:username", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);

  await userDB.deleteUser(c.env.DB, user.id);
  await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all", `user:stats:${user.username}`]);
  return c.json({});
});

// --- User Settings ---
userRoutes.get("/:username/settings", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const settings = await settingDB.listUserSettings(c.env.DB, user.id);
  return c.json({ settings });
});

userRoutes.get("/:username/settings/:key", authRequired, async (c) => {
  const username = c.req.param("username");
  const key = c.req.param("key");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, key);
  return c.json({ setting: setting || { key, value: "" } });
});

userRoutes.patch("/:username/settings/:key", authRequired, async (c) => {
  const username = c.req.param("username");
  const key = c.req.param("key");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ value: any }>();
  const newValue = typeof body.value === "string" ? JSON.parse(body.value) : (body.value || {});

  // Merge with existing setting value
  const existing = await settingDB.getUserSetting(c.env.DB, user.id, key);
  let merged = newValue;
  if (existing) {
    try {
      const existingValue = JSON.parse(existing.value);
      merged = { ...existingValue, ...newValue };
    } catch {
      merged = newValue;
    }
  }

  const valueStr = JSON.stringify(merged);
  await settingDB.setUserSetting(c.env.DB, user.id, key, valueStr);
  return c.json({ setting: { key, value: valueStr } });
});

// --- Personal Access Tokens ---
userRoutes.get("/:username/personalAccessTokens", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  const tokens = setting ? JSON.parse(setting.value) : [];
  return c.json({
    personalAccessTokens: tokens.map((token: {
      hash: string;
      description?: string;
      createdAt?: string;
      expiresAt?: string | null;
      lastUsedAt?: string;
    }) => formatPersonalAccessToken(username, token)),
    nextPageToken: "",
    totalSize: tokens.length,
  });
});

userRoutes.post("/:username/personalAccessTokens", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  let body: { description?: string; expiresAt?: string; expiresInDays?: number } = {};
  try { body = await c.req.json(); } catch {}
  const token = generatePAT();
  const hash = await hashPAT(token);

  let expiresAt = body.expiresAt || null;
  if (!expiresAt && body.expiresInDays && body.expiresInDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + body.expiresInDays);
    expiresAt = d.toISOString();
  }

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  const tokens = setting ? JSON.parse(setting.value) : [];
  const tokenRecord = {
    hash,
    description: body.description || "",
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  tokens.push(tokenRecord);

  await settingDB.setUserSetting(c.env.DB, user.id, "personal_access_tokens", JSON.stringify(tokens));

  return c.json({
    token,
    description: body.description || "",
    personalAccessToken: formatPersonalAccessToken(username, tokenRecord),
  });
});

userRoutes.delete("/:username/personalAccessTokens/:tokenHash", authRequired, async (c) => {
  const username = c.req.param("username");
  const tokenHash = c.req.param("tokenHash");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  if (setting) {
    const tokens = JSON.parse(setting.value).filter((t: { hash: string }) => t.hash !== tokenHash);
    await settingDB.setUserSetting(c.env.DB, user.id, "personal_access_tokens", JSON.stringify(tokens));
  }

  return c.json({});
});

// --- Linked Identities ---
userRoutes.get("/:username/linkedIdentities", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM user_identity WHERE user_id = ?"
  ).bind(user.id).all<{ id: number; user_id: number; provider: string; extern_uid: string }>();

  const linkedIdentities = (results || []).map((row) => ({
    name: `users/${username}/linkedIdentities/${row.id}`,
    idpName: buildIdentityProviderName(row.provider),
    externUid: row.extern_uid,
  }));

  return c.json({ linkedIdentities });
});

userRoutes.post("/:username/linkedIdentities", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ idpName?: string; code?: string; redirectUri?: string; codeVerifier?: string }>();
  const idpUid = extractIdentityProviderUid(body.idpName);
  if (!idpUid || !body.code) {
    return c.json({ error: "Missing IDP name or authorization code" }, 400);
  }

  let oauthUser;
  try {
    oauthUser = await exchangeOAuthCode(c.env.DB, idpUid, body.code, body.redirectUri || "", body.codeVerifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to link identity provider";
    console.error("Failed to exchange OAuth code for linked identity:", error);
    const status =
      message.includes("already linked")
        ? 409
        : message.includes("Identity provider not found") ||
            message.includes("configuration is incomplete") ||
            message.includes("Token exchange failed") ||
            message.includes("OAuth error:") ||
            message.includes("No access_token") ||
            message.includes("User info request failed") ||
            message.includes("Could not extract user identifier") ||
            message.includes("does not match the allowed pattern")
          ? 400
          : 500;
    return c.json(createErrorBody(message), status);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM user_identity WHERE provider = ? AND extern_uid = ?"
  ).bind(idpUid, oauthUser.identifier).first<{ id: number }>();
  if (existing) {
    return c.json({ error: "This identity is already linked to another account" }, 409);
  }

  const result = await c.env.DB.prepare(
    "INSERT INTO user_identity (user_id, provider, extern_uid) VALUES (?, ?, ?) RETURNING *"
  ).bind(user.id, idpUid, oauthUser.identifier).first<{ id: number; provider: string; extern_uid: string }>();

  return c.json({
    name: `users/${username}/linkedIdentities/${result!.id}`,
    idpName: buildIdentityProviderName(result!.provider),
    externUid: result!.extern_uid,
  }, 201);
});

userRoutes.delete("/:username/linkedIdentities/:identityId", authRequired, async (c) => {
  const username = c.req.param("username");
  const identityId = c.req.param("identityId");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  await c.env.DB.prepare("DELETE FROM user_identity WHERE id = ? AND user_id = ?")
    .bind(identityId, user.id).run();

  return c.json({});
});

// --- User Notifications ---
userRoutes.get("/:username/notifications", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM inbox WHERE receiver_id = ? ORDER BY created_ts DESC"
  ).bind(user.id).all<{ id: number; created_ts: number; sender_id: number; receiver_id: number; status: string; message: string }>();

  const senderIds = [...new Set((results || []).map((r) => r.sender_id))];
  const senderMap = new Map<number, { username: string; nickname: string; avatar_url: string }>();
  for (const id of senderIds) {
    const sender = await c.env.DB.prepare("SELECT username, nickname, avatar_url FROM user WHERE id = ?")
      .bind(id).first<{ username: string; nickname: string; avatar_url: string }>();
    if (sender) senderMap.set(id, sender);
  }

  const notifications = (results || []).map((row) => {
    const msg = JSON.parse(row.message || "{}");
    const sender = senderMap.get(row.sender_id);
    const statusMap: Record<string, number> = { UNREAD: 1, ARCHIVED: 2 };
    const typeMap: Record<string, number> = { MEMO_COMMENT: 1, MEMO_MENTION: 2 };

    return {
      name: `users/${username}/notifications/${row.id}`,
      sender: sender ? `users/${sender.username}` : "",
      senderUser: sender ? {
        name: `users/${sender.username}`,
        username: sender.username,
        displayName: sender.nickname || sender.username,
        avatarUrl: sender.avatar_url || "",
      } : undefined,
      status: statusMap[row.status] || 0,
      createTime: { seconds: row.created_ts, nanos: 0 },
      type: typeMap[msg.type] || 0,
      payload: msg.type === "MEMO_COMMENT" ? {
        case: "memoComment",
        value: {
          memo: msg.memo || "",
          relatedMemo: msg.relatedMemo || "",
          memoSnippet: msg.memoSnippet || "",
          relatedMemoSnippet: msg.relatedMemoSnippet || "",
        },
      } : msg.type === "MEMO_MENTION" ? {
        case: "memoMention",
        value: {
          memo: msg.memo || "",
          relatedMemo: msg.relatedMemo || "",
          memoSnippet: msg.memoSnippet || "",
          relatedMemoSnippet: msg.relatedMemoSnippet || "",
        },
      } : { case: undefined },
    };
  });

  return c.json({ notifications });
});

userRoutes.patch("/:username/notifications/:notifId", authRequired, async (c) => {
  const notifId = Number(c.req.param("notifId"));
  const currentUser = c.get("user");
  const body = await c.req.json<{ status: string | number }>();

  const statusMap: Record<number, string> = { 1: "UNREAD", 2: "ARCHIVED" };
  const status = typeof body.status === "number" ? (statusMap[body.status] || "UNREAD") : body.status;

  await c.env.DB.prepare("UPDATE inbox SET status = ? WHERE id = ? AND receiver_id = ?")
    .bind(status, notifId, currentUser.id).run();

  return c.json({});
});

userRoutes.delete("/:username/notifications/:notifId", authRequired, async (c) => {
  const notifId = Number(c.req.param("notifId"));
  const currentUser = c.get("user");

  await c.env.DB.prepare("DELETE FROM inbox WHERE id = ? AND receiver_id = ?")
    .bind(notifId, currentUser.id).run();

  return c.json({});
});

// --- Webhooks ---
function formatWebhook(webhook: webhookDB.WebhookRow, username: string) {
  return {
    name: `users/${username}/webhooks/${webhook.id}`,
    url: webhook.url,
    displayName: webhook.display_name,
    createTime: new Date(webhook.created_ts * 1000).toISOString(),
    updateTime: new Date(webhook.updated_ts * 1000).toISOString(),
  };
}

userRoutes.get("/:username/webhooks", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const webhooks = await webhookDB.listWebhooksByCreatorId(c.env.DB, user.id);
  return c.json({ webhooks: webhooks.map((w) => formatWebhook(w, username)) });
});

userRoutes.post("/:username/webhooks", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ url?: string; displayName?: string }>();
  if (!body.url) return c.json({ error: "url is required" }, 400);

  const webhook = await webhookDB.createWebhook(c.env.DB, {
    creatorId: user.id,
    url: body.url,
    displayName: body.displayName || "",
  });
  return c.json(formatWebhook(webhook, username), 201);
});

userRoutes.patch("/:username/webhooks/:webhookId", authRequired, async (c) => {
  const username = c.req.param("username");
  const webhookId = Number(c.req.param("webhookId"));
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const existing = await webhookDB.getWebhookById(c.env.DB, webhookId);
  if (!existing || existing.creator_id !== user.id) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  const body = await c.req.json<{ url?: string; displayName?: string }>();
  const updateData: Partial<{ url: string; display_name: string }> = {};
  if (body.url !== undefined) updateData.url = body.url;
  if (body.displayName !== undefined) updateData.display_name = body.displayName;

  const updated = await webhookDB.updateWebhook(c.env.DB, webhookId, updateData);
  if (!updated) return c.json({ error: "Update failed" }, 500);
  return c.json(formatWebhook(updated, username));
});

userRoutes.delete("/:username/webhooks/:webhookId", authRequired, async (c) => {
  const username = c.req.param("username");
  const webhookId = Number(c.req.param("webhookId"));
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const existing = await webhookDB.getWebhookById(c.env.DB, webhookId);
  if (!existing || existing.creator_id !== user.id) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  await webhookDB.deleteWebhook(c.env.DB, webhookId);
  return c.json({});
});
