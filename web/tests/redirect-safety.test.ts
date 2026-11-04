import { describe, expect, it } from "vitest";
import { AUTH_REDIRECT_PARAM, buildAuthRoute, getSafeRedirectPath, isPublicRoute } from "@/utils/redirect-safety";

describe("getSafeRedirectPath", () => {
  it("accepts safe same-origin internal paths", () => {
    expect(getSafeRedirectPath("/home")).toBe("/home");
    expect(getSafeRedirectPath("/setting")).toBe("/setting");
    expect(getSafeRedirectPath("/memos/abc")).toBe("/memos/abc");
    expect(getSafeRedirectPath("/explore?foo=1")).toBe("/explore?foo=1");
    expect(getSafeRedirectPath("/explore#anchor")).toBe("/explore#anchor");
  });

  it("rejects empty and non-string input", () => {
    expect(getSafeRedirectPath(undefined)).toBeUndefined();
    expect(getSafeRedirectPath(null)).toBeUndefined();
    expect(getSafeRedirectPath("")).toBeUndefined();
  });

  it("rejects non-internal targets", () => {
    expect(getSafeRedirectPath("//evil.example")).toBeUndefined();
    expect(getSafeRedirectPath("https://evil.example")).toBeUndefined();
    expect(getSafeRedirectPath("http://evil.example/home")).toBeUndefined();
    expect(getSafeRedirectPath("javascript:alert(1)")).toBeUndefined();
    expect(getSafeRedirectPath("home")).toBeUndefined();
  });

  it.each([
    "/\\external.example",
    "/a\\..\\/external.example",
    "/a/..//external.example",
    "/a/%2e%2e//external.example",
    "/%2fexternal.example",
    "/%5cexternal.example",
    "/home\n",
    "/home\t?x=1",
    "/home\u0000",
    "/home%0a",
    "/home%7f",
  ])("rejects ambiguous browser/router target %j", (path) => {
    expect(getSafeRedirectPath(path)).toBeUndefined();
  });

  it("normalizes safe dot segments while preserving queries and anchors", () => {
    expect(getSafeRedirectPath("/memos/../home?filter=tag%3Atest#today")).toBe("/home?filter=tag%3Atest#today");
    expect(getSafeRedirectPath("/memos/%2e%2e/explore?next=%2Fauth#anchor")).toBe("/explore?next=%2Fauth#anchor");
    expect(getSafeRedirectPath("/u/%E5%B0%8F%E6%98%8E")).toBe("/u/%E5%B0%8F%E6%98%8E");
  });

  it("rejects auth-family targets", () => {
    expect(getSafeRedirectPath("/auth")).toBeUndefined();
    expect(getSafeRedirectPath("/auth/callback")).toBeUndefined();
    expect(getSafeRedirectPath("/auth/signup")).toBeUndefined();
    expect(getSafeRedirectPath("/auth?code=abc")).toBeUndefined();
  });

  it.each([
    "/auth#fragment",
    "/AUTH/callback",
    "/%61uth/signup",
    "/auth%2fcallback",
    "/home/../auth/callback",
    "/home/%2e%2e/auth",
    "/home%2f..%2fauth",
  ])("rejects normalized auth-family target %j", (path) => {
    expect(getSafeRedirectPath(path)).toBeUndefined();
  });

  it("rejects malformed encoded pathnames", () => {
    expect(getSafeRedirectPath("/memos/%zz")).toBeUndefined();
  });

  it("does not false-match auth-like paths", () => {
    expect(getSafeRedirectPath("/authors")).toBe("/authors");
  });
});

describe("buildAuthRoute", () => {
  it("embeds only safe redirect targets", () => {
    expect(buildAuthRoute({ redirect: "/home" })).toBe("/auth?redirect=%2Fhome");
    expect(buildAuthRoute({ redirect: "//evil.example" })).toBe("/auth");
    expect(buildAuthRoute({ redirect: "/auth/callback" })).toBe("/auth");
    expect(buildAuthRoute({ redirect: "/a\\..\\/external.example" })).toBe("/auth");
    expect(buildAuthRoute({ redirect: null })).toBe("/auth");
  });

  it("preserves the reason parameter", () => {
    expect(buildAuthRoute({ reason: "protected-memo" })).toBe("/auth?reason=protected-memo");
    expect(buildAuthRoute({ redirect: "/memos/abc", reason: "protected-memo" })).toBe(
      "/auth?redirect=%2Fmemos%2Fabc&reason=protected-memo",
    );
  });

  it("exposes the canonical redirect query key", () => {
    expect(AUTH_REDIRECT_PARAM).toBe("redirect");
  });
});

describe("isPublicRoute", () => {
  it("identifies anonymous-accessible page prefixes", () => {
    expect(isPublicRoute("/auth")).toBe(true);
    expect(isPublicRoute("/auth/signup")).toBe(true);
    expect(isPublicRoute("/explore")).toBe(true);
    expect(isPublicRoute("/memos/abc")).toBe(true);
    expect(isPublicRoute("/memos/shares/abc")).toBe(true);
    expect(isPublicRoute("/u/steven")).toBe(true);
  });

  it("treats authenticated-only pages as non-public", () => {
    expect(isPublicRoute("/home")).toBe(false);
    expect(isPublicRoute("/setting")).toBe(false);
    expect(isPublicRoute("/inbox")).toBe(false);
    expect(isPublicRoute("/attachments")).toBe(false);
    expect(isPublicRoute("/archived")).toBe(false);
  });
});
