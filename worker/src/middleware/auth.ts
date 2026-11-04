import { createMiddleware } from "hono/factory";
import type { Env, UserPayload } from "../types";
import { verifyAccessToken } from "../auth/jwt";
import { hashPAT } from "../auth/pat";
import { findActiveUserPayload } from "../auth/user";

type AuthEnv = {
  Bindings: Env;
  Variables: { user: UserPayload };
};

type PATLookupResult = {
  user_id: number;
  username: string;
  role: string;
  row_status: string;
};

function extractAuthToken(headers: {
  header: (name: string) => string | undefined;
}): string | undefined {
  const authHeader = headers.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const xApiKey = headers.header("X-API-Key");
  if (xApiKey) {
    return xApiKey;
  }

  const memosAccessToken = headers.header("Memos-Access-Token");
  if (memosAccessToken) {
    return memosAccessToken;
  }

  const token = headers.header("Token");
  if (token) {
    return token;
  }

  return undefined;
}

async function findUserByPATHash(db: D1Database, tokenHash: string): Promise<PATLookupResult | null> {
  const { results } = await db.prepare(
    `SELECT us.user_id, us.value, u.username, u.role, u.row_status
     FROM user_setting us
     JOIN user u ON u.id = us.user_id
     WHERE us.key = 'personal_access_tokens'`
  ).all<{
    user_id: number;
    value: string;
    username: string;
    role: string;
    row_status: string;
  }>();

  for (const row of results || []) {
    try {
      if (row.row_status !== "NORMAL") {
        continue;
      }

      const tokens = JSON.parse(row.value || "[]") as Array<{ hash?: string; expiresAt?: string | null }>;
      const matchedToken = tokens.find((token) => token.hash === tokenHash);
      if (matchedToken) {
        if (matchedToken.expiresAt) {
          const expiresAt = Date.parse(matchedToken.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            continue;
          }
        }

        return {
          user_id: row.user_id,
          username: row.username,
          role: row.role,
          row_status: row.row_status,
        };
      }
    } catch {
      // Ignore malformed PAT payloads and continue scanning.
    }
  }

  return null;
}

export const authRequired = createMiddleware<AuthEnv>(async (c, next) => {
  const token = extractAuthToken(c.req);

  if (!token) {
    return c.json({ code: 16, message: "user not found", details: [] }, 401);
  }

  // Check if it's a PAT
  if (token.startsWith("memos_pat_")) {
    const hash = await hashPAT(token);
    const result = await findUserByPATHash(c.env.DB, hash);

    if (!result) {
      return c.json({ code: 16, message: "invalid access token", details: [] }, 401);
    }

    c.set("user", {
      id: result.user_id,
      username: result.username,
      role: result.role,
      status: result.row_status,
    });
    return next();
  }

  let claims: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    claims = await verifyAccessToken(token, c.env.JWT_SECRET);
  } catch {
    return c.json({ code: 16, message: "token has expired", details: [] }, 401);
  }

  const user = await findActiveUserPayload(c.env.DB, claims.sub);
  if (!user) {
    return c.json({ code: 16, message: "user not found or archived", details: [] }, 401);
  }

  c.set("user", user);
  return next();
});

export const authOptional = createMiddleware<AuthEnv>(async (c, next) => {
  const token = extractAuthToken(c.req);

  if (token) {
    if (token.startsWith("memos_pat_")) {
      const hash = await hashPAT(token);
      const result = await findUserByPATHash(c.env.DB, hash);

      if (result) {
        c.set("user", {
          id: result.user_id,
          username: result.username,
          role: result.role,
          status: result.row_status,
        });
      }
    } else {
      let claims: Awaited<ReturnType<typeof verifyAccessToken>> | undefined;
      try {
        claims = await verifyAccessToken(token, c.env.JWT_SECRET);
      } catch {
        // Token invalid, continue without user
      }

      if (claims) {
        const user = await findActiveUserPayload(c.env.DB, claims.sub);
        if (user) {
          c.set("user", user);
        }
      }
    }
  }

  return next();
});
