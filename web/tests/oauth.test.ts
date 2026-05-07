import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeOAuthState, validateOAuthState } from "@/utils/oauth";

describe("oauth state", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("round-trips the linking user for link flows", async () => {
    const { state } = await storeOAuthState("identity-providers/google", "link", "/settings", "users/alice");

    expect(validateOAuthState(state)).toEqual({
      identityProviderName: "identity-providers/google",
      flowMode: "link",
      returnUrl: "/settings",
      linkingUserName: "users/alice",
      codeVerifier: expect.any(String),
    });
  });

  it("defaults older states to signin without a linking user", () => {
    sessionStorage.setItem(
      "oauth_state",
      JSON.stringify({
        state: "legacy-state",
        identityProviderName: "identity-providers/google",
        timestamp: Date.now(),
        returnUrl: "/auth",
      }),
    );

    expect(validateOAuthState("legacy-state")).toEqual({
      identityProviderName: "identity-providers/google",
      flowMode: "signin",
      returnUrl: "/auth",
      linkingUserName: undefined,
      codeVerifier: undefined,
    });
  });

  it("falls back to localStorage when sessionStorage state is lost during oauth redirect", async () => {
    const { state } = await storeOAuthState("identity-providers/google", "link", "/settings", "users/alice");

    sessionStorage.clear();

    expect(validateOAuthState(state)).toEqual({
      identityProviderName: "identity-providers/google",
      flowMode: "link",
      returnUrl: "/settings",
      linkingUserName: "users/alice",
      codeVerifier: expect.any(String),
    });
  });

  it("stores oauth states by token so concurrent flows do not overwrite each other", async () => {
    const first = await storeOAuthState("identity-providers/google", "signin", "/auth");
    const second = await storeOAuthState("identity-providers/github", "link", "/setting", "users/alice");

    expect(validateOAuthState(first.state)).toEqual({
      identityProviderName: "identity-providers/google",
      flowMode: "signin",
      returnUrl: "/auth",
      linkingUserName: undefined,
      codeVerifier: expect.any(String),
    });

    expect(validateOAuthState(second.state)).toEqual({
      identityProviderName: "identity-providers/github",
      flowMode: "link",
      returnUrl: "/setting",
      linkingUserName: "users/alice",
      codeVerifier: expect.any(String),
    });
  });
});
