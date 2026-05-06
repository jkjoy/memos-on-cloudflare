import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, UserPayload } from "../types";
import { createAccessToken, createRefreshToken, verifyRefreshToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { authRequired } from "../middleware/auth";
import { findUserByUsername, findUserById, createUser, countUsers } from "../db/user";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";

type AuthApp = { Bindings: Env; Variables: { user: UserPayload } };

export const authRoutes = new Hono<AuthApp>();

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

authRoutes.post("/signin", async (c) => {
  const body = await c.req.json();

  // Support both flat format and proto-style credentials format
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

  const user = await findUserByUsername(c.env.DB, username);
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

  const userPayload: UserPayload = {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.row_status,
  };

  const { token: accessToken, expiresAt } = await createAccessToken(userPayload, c.env.JWT_SECRET);
  const tokenId = crypto.randomUUID();
  const { token: refreshToken } = await createRefreshToken(userPayload, tokenId, c.env.JWT_SECRET);

  setCookie(c, "memos_refresh", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return c.json({
    accessToken,
    expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      nickname: user.nickname,
      email: user.email,
      avatarUrl: user.avatar_url,
      description: user.description,
      createTime: new Date(user.created_ts * 1000).toISOString(),
      updateTime: new Date(user.updated_ts * 1000).toISOString(),
    },
  });
});

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

  setCookie(c, "memos_refresh", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return c.json({
    accessToken,
    expiresAt,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      nickname: "",
      email: "",
      avatarUrl: "",
      description: "",
      createTime: new Date(user.created_ts * 1000).toISOString(),
      updateTime: new Date(user.updated_ts * 1000).toISOString(),
    },
  });
});

authRoutes.post("/signout", async (c) => {
  deleteCookie(c, "memos_refresh", { path: "/" });
  return c.json({});
});

authRoutes.post("/refresh", async (c) => {
  const refreshToken = getCookie(c, "memos_refresh");
  if (!refreshToken) {
    return c.json({ error: "No refresh token" }, 401);
  }

  try {
    const claims = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
    const user = await findUserById(c.env.DB, Number(claims.sub));
    if (!user || user.row_status !== "NORMAL") {
      return c.json({ error: "User not found or archived" }, 401);
    }

    const userPayload: UserPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.row_status,
    };

    const { token: accessToken, expiresAt } = await createAccessToken(userPayload, c.env.JWT_SECRET);
    return c.json({ accessToken, expiresAt });
  } catch {
    deleteCookie(c, "memos_refresh", { path: "/" });
    return c.json({ error: "Invalid refresh token" }, 401);
  }
});

authRoutes.get("/me", authRequired, async (c) => {
  const currentUser = c.get("user");
  const user = await findUserById(c.env.DB, currentUser.id);
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    id: user.id,
    username: user.username,
    role: user.role,
    nickname: user.nickname,
    email: user.email,
    avatarUrl: user.avatar_url,
    description: user.description,
    rowStatus: user.row_status,
    createTime: new Date(user.created_ts * 1000).toISOString(),
    updateTime: new Date(user.updated_ts * 1000).toISOString(),
  });
});
