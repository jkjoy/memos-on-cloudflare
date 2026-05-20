import { Hono } from "hono";
import type { Env } from "../types";
import { findUserByUsername } from "../db/user";
import * as memoDB from "../db/memo";

export const rssRoutes = new Hono<{ Bindings: Env }>();

rssRoutes.get("/:username/rss.xml", async (c) => {
  const username = c.req.param("username");
  const user = await findUserByUsername(c.env.DB, username);
  if (!user) {
    return c.text("User not found", 404);
  }

  const { memos } = await memoDB.listMemos(c.env.DB, {
    creatorId: user.id,
    visibility: "PUBLIC",
    rowStatus: "NORMAL",
    excludeComments: true,
    pageSize: 50,
    offset: 0,
  });

  const baseUrl = new URL(c.req.url).origin;
  const feedUrl = `${baseUrl}/u/${username}/rss.xml`;
  const now = new Date().toUTCString();

  const items = memos.map((memo) => {
    const title = memo.content.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 100) || "Untitled";
    const pubDate = new Date(memo.created_ts * 1000).toUTCString();
    const link = `${baseUrl}/memos/${memo.uid}`;
    const content = escapeXml(memo.content);

    return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${content}</description>
    </item>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(user.nickname || username)} - Memos</title>
    <link>${baseUrl}</link>
    <description>${escapeXml(user.description || `Public memos by ${username}`)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`;

  return c.body(xml, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=600",
  });
});

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
