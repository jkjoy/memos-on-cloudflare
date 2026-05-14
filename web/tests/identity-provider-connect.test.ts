import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("@/auth-state", () => ({
  REQUEST_TOKEN_EXPIRY_BUFFER_MS: 30_000,
  clearAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  hasStoredToken: vi.fn(() => false),
  shouldAttemptTokenRefresh: vi.fn(() => false),
  isTokenExpired: vi.fn(() => false),
  setAccessToken: vi.fn(),
}));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("identityProviderServiceClient", () => {
  it("normalizes legacy resource names and flat oauth config payloads", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          identityProviders: [
            {
              uid: "github",
              name: "GitHub",
              type: "oauth2",
              identifier_filter: "",
              config: {
                clientId: "client",
                clientSecret: "secret",
                authUrl: "https://github.com/login/oauth/authorize",
                tokenUrl: "https://github.com/login/oauth/access_token",
                userInfoUrl: "https://api.github.com/user",
                scopes: ["read:user"],
                fieldMapping: {
                  identifier: "login",
                  displayName: "name",
                  email: "email",
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { identityProviderServiceClient } = await import("@/connect");
    const { identityProviders } = await identityProviderServiceClient.listIdentityProviders({});

    expect(identityProviders).toHaveLength(1);
    expect(identityProviders[0].name).toBe("identity-providers/github");
    expect(identityProviders[0].title).toBe("GitHub");
    expect(identityProviders[0].config?.config?.case).toBe("oauth2Config");
    expect(identityProviders[0].config?.config?.value.authUrl).toBe("https://github.com/login/oauth/authorize");
  });

  it("sends flattened oauth config and explicit identityProviderId on create", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "identity-providers/github",
          title: "GitHub",
          type: 1,
          identifierFilter: "",
          config: {
            config: {
              case: "oauth2Config",
              value: {
                clientId: "client",
                clientSecret: "secret",
                authUrl: "https://github.com/login/oauth/authorize",
                tokenUrl: "https://github.com/login/oauth/access_token",
                userInfoUrl: "https://api.github.com/user",
                scopes: ["read:user"],
                fieldMapping: {
                  identifier: "login",
                  displayName: "name",
                  email: "email",
                  avatarUrl: "",
                },
              },
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { identityProviderServiceClient } = await import("@/connect");
    await identityProviderServiceClient.createIdentityProvider({
      identityProviderId: "github",
      identityProvider: {
        title: "GitHub",
        type: 1,
        identifierFilter: "",
        config: {
          config: {
            case: "oauth2Config",
            value: {
              clientId: "client",
              clientSecret: "secret",
              authUrl: "https://github.com/login/oauth/authorize",
              tokenUrl: "https://github.com/login/oauth/access_token",
              userInfoUrl: "https://api.github.com/user",
              scopes: ["read:user"],
              fieldMapping: {
                identifier: "login",
                displayName: "name",
                email: "email",
                avatarUrl: "",
              },
            },
          },
        },
      },
    });

    const [, request] = fetchMock.mock.calls[0];
    expect(request?.method).toBe("POST");
    expect(typeof request?.body).toBe("string");

    const body = JSON.parse(String(request?.body));
    expect(body.identityProviderId).toBe("github");
    expect(body.config).toEqual({
      clientId: "client",
      clientSecret: "secret",
      authUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      scopes: ["read:user"],
      fieldMapping: {
        identifier: "login",
        displayName: "name",
        email: "email",
        avatarUrl: "",
      },
    });
  });
});
