import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import app from "../src/index.ts";
import { createAccessToken, createRefreshToken } from "../src/auth/jwt.ts";

const secret = "local-security-regression-test-secret";
let sqlite;
let env;
let tokens;
let objects;

// Exercise production routes and SQL against the real schema without using
// Cloudflare credentials, a remote database, or an R2 bucket.
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  for (const name of ["0001_initial.sql", "0002_webhooks.sql", "0003_performance_indexes.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }

  const DB = {
    prepare(sql) {
      const prepare = (parameters = []) => ({
        bind: (...values) => prepare(values),
        first: async () => sqlite.prepare(sql).get(...parameters) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...parameters) }),
        run: async () => sqlite.prepare(sql).run(...parameters),
      });
      return prepare();
    },
  };
  objects = new Map();
  const BUCKET = {
    async put(key, body) {
      objects.set(key, new Uint8Array(body));
    },
    async get(key, options) {
      const object = objects.get(key);
      if (!object) return null;
      const body = options?.range
        ? object.slice(options.range.offset, options.range.offset + options.range.length)
        : object;
      return { body, size: object.length };
    },
  };
  env = { DB, BUCKET, JWT_SECRET: secret, INSTANCE_NAME: "security-test" };
  sqlite.exec(`
    INSERT INTO user (id, username, password_hash, role) VALUES
      (1, 'admin', 'unused', 'ADMIN'), (2, 'alice', 'unused', 'USER'), (3, 'bob', 'unused', 'USER');
    INSERT INTO memo (id, uid, creator_id, content, visibility) VALUES
      (1, 'publicmemo', 2, 'public fixture', 'PUBLIC'),
      (2, 'protectedmemo', 2, 'protected fixture', 'PROTECTED'),
      (3, 'privatememo', 2, 'private fixture', 'PRIVATE');
  `);
  tokens = {};
  for (const [id, username, role] of [[1, "admin", "ADMIN"], [2, "alice", "USER"], [3, "bob", "USER"]]) {
    const user = { id, username, role, status: "NORMAL" };
    const access = await createAccessToken(user, secret);
    const refresh = await createRefreshToken(user, `session-${id}`, secret);
    tokens[username] = { access: access.token, refresh: refresh.token };
  }
});

afterEach(() => sqlite.close());

function request(path, options = {}) {
  return app.request(`https://memos.test${path}`, options, env);
}

function asUser(username, body) {
  return {
    headers: { Authorization: `Bearer ${tokens[username].access}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function asCookie(username) {
  return { headers: { Cookie: `memos_refresh=${tokens[username].refresh}` } };
}

function addAttachment({ uid = "file", mime = "text/plain", memoId = 2, filename = "fixture.txt", creatorId = 2 } = {}) {
  const bytes = new TextEncoder().encode("harmless attachment fixture");
  objects.set(uid, bytes);
  sqlite.prepare("INSERT INTO attachment (uid, creator_id, filename, type, size, memo_id, reference) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(uid, creatorId, filename, mime, bytes.length, memoId, uid);
  return `/file/attachments/${uid}/fixture.txt`;
}

test("ordinary users cannot change their own account status", async () => {
  const response = await request("/api/v1/users/alice", { method: "PATCH", ...asUser("alice", { rowStatus: "ARCHIVED" }) });
  assert.equal(response.status, 403);
  assert.equal(sqlite.prepare("SELECT row_status FROM user WHERE id=2").get().row_status, "NORMAL");
});

test("administrators can disable and restore users, but disabled JWTs cannot restore themselves", async () => {
  const archived = await request("/api/v1/users/alice", { method: "PATCH", ...asUser("admin", { rowStatus: "ARCHIVED" }) });
  assert.equal(archived.status, 200);
  const selfRestore = await request("/api/v1/users/alice", { method: "PATCH", ...asUser("alice", { rowStatus: "NORMAL" }) });
  assert.equal(selfRestore.status, 401);
  assert.equal((await request("/api/v1/auth/refresh", { method: "POST", ...asCookie("alice") })).status, 401);
  const restored = await request("/api/v1/users/alice", { method: "PATCH", ...asUser("admin", { rowStatus: "NORMAL" }) });
  assert.equal(restored.status, 200);
  assert.equal((await request("/api/v1/user/me", asUser("alice"))).status, 200);
});

test("invalid account status is rejected without updating the user", async () => {
  const response = await request("/api/v1/users/alice", { method: "PATCH", ...asUser("admin", { rowStatus: "invalid" }) });
  assert.equal(response.status, 400);
});

for (const state of ["archived", "deleted"]) {
  test(`${state} accounts lose both required and optional JWT authentication`, async () => {
    sqlite.exec(state === "archived" ? "UPDATE user SET row_status='ARCHIVED' WHERE id=2" : "DELETE FROM user WHERE id=2");
    assert.equal((await request("/api/v1/user/me", asUser("alice"))).status, 401);
    const response = await request("/api/v1/memos", asUser("alice"));
    assert.equal(response.status, 200);
    const { memos } = await response.json();
    assert.deepEqual(memos.map((memo) => memo.visibility), ["PUBLIC"]);
  });
}

test("demoted administrator JWTs cannot retain privileged access or create users when registration is disabled", async () => {
  sqlite.exec(`UPDATE user SET role='USER' WHERE id=1;
    INSERT INTO system_setting (name, value) VALUES ('instance/settings/GENERAL', '{"disallowUserRegistration":true}');`);
  const update = await request("/api/v1/users/alice", { method: "PATCH", ...asUser("admin", { rowStatus: "ARCHIVED" }) });
  assert.equal(update.status, 403);
  const create = await request("/api/v1/users", { method: "POST", ...asUser("admin", { username: "newuser", password: "unused-password" }) });
  assert.equal(create.status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM user").get().count, 3);
});

for (const state of ["archived", "deleted"]) {
  test(`${state} accounts cannot use refresh cookies to download protected, private, or unattached files`, async () => {
    const protectedPath = addAttachment();
    const privatePath = addAttachment({ uid: "private", memoId: 3 });
    const unattachedPath = addAttachment({ uid: "unattached", memoId: null });
    assert.equal((await request(protectedPath, asCookie("alice"))).status, 200);
    sqlite.exec(state === "archived" ? "UPDATE user SET row_status='ARCHIVED' WHERE id=2" : "DELETE FROM user WHERE id=2");
    for (const path of [protectedPath, privatePath, unattachedPath]) {
      const response = await request(path, asCookie("alice"));
      assert.ok([401, 403].includes(response.status));
    }
  });
}

test("demoted administrators cannot use old refresh-cookie roles to read other users' unattached files", async () => {
  const path = addAttachment({ memoId: null });
  assert.equal((await request(path, asCookie("admin"))).status, 200);
  sqlite.exec("UPDATE user SET role='USER' WHERE id=1");
  assert.equal((await request(path, asCookie("admin"))).status, 403);
});

test("active owners retain private file access without cacheable authenticated responses", async () => {
  const response = await request(addAttachment({ memoId: 3 }), asCookie("alice"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

for (const mime of ["text/html", "text/html; charset=utf-8", "TEXT/HTML", "image/svg+xml; charset=utf-8", "text/xml", "application/xhtml+xml", "application/unknown"]) {
  test(`active content or unknown MIME ${mime} is forced to a safe download`, async () => {
    const response = await request(addAttachment({ mime, memoId: 1 }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
    assert.match(response.headers.get("Content-Disposition"), /^attachment;/);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'");
  });
}

for (const [mime, expected] of [["IMAGE/PNG; charset=binary", "image/png"], ["audio/webm; codecs=opus", "audio/webm"], ["video/mp4", "video/mp4"], ["application/pdf", "application/pdf"], ["text/plain; charset=utf-8", "text/plain"]]) {
  test(`safe MIME ${mime} remains available for inline preview`, async () => {
    const response = await request(addAttachment({ mime, memoId: 1 }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), expected);
    assert.equal(response.headers.get("Content-Disposition"), null);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  });
}

test("partial file responses retain download protection and encode untrusted filenames", async () => {
  const path = addAttachment({ mime: "text/html; charset=utf-8", memoId: 1, filename: '笔记";\r\nX-Injected: yes.html' });
  const response = await request(path, { headers: { Range: "bytes=0-3" } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "harm");
  assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
  assert.match(response.headers.get("Content-Disposition"), /^attachment; filename="download"; filename\*=UTF-8''/);
  assert.ok(!/[\r\n]/.test(response.headers.get("Content-Disposition")));
  assert.equal(response.headers.get("X-Injected"), null);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("public attachments and valid private share links remain accessible anonymously", async () => {
  const publicPath = addAttachment({ memoId: 1 });
  const privatePath = addAttachment({ uid: "sharedfile", memoId: 3 });
  sqlite.exec("INSERT INTO memo_share (uid, memo_id, creator_id) VALUES ('validshare', 3, 2)");
  assert.equal((await request(publicPath)).status, 200);
  assert.equal((await request(privatePath)).status, 403);
  const shared = await request(`${privatePath}?share_token=validshare`);
  assert.equal(shared.status, 200);
  assert.equal(shared.headers.get("Cache-Control"), "private, no-store");
  sqlite.exec("UPDATE memo_share SET expires_ts=1 WHERE uid='validshare'");
  assert.equal((await request(`${privatePath}?share_token=validshare`)).status, 403);
});
