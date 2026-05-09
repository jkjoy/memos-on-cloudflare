import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, UserPayload } from "../types";
import { authOptional } from "../middleware/auth";
import { verifyRefreshToken } from "../auth/jwt";

type FileApp = { Bindings: Env; Variables: { user: UserPayload } };

export const fileRoutes = new Hono<FileApp>();

const UNSAFE_MIME_TYPES = new Set([
  "text/html",
  "text/xml",
  "image/svg+xml",
  "application/xhtml+xml",
]);

function parseRangeHeader(rangeHeader: string | undefined, totalSize: number) {
  if (!rangeHeader || totalSize <= 0) {
    return undefined;
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return undefined;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return undefined;
  }

  let start: number;
  let end: number;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : totalSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalSize) {
    return undefined;
  }

  end = Math.min(end, totalSize - 1);
  return { start, end, length: end - start + 1 };
}

const resolveUserFromRequest = async (c: { req: { header: (name: string) => string | undefined }; env: Env; get: (key: "user") => UserPayload | undefined }) => {
  const existingUser = c.get("user");
  if (existingUser) {
    return existingUser;
  }

  const refreshToken = getCookie(c as any, "memos_refresh");
  if (!refreshToken) {
    return undefined;
  }

  try {
    const claims = await verifyRefreshToken(refreshToken, c.env.JWT_SECRET);
    return {
      id: Number(claims.sub),
      username: claims.name,
      role: claims.role,
      status: claims.status,
    };
  } catch {
    return undefined;
  }
};

// Serve attachment file
fileRoutes.get("/attachments/:uid/:filename", authOptional, async (c) => {
  const uid = c.req.param("uid");
  const filename = c.req.param("filename");

  const att = await c.env.DB.prepare(
    "SELECT * FROM attachment WHERE uid = ?"
  ).bind(uid).first<{ id: number; creator_id: number; type: string; size: number; reference: string; memo_id: number | null; filename: string }>();

  if (!att) return c.notFound();

  let cacheControl = "private, no-store";

  // Check visibility via memo
  if (att.memo_id) {
    const memo = await c.env.DB.prepare(
      "SELECT visibility, creator_id FROM memo WHERE id = ?"
    ).bind(att.memo_id).first<{ visibility: string; creator_id: number }>();

    if (memo) {
      const user = await resolveUserFromRequest(c);
      if (memo.visibility === "PRIVATE" && (!user || user.id !== memo.creator_id)) {
        return c.json({ error: "Permission denied" }, 403);
      }
      if (memo.visibility === "PROTECTED" && !user) {
        return c.json({ error: "Authentication required" }, 401);
      }
      if (memo.visibility === "PUBLIC") {
        cacheControl = "public, max-age=31536000, immutable";
      } else if (user?.id === memo.creator_id) {
        cacheControl = "private, max-age=300";
      }
    }
  }

  const range = parseRangeHeader(c.req.header("Range"), att.size);
  const r2Object = range
    ? await c.env.BUCKET.get(att.reference, { range: { offset: range.start, length: range.length } })
    : await c.env.BUCKET.get(att.reference);
  if (!r2Object) {
    return c.notFound();
  }

  let contentType = att.type || "application/octet-stream";
  if (UNSAFE_MIME_TYPES.has(contentType)) {
    contentType = "application/octet-stream";
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
  };

  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${att.size}`;
    headers["Content-Length"] = String(range.length);
    return new Response(r2Object.body, { status: 206, headers });
  }

  if (r2Object.size) {
    headers["Content-Length"] = String(r2Object.size);
  }

  return new Response(r2Object.body, { status: 200, headers });
});

// Serve user avatar
fileRoutes.get("/users/:identifier/avatar", async (c) => {
  const identifier = c.req.param("identifier");

  const user = await c.env.DB.prepare(
    "SELECT avatar_url FROM user WHERE username = ? OR id = ?"
  ).bind(identifier, Number(identifier) || 0).first<{ avatar_url: string }>();

  if (!user || !user.avatar_url) {
    // Return default avatar SVG
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="50" fill="#e2e8f0"/>
      <circle cx="50" cy="35" r="18" fill="#94a3b8"/>
      <ellipse cx="50" cy="85" rx="30" ry="25" fill="#94a3b8"/>
    </svg>`;
    return new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
    });
  }

  // If avatar is an R2 reference
  if (user.avatar_url.startsWith("avatars/")) {
    const r2Object = await c.env.BUCKET.get(user.avatar_url);
    if (r2Object) {
      return new Response(r2Object.body, {
        headers: {
          "Content-Type": r2Object.httpMetadata?.contentType || "image/png",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
  }

  // Redirect to external URL
  return Response.redirect(user.avatar_url, 302);
});
