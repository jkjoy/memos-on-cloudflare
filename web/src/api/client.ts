import { getAccessToken, hasStoredToken, isTokenExpired, setAccessToken, REQUEST_TOKEN_EXPIRY_BUFFER_MS } from "../auth-state";
import i18n from "../i18n";
import { redirectOnAuthFailure } from "../utils/auth-redirect";

let isRefreshing = false;
let refreshPromise: Promise<void> | null = null;

async function doRefresh(): Promise<void> {
  const resp = await fetch("/api/v1/auth/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!resp.ok) throw new Error("Refresh failed");
  const data = await resp.json();
  if (data.accessToken) {
    const expiresAt = data.expiresAt ? new Date(data.expiresAt * 1000) : undefined;
    setAccessToken(data.accessToken, expiresAt);
  }
}

export async function refreshAccessToken(): Promise<void> {
  if (isRefreshing && refreshPromise) return refreshPromise;
  isRefreshing = true;
  refreshPromise = doRefresh().finally(() => {
    isRefreshing = false;
    refreshPromise = null;
  });
  return refreshPromise;
}

async function getRequestToken(): Promise<string | null> {
  let token = getAccessToken();
  if (!token) {
    if (!hasStoredToken()) return null;
    try {
      await refreshAccessToken();
      token = getAccessToken();
    } catch {
      return null;
    }
    return token;
  }
  if (isTokenExpired(REQUEST_TOKEN_EXPIRY_BUFFER_MS)) {
    try {
      await refreshAccessToken();
      token = getAccessToken();
    } catch {
      // keep existing token, let 401 handler retry
    }
  }
  return token;
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { isFormData?: boolean }
): Promise<T> {
  const token = await getRequestToken();
  const headers: Record<string, string> = {};

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let reqBody: BodyInit | undefined;
  if (body !== undefined) {
    if (options?.isFormData) {
      reqBody = body as FormData;
    } else {
      headers["Content-Type"] = "application/json";
      reqBody = JSON.stringify(body);
    }
  }

  let resp = await fetch(path, {
    method,
    headers,
    body: reqBody,
    credentials: "include",
  });

  if (resp.status === 401 && token) {
    try {
      await refreshAccessToken();
      const newToken = getAccessToken();
      if (newToken) {
        headers["Authorization"] = `Bearer ${newToken}`;
        resp = await fetch(path, {
          method,
          headers,
          body: reqBody,
          credentials: "include",
        });
      }
    } catch {
      redirectOnAuthFailure();
      throw new Error("Authentication failed");
    }
  }

  if (!resp.ok) {
    const errorData = await resp.json().catch(() => ({ error: resp.statusText }));
    const translatedMessage =
      errorData.errorKey && typeof errorData.errorKey === "string"
        ? i18n.t(errorData.errorKey, (errorData.errorParams as Record<string, unknown>) || {})
        : undefined;
    const err = new Error(translatedMessage || errorData.error || `HTTP ${resp.status}`);
    (err as any).serverMessage = errorData.error || `HTTP ${resp.status}`;
    (err as any).errorKey = errorData.errorKey;
    (err as any).errorParams = errorData.errorParams;
    (err as any).code = resp.status === 401 ? 16 : resp.status === 403 ? 7 : resp.status === 404 ? 5 : 2;
    throw err;
  }

  if (resp.status === 204) return {} as T;
  return resp.json();
}

export function buildQueryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
