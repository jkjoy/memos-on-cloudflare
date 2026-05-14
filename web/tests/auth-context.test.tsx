import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authStateStore = vi.hoisted(() => ({
  accessToken: null as string | null,
}));

const authStateMocks = vi.hoisted(() => ({
  clearAccessToken: vi.fn(),
  getAccessToken: vi.fn(),
  shouldAttemptTokenRefresh: vi.fn(),
}));

const connectMocks = vi.hoisted(() => ({
  authServiceClient: {
    getCurrentUser: vi.fn(),
  },
  refreshAccessToken: vi.fn(),
  shortcutServiceClient: {
    listShortcuts: vi.fn(),
  },
  userServiceClient: {
    listUserSettings: vi.fn(),
  },
}));

vi.mock("@/auth-state", () => ({
  clearAccessToken: authStateMocks.clearAccessToken,
  getAccessToken: authStateMocks.getAccessToken,
  shouldAttemptTokenRefresh: authStateMocks.shouldAttemptTokenRefresh,
}));

vi.mock("@/connect", () => ({
  authServiceClient: connectMocks.authServiceClient,
  refreshAccessToken: connectMocks.refreshAccessToken,
  shortcutServiceClient: connectMocks.shortcutServiceClient,
  userServiceClient: connectMocks.userServiceClient,
}));

vi.mock("@/hooks/useUserQueries", () => ({
  userKeys: {
    currentUser: () => ["users", "current"],
    detail: (name: string) => ["users", name],
  },
}));

import { AuthProvider, useAuth } from "@/contexts/AuthContext";

function InitializeOnMount({ onSettled }: { onSettled: () => void }) {
  const { initialize } = useAuth();

  useEffect(() => {
    void initialize().finally(onSettled);
  }, [initialize, onSettled]);

  return null;
}

function renderAuthProvider(onSettled: () => void) {
  const queryClient = new QueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <InitializeOnMount onSettled={onSettled} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("AuthProvider.initialize", () => {
  beforeEach(() => {
    authStateStore.accessToken = null;
    authStateMocks.clearAccessToken.mockImplementation(() => {
      authStateStore.accessToken = null;
    });
    authStateMocks.getAccessToken.mockImplementation(() => authStateStore.accessToken);
    authStateMocks.shouldAttemptTokenRefresh.mockReturnValue(false);

    connectMocks.refreshAccessToken.mockResolvedValue(undefined);
    connectMocks.authServiceClient.getCurrentUser.mockResolvedValue({ user: undefined });
    connectMocks.userServiceClient.listUserSettings.mockResolvedValue({ settings: [] });
    connectMocks.shortcutServiceClient.listShortcuts.mockResolvedValue({ shortcuts: [] });
  });

  it("skips refresh when no token or session hint is present", async () => {
    const onSettled = vi.fn();

    renderAuthProvider(onSettled);

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    expect(connectMocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(connectMocks.authServiceClient.getCurrentUser).not.toHaveBeenCalled();
  });

  it("attempts refresh when a cookie-backed session hint is present", async () => {
    const onSettled = vi.fn();

    authStateMocks.shouldAttemptTokenRefresh.mockReturnValue(true);
    connectMocks.refreshAccessToken.mockImplementation(async () => {
      authStateStore.accessToken = "fresh-token";
    });
    connectMocks.authServiceClient.getCurrentUser.mockResolvedValue({ user: { name: "users/alice" } });

    renderAuthProvider(onSettled);

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    expect(connectMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(connectMocks.authServiceClient.getCurrentUser).toHaveBeenCalledTimes(1);
  });
});
