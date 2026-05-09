import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import * as userDB from "../db/user";
import { getAppVersion } from "../version";
import { deleteCachedKeys, getCachedJson, putCachedJson } from "../cache";

type InstApp = { Bindings: Env; Variables: { user: UserPayload } };

export const instanceRoutes = new Hono<InstApp>();

// Get instance profile
instanceRoutes.get("/profile", async (c) => {
  const cached = await getCachedJson(c.env.CACHE, "instance:profile");
  if (cached) {
    return c.json(cached);
  }

  const userCount = await userDB.countUsers(c.env.DB);
  const generalSetting = await settingDB.getInstanceSetting(c.env.DB, "GENERAL");
  let profile = {};
  if (generalSetting) {
    try {
      profile = JSON.parse(generalSetting.value)?.customProfile || {};
    } catch {
      profile = {};
    }
  } else {
    const legacyCustomProfile = await settingDB.getSystemSetting(c.env.DB, "instance_profile");
    if (legacyCustomProfile) {
      try {
        profile = JSON.parse(legacyCustomProfile.value);
      } catch {
        profile = {};
      }
    }
  }

  let admin = undefined;
  if (userCount > 0) {
    const adminUser = await c.env.DB.prepare(
      "SELECT * FROM user WHERE role = 'ADMIN' ORDER BY created_ts ASC LIMIT 1"
    ).first<any>();
    if (adminUser) {
      admin = {
        name: `users/${adminUser.username}`,
        username: adminUser.username,
        nickname: adminUser.nickname,
        role: 2,
      };
    }
  }

  const response = {
    version: getAppVersion(c.env),
    mode: "prod",
    admin,
    ...profile,
  };

  await putCachedJson(c.env.CACHE, "instance:profile", response, 600);
  return c.json(response);
});

// List instance settings
instanceRoutes.get("/settings", async (c) => {
  const cached = await getCachedJson(c.env.CACHE, "instance:settings");
  if (cached) {
    return c.json(cached);
  }

  const settings = await settingDB.listSystemSettings(c.env.DB);
  const response = {
    settings: settings.map((setting) => ({
      ...setting,
      name: settingDB.normalizeInstanceSettingName(setting.name),
    })),
  };

  await putCachedJson(c.env.CACHE, "instance:settings", response, 300);
  return c.json(response);
});

// Get instance setting
instanceRoutes.get("/settings/*", async (c) => {
  const fullPath = c.req.path;
  const name = settingDB.normalizeInstanceSettingName(fullPath.replace("/api/v1/instance/settings/", ""));
  const cacheKey = `instance:setting:${name}`;
  const cached = await getCachedJson(c.env.CACHE, cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const setting = await settingDB.getInstanceSetting(c.env.DB, name);
  if (!setting) {
    const response = { name, value: "{}" };
    await putCachedJson(c.env.CACHE, cacheKey, response, 300);
    return c.json(response);
  }
  const response = { name: setting.name, value: setting.value };
  await putCachedJson(c.env.CACHE, cacheKey, response, 300);
  return c.json(response);
});

// Test email setting via Resend (admin only)
instanceRoutes.post("/settings/notification\\:testEmail", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const body = await c.req.json<{ email?: { apiKey?: string; fromEmail?: string; fromName?: string }; recipientEmail?: string }>();

  let apiKey = body.email?.apiKey;
  let fromEmail = body.email?.fromEmail;
  let fromName = body.email?.fromName;

  if (!apiKey || !fromEmail) {
    const setting = await settingDB.getInstanceSetting(c.env.DB, "NOTIFICATION");
    if (setting) {
      const parsed = JSON.parse(setting.value);
      const email = parsed.email || {};
      if (!apiKey) apiKey = email.apiKey;
      if (!fromEmail) fromEmail = email.fromEmail;
      if (!fromName) fromName = email.fromName;
    }
  }

  if (!apiKey || !fromEmail) {
    return c.json({ error: "Resend API key and from email are required" }, 400);
  }

  const recipientEmail = body.recipientEmail;
  if (!recipientEmail) {
    return c.json({ error: "Recipient email is required" }, 400);
  }

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [recipientEmail],
      subject: "Test email from Memos",
      html: "<p>This is a test email sent from your Memos instance to verify the email configuration.</p>",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: `Resend API error: ${err}` }, 502);
  }

  return c.json({});
});

// Update instance setting (admin only)
instanceRoutes.patch("/settings/*", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const fullPath = c.req.path;
  const name = settingDB.normalizeInstanceSettingName(fullPath.replace("/api/v1/instance/settings/", ""));
  const body = await c.req.json<{ value: string; description?: string }>();
  await settingDB.setSystemSetting(c.env.DB, name, body.value, body.description);
  await deleteCachedKeys(c.env.CACHE, [
    "instance:profile",
    "instance:settings",
    `instance:setting:${name}`,
  ]);
  return c.json({ name, value: body.value });
});

instanceRoutes.get("/stats", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const cached = await getCachedJson(c.env.CACHE, "instance:stats");
  if (cached) {
    return c.json(cached);
  }

  const storageRow = await c.env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachment").first<{ total: number }>();
  const localStorageBytes = storageRow?.total ?? 0;

  let databaseSize = -1;
  try {
    const pageCountRow = await c.env.DB.prepare("PRAGMA page_count").first<{ page_count?: number; pageCount?: number }>();
    const pageSizeRow = await c.env.DB.prepare("PRAGMA page_size").first<{ page_size?: number; pageSize?: number }>();
    const pageCount = pageCountRow?.page_count ?? pageCountRow?.pageCount ?? 0;
    const pragmaPageSize = pageSizeRow?.page_size ?? pageSizeRow?.pageSize ?? 0;
    if (pageCount > 0 && pragmaPageSize > 0) {
      databaseSize = pageCount * pragmaPageSize;
    }
  } catch {
    databaseSize = -1;
  }

  const response = {
    database: {
      driver: "cloudflare-d1",
      sizeBytes: databaseSize,
    },
    localStorageBytes,
    generatedTime: {
      seconds: Math.floor(Date.now() / 1000),
      nanos: 0,
    },
  };

  await putCachedJson(c.env.CACHE, "instance:stats", response, 60);
  return c.json(response);
});
