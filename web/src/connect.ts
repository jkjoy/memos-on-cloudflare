import { apiRequest, buildQueryString, refreshAccessToken as doRefresh } from "./api/client";

export { doRefresh as refreshAccessToken };

// ============================================================================
// Memo Service Client
// ============================================================================

export const memoServiceClient = {
  async createMemo(req: { memo: any }) {
    const memo = req.memo || {};
    const body: any = {
      content: memo.content ?? "",
      visibility: visibilityToString(memo.visibility),
    };
    if (memo.createTime) body.createTime = timestampToISO(memo.createTime);
    if (memo.updateTime) body.updateTime = timestampToISO(memo.updateTime);
    if (memo.pinned !== undefined) body.pinned = memo.pinned;
    if (memo.location) body.location = memo.location;
    return apiRequest<any>("POST", "/api/v1/memos", body);
  },

  async listMemos(req: any) {
    const params: Record<string, unknown> = {};
    if (req.pageSize) params.pageSize = req.pageSize;
    if (req.pageToken) params.pageToken = req.pageToken;
    if (req.filter) params.filter = req.filter;
    if (req.orderBy) params.orderBy = req.orderBy;
    if (req.state !== undefined) params.state = stateToString(req.state);
    if (req.showDeleted) params.showDeleted = "true";
    const data = await apiRequest<any>("GET", `/api/v1/memos${buildQueryString(params)}`);
    return {
      memos: (data.memos || []).map(normalizeMemo),
      nextPageToken: data.nextPageToken || "",
      totalSize: data.totalSize || 0,
    };
  },

  async getMemo(req: { name: string }) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}`);
    return normalizeMemo(data);
  },

  async updateMemo(req: { memo: any; updateMask?: any }) {
    const memo = req.memo || {};
    const id = extractId(memo.name, "memos/");
    const body: any = {};
    const paths = req.updateMask?.paths || [];

    if (paths.includes("content") || memo.content !== undefined) body.content = memo.content;
    if (paths.includes("visibility") || memo.visibility !== undefined) body.visibility = visibilityToString(memo.visibility);
    if (paths.includes("pinned") || memo.pinned !== undefined) body.pinned = memo.pinned;
    if (paths.includes("state") || memo.state !== undefined) body.rowStatus = memo.state === 2 ? "ARCHIVED" : "NORMAL";
    if (paths.includes("create_time") && memo.createTime) body.createTime = timestampToISO(memo.createTime);
    if (paths.includes("update_time") && memo.updateTime) body.updateTime = timestampToISO(memo.updateTime);
    if (paths.includes("location") || memo.location !== undefined) body.location = memo.location;

    const data = await apiRequest<any>("PATCH", `/api/v1/memos/${id}`, body);
    return normalizeMemo(data);
  },

  async deleteMemo(req: { name: string }) {
    const id = extractId(req.name, "memos/");
    await apiRequest<any>("DELETE", `/api/v1/memos/${id}`);
  },

  async setMemoAttachments(req: { name: string; attachments: any[] }) {
    const id = extractId(req.name, "memos/");
    const attachments = (req.attachments || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      uid: a.uid,
    }));
    await apiRequest<any>("PATCH", `/api/v1/memos/${id}/attachments`, { attachments });
  },

  async listMemoAttachments(req: any) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/attachments`);
    return { attachments: data.attachments || [], nextPageToken: "" };
  },

  async setMemoRelations(req: { name: string; relations: any[] }) {
    const id = extractId(req.name, "memos/");
    const relations = (req.relations || []).map((r: any) => ({
      relatedMemoId: Number(extractId(r.relatedMemo?.name || "", "memos/")),
      type: r.type === 2 ? "COMMENT" : "REFERENCE",
    }));
    await apiRequest<any>("PATCH", `/api/v1/memos/${id}/relations`, { relations });
  },

  async listMemoRelations(req: any) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/relations`);
    return { relations: data.relations || [], nextPageToken: "" };
  },

  async createMemoComment(req: { name: string; comment: any }) {
    const id = extractId(req.name, "memos/");
    const comment = req.comment || {};
    const body: any = {
      content: comment.content ?? "",
      visibility: visibilityToString(comment.visibility),
    };
    if (comment.location) body.location = comment.location;
    const data = await apiRequest<any>("POST", `/api/v1/memos/${id}/comments`, body);
    return normalizeMemo(data);
  },

  async listMemoComments(req: any) {
    const id = extractId(req.name, "memos/");
    const params: Record<string, unknown> = {};
    if (req.pageSize) params.pageSize = req.pageSize;
    if (req.pageToken) params.pageToken = req.pageToken;
    if (req.orderBy) params.orderBy = req.orderBy;
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/comments${buildQueryString(params)}`);
    return {
      memos: (data.memos || []).map(normalizeMemo),
      nextPageToken: data.nextPageToken || "",
      totalSize: data.totalSize || 0,
    };
  },

  async listMemoReactions(req: any) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/reactions`);
    return { reactions: normalizeReactions(data.reactions || []), nextPageToken: "", totalSize: 0 };
  },

  async upsertMemoReaction(req: { name: string; reaction: any }) {
    const id = extractId(req.name, "memos/");
    const data = await apiRequest<any>("POST", `/api/v1/memos/${id}/reactions`, {
      reactionType: req.reaction?.reactionType || "",
    });
    return normalizeReaction(data);
  },

  async deleteMemoReaction(req: { name: string }) {
    const parts = req.name.split("/");
    const memoId = parts[1];
    const reactionId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/memos/${memoId}/reactions/${reactionId}`);
  },

  async createMemoShare(req: { parent: string; memoShare?: any }) {
    const id = extractId(req.parent, "memos/");
    const data = await apiRequest<any>("POST", `/api/v1/memos/${id}/shares`, {
      expiresTs: req.memoShare?.expireTime ? Math.floor(new Date(timestampToISO(req.memoShare.expireTime)).getTime() / 1000) : undefined,
    });
    return normalizeShare(data);
  },

  async listMemoShares(req: { parent: string }) {
    const id = extractId(req.parent, "memos/");
    const data = await apiRequest<any>("GET", `/api/v1/memos/${id}/shares`);
    return { memoShares: (data.shares || []).map(normalizeShare) };
  },

  async deleteMemoShare(req: { name: string }) {
    const parts = req.name.split("/");
    const memoId = parts[1];
    const shareId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/memos/${memoId}/shares/${shareId}`);
  },

  async getMemoByShare(req: { shareId: string }) {
    const data = await apiRequest<any>("GET", `/api/v1/memos/shares/${req.shareId}`);
    return normalizeMemo(data);
  },

  async getLinkMetadata(req: { url: string }) {
    const data = await apiRequest<any>("GET", `/api/v1/memos/-/linkMetadata${buildQueryString({ url: req.url })}`);
    return data;
  },

  async batchGetLinkMetadata(req: { urls: string[] }) {
    const data = await apiRequest<any>("POST", "/api/v1/memos/-/linkMetadata:batchGet", { urls: req.urls });
    return { linkMetadata: data.linkMetadata || [] };
  },
};

// ============================================================================
// Auth Service Client
// ============================================================================

export const authServiceClient = {
  async getCurrentUser(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/auth/me");
    return { user: normalizeUser(data) };
  },

  async signIn(req: { username?: string; password?: string; credentials?: any; neverExpire?: boolean }) {
    let body: any;

    if (req.credentials?.case === "ssoCredentials") {
      body = { credentials: req.credentials };
    } else {
      let username = req.username;
      let password = req.password;
      if (req.credentials?.value) {
        username = req.credentials.value.username;
        password = req.credentials.value.password;
      }
      body = { username, password };
    }

    const data = await apiRequest<any>("POST", "/api/v1/auth/signin", body);
    return {
      accessToken: data.accessToken,
      accessTokenExpiresAt: data.expiresAt ? { seconds: data.expiresAt, nanos: 0 } : undefined,
      user: data.user ? normalizeUser(data.user) : undefined,
    };
  },

  async signOut(_req?: any) {
    await apiRequest<any>("POST", "/api/v1/auth/signout");
  },

  async refreshToken(_req?: any) {
    const data = await apiRequest<any>("POST", "/api/v1/auth/refresh");
    return {
      accessToken: data.accessToken,
      accessTokenExpiresAt: data.expiresAt ? { seconds: data.expiresAt, nanos: 0 } : undefined,
    };
  },

  async signUp(req: { username: string; password: string }) {
    const data = await apiRequest<any>("POST", "/api/v1/auth/signup", {
      username: req.username,
      password: req.password,
    });
    return {
      accessToken: data.accessToken,
      expiresAt: data.expiresAt ? { seconds: data.expiresAt } : undefined,
      user: data.user ? normalizeUser(data.user) : undefined,
    };
  },
};

// ============================================================================
// User Service Client
// ============================================================================

export const userServiceClient = {
  async listUsers(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/users");
    return { users: (data.users || []).map(normalizeUser) };
  },

  async batchGetUsers(req: { usernames: string[] }) {
    const data = await apiRequest<any>("POST", "/api/v1/users/batchGet", { usernames: req.usernames });
    return { users: (data.users || []).map(normalizeUser) };
  },

  async getUser(req: { name: string }) {
    const username = extractId(req.name, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}`);
    return normalizeUser(data);
  },

  async createUser(req: { user: any }) {
    const data = await apiRequest<any>("POST", "/api/v1/users", req.user);
    return normalizeUser(data);
  },

  async updateUser(req: { user: any; updateMask?: any }) {
    const user = req.user || {};
    const username = extractId(user.name, "users/");
    const paths: string[] | undefined = req.updateMask?.paths;
    const body: Record<string, unknown> = {};
    const isSelected = (...aliases: string[]) =>
      paths ? aliases.some((field) => paths.includes(field)) : aliases.some((field) => user[field] !== undefined);

    const fields = [
      ["username", ["username"]],
      ["nickname", ["nickname", "displayName", "display_name"]],
      ["email", ["email"]],
      ["avatarUrl", ["avatarUrl", "avatar_url"]],
      ["description", ["description"]],
      ["password", ["password"]],
    ] as const;
    for (const [target, aliases] of fields) {
      if (isSelected(...aliases)) {
        const sources =
          target === "nickname" && paths?.some((field) => field === "displayName" || field === "display_name")
            ? ["displayName", "display_name", "nickname"]
            : aliases;
        body[target] = sources.map((field) => user[field]).find((value) => value !== undefined) ?? "";
      }
    }

    if (isSelected("state", "rowStatus", "row_status")) {
      const state = paths?.some((field) => field === "rowStatus" || field === "row_status")
        ? (user.rowStatus ?? user.row_status ?? user.state)
        : (user.state ?? user.rowStatus ?? user.row_status);
      if (state !== 1 && state !== 2 && state !== "NORMAL" && state !== "ARCHIVED") {
        throw new Error("Invalid user state");
      }
      body.rowStatus = state === 2 || state === "ARCHIVED" ? "ARCHIVED" : "NORMAL";
    }
    if (isSelected("role")) {
      if (user.role !== 2 && user.role !== 3 && user.role !== "ADMIN" && user.role !== "USER") {
        throw new Error("Invalid user role");
      }
      body.role = user.role === 2 || user.role === "ADMIN" ? "ADMIN" : "USER";
    }

    const data = await apiRequest<any>("PATCH", `/api/v1/users/${username}`, body);
    return normalizeUser(data);
  },

  async deleteUser(req: { name: string }) {
    const username = extractId(req.name, "users/");
    await apiRequest<any>("DELETE", `/api/v1/users/${username}`);
  },

  async getUserStats(req: { name: string }) {
    const username = extractId(req.name, "users/");
    return apiRequest<any>("GET", `/api/v1/users/${username}/stats`);
  },

  async listAllUserStats(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/users/stats");
  },

  async getUserSetting(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const key = parts[3];
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/settings/${key}`);
    return data.setting || { key, value: "" };
  },

  async updateUserSetting(req: { setting: any; updateMask?: any }) {
    const setting = req.setting || {};
    const parts = (setting.name || "").split("/");
    const username = parts[1];
    const key = parts[3] || setting.key;
    // setting.value is { case: "generalSetting", value: {...} } — send the inner value
    const innerValue = setting.value?.value !== undefined ? setting.value.value : setting.value;
    const data = await apiRequest<any>("PATCH", `/api/v1/users/${username}/settings/${key}`, { value: innerValue });
    return data.setting || setting;
  },

  async listUserSettings(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/settings`);
    const settings = (data.settings || []).map((s: any) => {
      let parsedValue: any;
      try {
        parsedValue = typeof s.value === "string" ? JSON.parse(s.value) : s.value;
      } catch {
        parsedValue = s.value;
      }
      const caseMap: Record<string, string> = {
        general: "generalSetting",
        GENERAL: "generalSetting",
        webhooks: "webhooksSetting",
        WEBHOOKS: "webhooksSetting",
        locale: "generalSetting",
        appearance: "generalSetting",
      };
      const caseName = caseMap[s.key] || s.key;
      return { name: `users/${username}/settings/${s.key}`, key: s.key, value: { case: caseName, value: parsedValue } };
    });
    return { settings };
  },

  async listPersonalAccessTokens(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/personalAccessTokens`);
    const tokens = (data.personalAccessTokens || []).map((t: any) => ({
      ...t,
      name: t.name || `users/${username}/personalAccessTokens/${t.hash}`,
      createdAt: t.createdAt ? isoToTimestamp(t.createdAt) : undefined,
      expiresAt: t.expiresAt ? isoToTimestamp(t.expiresAt) : undefined,
    }));
    return { personalAccessTokens: tokens };
  },

  async createPersonalAccessToken(req: { parent: string; personalAccessToken?: any; description?: string; expiresInDays?: number }) {
    const username = extractId(req.parent, "users/");
    const body = req.personalAccessToken || { description: req.description, expiresInDays: req.expiresInDays };
    const data = await apiRequest<any>("POST", `/api/v1/users/${username}/personalAccessTokens`, body);
    return {
      token: data.token,
      personalAccessToken: { description: data.description || body.description || "" },
    };
  },

  async deletePersonalAccessToken(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const tokenId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/personalAccessTokens/${tokenId}`);
  },

  async listUserNotifications(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/notifications`);
    return { notifications: data.notifications || [] };
  },

  async updateUserNotification(req: { notification: any; updateMask?: any }) {
    const notif = req.notification || {};
    const parts = (notif.name || "").split("/");
    const username = parts[1];
    const notifId = parts[3];
    return apiRequest<any>("PATCH", `/api/v1/users/${username}/notifications/${notifId}`, notif);
  },

  async deleteUserNotification(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const notifId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/notifications/${notifId}`);
  },

  async listUserWebhooks(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/webhooks`);
    return { webhooks: data.webhooks || [] };
  },

  async createUserWebhook(req: { parent: string; webhook: any }) {
    const username = extractId(req.parent, "users/");
    return apiRequest<any>("POST", `/api/v1/users/${username}/webhooks`, req.webhook);
  },

  async updateUserWebhook(req: { webhook: any; updateMask?: any }) {
    const webhook = req.webhook || {};
    const parts = (webhook.name || "").split("/");
    const username = parts[1];
    const webhookId = parts[3];
    return apiRequest<any>("PATCH", `/api/v1/users/${username}/webhooks/${webhookId}`, webhook);
  },

  async deleteUserWebhook(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const webhookId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/webhooks/${webhookId}`);
  },

  async listShortcuts(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/shortcuts");
  },

  async listLinkedIdentities(req: { parent: string }) {
    const username = extractId(req.parent, "users/");
    const data = await apiRequest<any>("GET", `/api/v1/users/${username}/linkedIdentities`).catch(() => ({ linkedIdentities: [] }));
    return { linkedIdentities: (data.linkedIdentities || []).map(normalizeLinkedIdentity) };
  },

  async createLinkedIdentity(req: { parent: string; idpName?: string; code?: string; redirectUri?: string; codeVerifier?: string }) {
    const username = extractId(req.parent, "users/");
    return apiRequest<any>("POST", `/api/v1/users/${username}/linkedIdentities`, {
      idpName: req.idpName,
      code: req.code,
      redirectUri: req.redirectUri,
      codeVerifier: req.codeVerifier,
    });
  },

  async deleteLinkedIdentity(req: { name: string }) {
    const parts = req.name.split("/");
    const username = parts[1];
    const identityId = parts[3];
    await apiRequest<any>("DELETE", `/api/v1/users/${username}/linkedIdentities/${identityId}`);
  },
};

// ============================================================================
// Attachment Service Client
// ============================================================================

export const attachmentServiceClient = {
  async createAttachment(req: { attachment: any }) {
    const att = req.attachment || {};
    const formData = new FormData();

    if (att.content instanceof Uint8Array) {
      const blob = new Blob([att.content], { type: att.type || "application/octet-stream" });
      formData.append("file", blob, att.filename || "unnamed");
    } else if (att.file instanceof File) {
      formData.append("file", att.file);
    }

    const data = await apiRequest<any>("POST", "/api/v1/attachments", formData, { isFormData: true });
    return normalizeAttachment(data);
  },

  async listAttachments(req?: any) {
    const params: Record<string, unknown> = {};
    if (req?.pageSize) params.pageSize = req.pageSize;
    if (req?.pageToken) params.pageToken = req.pageToken;
    if (req?.filter) params.filter = req.filter;
    if (req?.orderBy) params.orderBy = req.orderBy;
    const data = await apiRequest<any>("GET", `/api/v1/attachments${buildQueryString(params)}`);
    return {
      attachments: (data.attachments || []).map(normalizeAttachment),
      nextPageToken: data.nextPageToken || "",
      totalSize: data.totalSize || 0,
    };
  },

  async getAttachment(req: { name: string }) {
    const id = extractId(req.name, "attachments/");
    const data = await apiRequest<any>("GET", `/api/v1/attachments/${id}`);
    return normalizeAttachment(data);
  },

  async updateAttachment(req: { attachment: any; updateMask?: any }) {
    const att = req.attachment || {};
    const id = extractId(att.name, "attachments/");
    const data = await apiRequest<any>("PATCH", `/api/v1/attachments/${id}`, att);
    return normalizeAttachment(data);
  },

  async deleteAttachment(req: { name: string }) {
    const id = extractId(req.name, "attachments/");
    await apiRequest<any>("DELETE", `/api/v1/attachments/${id}`);
  },

  async batchDeleteAttachments(req: { names: string[] }) {
    await apiRequest<any>("POST", "/api/v1/attachments/batchDelete", { names: req.names || [] });
  },
};

// ============================================================================
// Instance Service Client
// ============================================================================

export const instanceServiceClient = {
  async getInstanceProfile(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/instance/profile");
  },

  async getInstanceSetting(req: { name: string }) {
    const name = req.name; // e.g. "instance/settings/GENERAL"
    const data = await apiRequest<any>("GET", `/api/v1/${name}`);
    try {
      const parsed = typeof data.value === "string" ? JSON.parse(data.value) : (data.value || {});
      const keyName = name.split("/").pop() || "";
      const caseMap: Record<string, string> = {
        GENERAL: "generalSetting",
        MEMO_RELATED: "memoRelatedSetting",
        STORAGE: "storageSetting",
        TAGS: "tagsSetting",
        NOTIFICATION: "notificationSetting",
        AI: "aiSetting",
      };
      const caseName = caseMap[keyName] || "generalSetting";
      return { name: data.name || name, value: { case: caseName, value: parsed } };
    } catch {
      return { name: data.name || name, value: { case: undefined, value: {} } };
    }
  },

  async updateInstanceSetting(req: { setting: any; updateMask?: any }) {
    const setting = req.setting || {};
    const name = setting.name; // e.g. "instance/settings/GENERAL"
    const innerValue = setting.value?.value ?? setting.value ?? {};
    await apiRequest<any>("PATCH", `/api/v1/${name}`, {
      value: JSON.stringify(innerValue),
    });
    const keyName = name.split("/").pop() || "";
    const caseMap: Record<string, string> = {
      GENERAL: "generalSetting",
      MEMO_RELATED: "memoRelatedSetting",
      STORAGE: "storageSetting",
      TAGS: "tagsSetting",
      NOTIFICATION: "notificationSetting",
      AI: "aiSetting",
    };
    return {
      name,
      value: {
        case: caseMap[keyName] || setting.value?.case,
        value: innerValue,
      },
    };
  },

  async listInstanceSettings(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/instance/settings");
  },

  async getInstanceStats(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/instance/stats").catch(() => ({}));
  },

  async testInstanceEmailSetting(req: { email?: any; recipientEmail?: string }) {
    return apiRequest<any>("POST", "/api/v1/instance/settings/notification:testEmail", req);
  },
};

// ============================================================================
// AI Service Client (stub)
// ============================================================================

export const aiServiceClient = {
  async transcribeAudio(_req: any) {
    return { text: "" };
  },

  async transcribe(req: any) {
    const audio = req.audio;
    if (!audio) return { text: "" };

    const formData = new FormData();
    if (audio.source?.case === "content" && audio.source.value) {
      const blob = new Blob([audio.source.value], { type: audio.contentType || "audio/wav" });
      formData.append("file", blob, audio.filename || "audio.wav");
    }
    if (audio.contentType) formData.append("contentType", audio.contentType);
    if (req.language) formData.append("language", req.language);

    const data = await apiRequest<any>("POST", "/api/v1/ai/transcribe", formData, { isFormData: true });
    return { text: data.text || "" };
  },
};

// ============================================================================
// Shortcut Service Client
// ============================================================================

export const shortcutServiceClient = {
  async listShortcuts(_req?: any) {
    return apiRequest<any>("GET", "/api/v1/shortcuts").catch(() => ({ shortcuts: [] }));
  },

  async createShortcut(req: { shortcut: any; parent?: string }) {
    return apiRequest<any>("POST", "/api/v1/shortcuts", req.shortcut);
  },

  async updateShortcut(req: { shortcut: any; updateMask?: any }) {
    const shortcut = req.shortcut || {};
    const id = extractId(shortcut.name, "shortcuts/");
    return apiRequest<any>("PATCH", `/api/v1/shortcuts/${id}`, shortcut);
  },

  async deleteShortcut(req: { name: string }) {
    const id = extractId(req.name, "shortcuts/");
    await apiRequest<any>("DELETE", `/api/v1/shortcuts/${id}`);
  },
};

// ============================================================================
// Identity Provider Service Client
// ============================================================================

export const identityProviderServiceClient = {
  async listIdentityProviders(_req?: any) {
    const data = await apiRequest<any>("GET", "/api/v1/idps").catch(() => ({ identityProviders: [] }));
    return { identityProviders: (data.identityProviders || []).map(normalizeIdentityProvider) };
  },

  async createIdentityProvider(req: { identityProvider: any; identityProviderId?: string }) {
    const data = await apiRequest<any>("POST", "/api/v1/idps", buildIdentityProviderPayload(req.identityProvider, req.identityProviderId));
    return normalizeIdentityProvider(data);
  },

  async updateIdentityProvider(req: { identityProvider: any; updateMask?: any }) {
    const idp = req.identityProvider || {};
    const id = extractIdentityProviderUid(idp.name || "");
    const data = await apiRequest<any>("PATCH", `/api/v1/idps/${id}`, buildIdentityProviderPayload(idp));
    return normalizeIdentityProvider(data);
  },

  async deleteIdentityProvider(req: { name: string }) {
    const id = extractIdentityProviderUid(req.name);
    await apiRequest<any>("DELETE", `/api/v1/idps/${id}`);
  },
};

// ============================================================================
// Helpers
// ============================================================================

function extractId(name: string, prefix: string): string {
  if (name.startsWith(prefix)) return name.slice(prefix.length);
  const index = name.lastIndexOf(`/${prefix}`);
  if (index >= 0) return name.slice(index + prefix.length + 1);
  return name;
}

function visibilityToString(v: any): string {
  if (typeof v === "string") return v;
  switch (v) {
    case 1: return "PRIVATE";
    case 2: return "PROTECTED";
    case 3: return "PUBLIC";
    default: return "PRIVATE";
  }
}

function stateToString(s: any): string {
  if (typeof s === "string") return s;
  switch (s) {
    case 1: return "NORMAL";
    case 2: return "ARCHIVED";
    default: return "NORMAL";
  }
}

function stringToVisibility(s: string): number {
  switch (s) {
    case "PRIVATE": return 1;
    case "PROTECTED": return 2;
    case "PUBLIC": return 3;
    default: return 1;
  }
}

function timestampToISO(ts: any): string {
  if (!ts) return "";
  if (typeof ts === "string") return ts;
  if (ts.seconds) {
    const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : Number(ts.seconds);
    return new Date(s * 1000).toISOString();
  }
  return "";
}

function isoToTimestamp(iso: string | undefined): any {
  if (!iso) return undefined;
  const seconds = Math.floor(new Date(iso).getTime() / 1000);
  return { seconds, nanos: 0 };
}

function normalizeMemo(data: any): any {
  if (!data) return data;
  const state = data.state ?? data.rowStatus;
  return {
    ...data,
    name: data.name || `memos/${data.id || data.uid}`,
    state: state === "ARCHIVED" || state === 2 ? 2 : 1,
    creator: data.creator || `users/${data.creatorId}`,
    createTime: isoToTimestamp(data.createTime),
    updateTime: isoToTimestamp(data.updateTime),
    visibility: stringToVisibility(data.visibility),
    pinned: data.pinned ?? false,
    content: data.content ?? "",
    tags: data.tags || [],
    attachments: (data.attachments || []).map(normalizeAttachment),
    relations: (data.relations || []).map(normalizeRelation),
    reactions: normalizeReactions(data.reactions || []),
    property: data.property || {},
    parent: data.parent || "",
    snippet: data.snippet || "",
    location: data.location || undefined,
  };
}

function normalizeUser(data: any): any {
  if (!data) return data;
  return {
    ...data,
    name: data.name || `users/${data.username}`,
    displayName: data.displayName ?? data.nickname ?? "",
    state: data.rowStatus === "ARCHIVED" ? 2 : 1,
    createTime: isoToTimestamp(data.createTime),
    updateTime: isoToTimestamp(data.updateTime),
    role: typeof data.role === "string" ? (data.role === "ADMIN" ? 2 : 3) : data.role,
  };
}

function normalizeAttachment(data: any): any {
  if (!data) return data;
  const memoName =
    data.memo ||
    (data.memoId !== undefined && data.memoId !== null ? `memos/${data.memoId}` : data.memo_id !== undefined && data.memo_id !== null ? `memos/${data.memo_id}` : undefined);
  return {
    ...data,
    name: data.name || `attachments/${data.id || data.uid}`,
    createTime: isoToTimestamp(data.createTime || data.created_ts),
    memo: memoName,
    externalLink: data.externalLink || data.external_link || "",
    motionMedia: data.motionMedia || data.motion_media,
  };
}

function normalizeRelation(data: any): any {
  if (!data) return data;
  return {
    ...data,
    memo: data.memo || (data.memo_id ? { name: `memos/${data.memo_id}`, snippet: "" } : undefined),
    relatedMemo:
      data.relatedMemo || (data.related_memo_id ? { name: `memos/${data.related_memo_id}`, snippet: "" } : undefined),
    type: typeof data.type === "string" ? (data.type === "COMMENT" ? 2 : 1) : data.type,
  };
}

function normalizeReactions(reactions: any[]): any[] {
  return reactions.map(normalizeReaction);
}

function normalizeReaction(r: any): any {
  return {
    ...r,
    createTime: isoToTimestamp(r.createTime || r.created_ts),
  };
}

function normalizeShare(s: any): any {
  return {
    ...s,
    name: s.name || `memos/${s.memo_id}/shares/${s.uid}`,
    createTime: s.created_ts ? { seconds: s.created_ts, nanos: 0 } : undefined,
    expireTime: s.expires_ts ? { seconds: s.expires_ts, nanos: 0 } : undefined,
  };
}

const IDENTITY_PROVIDER_NAME_PREFIX = "identity-providers/";
const LEGACY_IDENTITY_PROVIDER_NAME_PREFIX = "identityProviders/";

function buildIdentityProviderPayload(identityProvider: any, identityProviderId?: string): any {
  return {
    identityProviderId: identityProviderId || extractIdentityProviderUid(identityProvider?.name || ""),
    title: identityProvider?.title || "",
    type: normalizeIdentityProviderTypeForRequest(identityProvider?.type),
    identifierFilter: identityProvider?.identifierFilter ?? identityProvider?.identifier_filter ?? "",
    config: normalizeOAuth2Config(identityProvider?.config) || {},
  };
}

function normalizeIdentityProvider(data: any): any {
  if (!data) return data;

  const uid = data.uid || extractIdentityProviderUid(data.name || "");
  const rawName = typeof data.name === "string" ? data.name : "";
  const hasResourceName = rawName.startsWith(IDENTITY_PROVIDER_NAME_PREFIX) || rawName.startsWith(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX);
  const oauth2Config = normalizeOAuth2Config(data.config);
  const title =
    typeof data.title === "string" && data.title.trim() ? data.title : !hasResourceName && rawName.trim() ? rawName : uid || "OAuth2";

  return {
    ...data,
    name: normalizeIdentityProviderName(rawName, uid),
    title,
    type: normalizeIdentityProviderType(data.type),
    identifierFilter: data.identifierFilter ?? data.identifier_filter ?? "",
    config: wrapIdentityProviderConfig(oauth2Config),
  };
}

function normalizeLinkedIdentity(data: any): any {
  if (!data) return data;
  return {
    ...data,
    idpName: normalizeIdentityProviderName(data.idpName || ""),
  };
}

function normalizeIdentityProviderName(name: string, fallbackUid = ""): string {
  const uid = isIdentityProviderResourceName(name) ? extractIdentityProviderUid(name) : fallbackUid || name;
  return uid ? `${IDENTITY_PROVIDER_NAME_PREFIX}${uid}` : "";
}

function extractIdentityProviderUid(name: string): string {
  if (!name) return "";
  if (name.startsWith(IDENTITY_PROVIDER_NAME_PREFIX)) return name.slice(IDENTITY_PROVIDER_NAME_PREFIX.length);
  if (name.startsWith(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX)) return name.slice(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX.length);
  return name;
}

function isIdentityProviderResourceName(name: string): boolean {
  return name.startsWith(IDENTITY_PROVIDER_NAME_PREFIX) || name.startsWith(LEGACY_IDENTITY_PROVIDER_NAME_PREFIX);
}

function normalizeIdentityProviderType(value: any): number {
  if (typeof value === "number") {
    return value;
  }
  return typeof value === "string" && value.toLowerCase() === "oauth2" ? 1 : 0;
}

function normalizeIdentityProviderTypeForRequest(value: any): string {
  return normalizeIdentityProviderType(value) === 1 ? "oauth2" : "oauth2";
}

function normalizeOAuth2Config(value: any): any | undefined {
  const raw = unwrapOAuth2Config(value);
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const fieldMapping = raw.fieldMapping ?? raw.field_mapping ?? {};
  const config = {
    clientId: typeof raw.clientId === "string" ? raw.clientId : typeof raw.client_id === "string" ? raw.client_id : "",
    clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : typeof raw.client_secret === "string" ? raw.client_secret : "",
    authUrl: typeof raw.authUrl === "string" ? raw.authUrl : typeof raw.auth_url === "string" ? raw.auth_url : "",
    tokenUrl: typeof raw.tokenUrl === "string" ? raw.tokenUrl : typeof raw.token_url === "string" ? raw.token_url : "",
    userInfoUrl: typeof raw.userInfoUrl === "string" ? raw.userInfoUrl : typeof raw.user_info_url === "string" ? raw.user_info_url : "",
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map((scope: unknown) => String(scope)).filter(Boolean) : [],
    fieldMapping: {
      identifier: typeof fieldMapping.identifier === "string" ? fieldMapping.identifier : "",
      displayName:
        typeof fieldMapping.displayName === "string"
          ? fieldMapping.displayName
          : typeof fieldMapping.display_name === "string"
            ? fieldMapping.display_name
            : "",
      email: typeof fieldMapping.email === "string" ? fieldMapping.email : "",
      avatarUrl:
        typeof fieldMapping.avatarUrl === "string"
          ? fieldMapping.avatarUrl
          : typeof fieldMapping.avatar_url === "string"
            ? fieldMapping.avatar_url
            : "",
    },
  };

  return hasOAuth2Config(config) ? config : undefined;
}

function wrapIdentityProviderConfig(config: any): any {
  if (!config) {
    return {
      config: {
        case: undefined,
        value: undefined,
      },
    };
  }

  return {
    config: {
      case: "oauth2Config",
      value: config,
    },
  };
}

function hasOAuth2Config(config: any): boolean {
  return Boolean(
    config.clientId ||
      config.clientSecret ||
      config.authUrl ||
      config.tokenUrl ||
      config.userInfoUrl ||
      config.scopes.length > 0 ||
      config.fieldMapping.identifier ||
      config.fieldMapping.displayName ||
      config.fieldMapping.email ||
      config.fieldMapping.avatarUrl,
  );
}

function unwrapOAuth2Config(value: any): any {
  const parsed = parsePossiblyJson(value);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  if (parsed.config && typeof parsed.config === "object" && parsed.config.case === "oauth2Config" && parsed.config.value) {
    return parsed.config.value;
  }

  if (parsed.case === "oauth2Config" && parsed.value) {
    return parsed.value;
  }

  return parsed;
}

function parsePossiblyJson(value: any): any {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
