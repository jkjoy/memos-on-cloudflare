import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, UserPayload } from "../types";
import { createAccessToken, createRefreshToken, verifyRefreshToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { exchangeOAuthCode } from "../auth/oauth";
import { authRequired } from "../middleware/auth";
import { findUserByUsername, findUserById, createUser, countUsers } from "../db/user";
import type { UserRow } from "../db/user";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";
import { extractIdentityProviderUid } from "../idp";
import { formatUser } from "./users";

type AuthApp = { Bindings: Env; Variables: { user: UserPayload } };

export const authRoutes = new Hono<AuthApp>();

const REFRESH_COOKIE_NAME = "memos_refresh";
const SESSION_HINT_COOKIE_NAME = "memos_session_hint";
const SESSION_COOKIE_PATH = "/";
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const SESSION_COOKIE_OPTIONS = {
  secure: true,
  sameSite: "Lax" as const,
  path: SESSION_COOKIE_PATH,
};

function setSessionCookies(c: any, refreshToken: string) {
  setCookie(c, REFRESH_COOKIE_NAME, refreshToken, {
    ...SESSION_COOKIE_OPTIONS,
    httpOnly: true,
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
  setCookie(c, SESSION_HINT_COOKIE_NAME, "1", {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
}

function clearSessionCookies(c: any) {
  deleteCookie(c, REFRESH_COOKIE_NAME, { path: SESSION_COOKIE_PATH });
  deleteCookie(c, SESSION_HINT_COOKIE_NAME, { path: SESSION_COOKIE_PATH });
}

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

function toISODateTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

async function buildCurrentUserResponse(db: D1Database, userId: number) {
  const user = await findUserById(db, userId);
  if (!user) {
    return null;
  }

  const formattedUser = formatUser(user);
  return {
    user: formattedUser,
    ...formattedUser,
  };
}

authRoutes.post("/signin", async (c) => {
  const body = await c.req.json();

  let user: Awaited<ReturnType<typeof findUserByUsername>>;

  if (body.credentials?.case === "ssoCredentials") {
    const { idpName, code, redirectUri, codeVerifier } = body.credentials.value;
    const idpUid = extractIdentityProviderUid(idpName);
    if (!idpUid || !code) {
      return c.json({ error: "Missing IDP name or authorization code" }, 400);
    }

    let oauthUser;
    try {
      oauthUser = await exchangeOAuthCode(c.env.DB, idpUid, code, redirectUri, codeVerifier);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to authenticate with identity provider";
      console.error("Failed to exchange OAuth code during sign-in:", error);
      const status =
        message.includes("Identity provider not found") ||
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

    const identity = await c.env.DB.prepare(
      "SELECT * FROM user_identity WHERE provider = ? AND extern_uid = ?"
    ).bind(idpUid, oauthUser.identifier).first<{ user_id: number }>();

    if (identity) {
      user = await findUserById(c.env.DB, identity.user_id);
    } else {
      let username = sanitizeUsername(oauthUser.identifier);
      const existing = await findUserByUsername(c.env.DB, username);
      if (existing) {
        username = username + "_" + crypto.randomUUID().slice(0, 6);
      }

      const userCount = await countUsers(c.env.DB);
      const role = userCount === 0 ? "ADMIN" : "USER";
      const randomPassword = await hashPassword(crypto.randomUUID());

      user = await createUser(c.env.DB, { username, passwordHash: randomPassword, role });

      if (oauthUser.email || oauthUser.displayName || oauthUser.avatarUrl) {
        const updates: string[] = [];
        const params: string[] = [];
        if (oauthUser.email) { updates.push("email = ?"); params.push(oauthUser.email); }
        if (oauthUser.displayName) { updates.push("nickname = ?"); params.push(oauthUser.displayName); }
        if (oauthUser.avatarUrl) { updates.push("avatar_url = ?"); params.push(oauthUser.avatarUrl); }
        if (updates.length > 0) {
          await c.env.DB.prepare(`UPDATE user SET ${updates.join(", ")} WHERE id = ?`).bind(...params, user!.id).run();
          user = await findUserById(c.env.DB, user!.id);
        }
      }

      await c.env.DB.prepare(
        "INSERT INTO user_identity (user_id, provider, extern_uid) VALUES (?, ?, ?)"
      ).bind(user!.id, idpUid, oauthUser.identifier).run();
    }

    if (!user) {
      return c.json({ error: "Failed to find or create user" }, 500);
    }
  } else {
    let username: string;
    let password: string;

    if (body.credentials?.value) {
      username = body.credentials.value.username;
      password = body.credentials.value.password;
    } else {
      username = body.username;
      password = body.password;
    }

    if (!username || !password) {
      return c.json({ error: "Username and password required" }, 400);
    }

    const generalSetting = await getGeneralSetting(c.env.DB);
    if (generalSetting.disallowPasswordAuth) {
      return c.json(createErrorBody("Password authentication is disabled", { errorKey: "message.password-auth-disabled" }), 403);
    }

    user = await findUserByUsername(c.env.DB, username);
    if (!user) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    if (user.row_status !== "NORMAL") {
      return c.json({ error: "User is archived" }, 403);
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }
  }

  if (user!.row_status !== "NORMAL") {
    return c.json({ error: "User is archived" }, 403);
  }

  const userPayload: UserPayload = {
    id: user!.id,
    username: user!.username,
    role: user!.role,
    status: user!.row_status,
  };

  const { token: accessToken, expiresAt } = await createAccessToken(userPayload, c.env.JWT_SECRET);
  const tokenId = crypto.randomUUID();
  const { token: refreshToken } = await createRefreshToken(userPayload, tokenId, c.env.JWT_SECRET);

  setSessionCookies(c, refreshToken);

  const formattedUser = formatUser(user! as UserRow);

  return c.json({
    user: formattedUser,
    accessToken,
    expiresAt: toISODateTime(expiresAt),
    expiresAtSeconds: expiresAt,
    accessTokenExpiresAt: toISODateTime(expiresAt),
    ...formattedUser,
  });
});

function sanitizeUsername(identifier: string): string {
  return identifier.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 32) || "user";
}

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  const { username, password } = body;

  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  if (password.length < 6) {
    return c.json({ error: "Password must be at least 6 characters" }, 400);
  }

  const existing = await findUserByUsername(c.env.DB, username);
  if (existing) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const userCount = await countUsers(c.env.DB);
  const role = userCount === 0 ? "ADMIN" : "USER";

  if (userCount > 0) {
    const generalSetting = await getGeneralSetting(c.env.DB);
    if (generalSetting.disallowUserRegistration || generalSetting.disallowPasswordAuth) {
      return c.json(createErrorBody("User registration is disabled", { errorKey: "message.user-registration-disabled" }), 403);
    }
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser(c.env.DB, { username, passwordHash, role });

  const userPayload: UserPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    status: "NORMAL",
  };

  const { token: accessToken, expiresAt } = await createAccessToken(userPayload, c.env.JWT_SECRET);
  const tokenId = crypto.randomUUID();
  const { token: refreshToken } = await createRefreshToken(userPayload, tokenId, c.env.JWT_SECRET);

  setSessionCookies(c, refreshToken);

  const formattedUser = formatUser(user as UserRow);

  return c.json({
    user: formattedUser,
    accessToken,
    expiresAt: toISODateTime(expiresAt),
    expiresAtSeconds: expiresAt,
    accessTokenExpiresAt: toISODateTime(expiresAt),
    ...formattedUser,
  });
});

authRoutes.post("/signout", async (c) => {
  clearSessionCookies(c);
  return c.json({});
});

authRoutes.post("/refresh", async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE_NAME);
  if (!refreshToken) {
    clearSessionCookies(c);
    return c.json({ error: "No refresh token" }, 401);
  }

  try {
    const claims = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
    const user = await findUserById(c.env.DB, Number(claims.sub));
    if (!user || user.row_status !== "NORMAL") {
      clearSessionCookies(c);
      return c.json({ error: "User not found or archived" }, 401);
    }

    const userPayload: UserPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.row_status,
    };

    const { token: accessToken, expiresAt } = await createAccessToken(userPayload, c.env.JWT_SECRET);
    return c.json({
      accessToken,
      expiresAt: toISODateTime(expiresAt),
      expiresAtSeconds: expiresAt,
      accessTokenExpiresAt: toISODateTime(expiresAt),
    });
  } catch {
    clearSessionCookies(c);
    return c.json({ error: "Invalid refresh token" }, 401);
  }
});

authRoutes.get("/me", authRequired, async (c) => {
  const currentUser = c.get("user");
  const response = await buildCurrentUserResponse(c.env.DB, currentUser.id);
  if (!response) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(response);
});

authRoutes.get("/status", authRequired, async (c) => {
  const currentUser = c.get("user");
  const response = await buildCurrentUserResponse(c.env.DB, currentUser.id);
  if (!response) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    ok: true,
    authenticated: true,
    ...response,
  });
});

authRoutes.post("/status", authRequired, async (c) => {
  const currentUser = c.get("user");
  const response = await buildCurrentUserResponse(c.env.DB, currentUser.id);
  if (!response) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    ok: true,
    authenticated: true,
    ...response,
  });
});

authRoutes.get("/sessions/current", authRequired, async (c) => {
  const currentUser = c.get("user");
  const response = await buildCurrentUserResponse(c.env.DB, currentUser.id);
  if (!response) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    session: {
      user: response.user,
    },
    ...response,
  });
});

const methodNotAllowed = (c: any) =>
  c.json({ code: 12, message: "Method Not Allowed", details: [] }, 405);

authRoutes.all("/signin", methodNotAllowed);
authRoutes.all("/signup", methodNotAllowed);
authRoutes.all("/signout", methodNotAllowed);
authRoutes.all("/refresh", methodNotAllowed);
authRoutes.all("/me", methodNotAllowed);
authRoutes.all("/status", methodNotAllowed);
authRoutes.all("/sessions/current", methodNotAllowed);
