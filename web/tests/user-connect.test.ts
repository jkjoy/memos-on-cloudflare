import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/api/client";
import { userServiceClient } from "@/connect";
import { State } from "@/types/proto/api/v1/common_pb";
import { User_Role } from "@/types/proto/api/v1/user_service_pb";

vi.mock("@/api/client", () => ({
  apiRequest: vi.fn(),
  buildQueryString: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

const requestMock = vi.mocked(apiRequest);

beforeEach(() => {
  requestMock.mockResolvedValue({ username: "alice", role: "USER", rowStatus: "NORMAL" });
});

describe("userServiceClient", () => {
  it.each([
    [State.ARCHIVED, "ARCHIVED"],
    [State.NORMAL, "NORMAL"],
  ])("maps member state %s to the worker status", async (state, rowStatus) => {
    await userServiceClient.updateUser({ user: { name: "users/alice", state }, updateMask: { paths: ["state"] } });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", { rowStatus });
  });

  it.each([
    [User_Role.ADMIN, "ADMIN"],
    [User_Role.USER, "USER"],
  ])("maps member role %s to the worker role", async (role, workerRole) => {
    requestMock.mockResolvedValue({ username: "alice", role: workerRole, rowStatus: "NORMAL" });

    const user = await userServiceClient.updateUser({ user: { name: "users/alice", role }, updateMask: { paths: ["role"] } });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", { role: workerRole });
    expect(user.role).toBe(role);
  });

  it("does not send role, state or other profile values outside the update mask", async () => {
    await userServiceClient.updateUser({
      user: {
        name: "users/alice",
        username: "alice",
        displayName: "",
        description: "",
        password: "",
        role: User_Role.ROLE_UNSPECIFIED,
        state: State.STATE_UNSPECIFIED,
        email: "new@example.com",
      },
      updateMask: { paths: ["email"] },
    });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", { email: "new@example.com" });
  });

  it("keeps password changes independent of role and status", async () => {
    await userServiceClient.updateUser({
      user: { name: "users/alice", password: "new-password", role: User_Role.ADMIN, state: State.ARCHIVED },
      updateMask: { paths: ["password"] },
    });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", { password: "new-password" });
  });

  it("preserves profile changes and supports the existing nickname mask", async () => {
    await userServiceClient.updateUser({
      user: { name: "users/alice", nickname: "Alice", email: "alice@example.com", avatarUrl: "", description: "About Alice" },
      updateMask: { paths: ["nickname", "email", "avatar_url", "description"] },
    });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", {
      nickname: "Alice",
      email: "alice@example.com",
      avatarUrl: "",
      description: "About Alice",
    });
  });

  it("maps the protobuf display name field without forwarding other fields", async () => {
    await userServiceClient.updateUser({
      user: { name: "users/alice", displayName: "Alice", nickname: "Old name", email: "unchanged@example.com" },
      updateMask: { paths: ["display_name"] },
    });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", { nickname: "Alice" });
  });

  it("uses explicitly supplied mutable fields when there is no mask", async () => {
    await userServiceClient.updateUser({ user: { name: "users/alice", description: "New description", avatarUrl: "" } });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", { description: "New description", avatarUrl: "" });
  });

  it("sends no changes for an empty update mask", async () => {
    await userServiceClient.updateUser({
      user: { name: "users/alice", role: User_Role.ADMIN, state: State.ARCHIVED, email: "alice@example.com" },
      updateMask: { paths: [] },
    });

    expect(requestMock).toHaveBeenCalledWith("PATCH", "/api/v1/users/alice", {});
  });

  it.each([User_Role.ROLE_UNSPECIFIED, 1])("rejects unsupported role %s without sending a request", async (role) => {
    await expect(userServiceClient.updateUser({ user: { name: "users/alice", role }, updateMask: { paths: ["role"] } })).rejects.toThrow(
      "Invalid user role",
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rejects an unspecified status without restoring an account", async () => {
    await expect(
      userServiceClient.updateUser({ user: { name: "users/alice", state: State.STATE_UNSPECIFIED }, updateMask: { paths: ["state"] } }),
    ).rejects.toThrow("Invalid user state");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("normalizes ordinary user roles to the generated USER enum", async () => {
    requestMock.mockResolvedValue({ users: [{ username: "alice", role: "USER", rowStatus: "NORMAL" }] });

    const { users } = await userServiceClient.listUsers();

    expect(users[0].role).toBe(User_Role.USER);
  });
});
