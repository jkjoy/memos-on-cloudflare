import { ROUTES } from "@/router/routes";

/** Query parameter used to preserve the intended destination across the auth flow. */
export const AUTH_REDIRECT_PARAM = "redirect";

/** Query parameter used to surface why the user was sent to the auth page. */
export const AUTH_REASON_PARAM = "reason";

/** Reason code signalling that the user hit a memo that requires authentication. */
export const AUTH_REASON_PROTECTED_MEMO = "protected-memo";

const REDIRECT_BASE_URL = "https://memos.invalid";
const UNSAFE_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/**
 * Validates a post-authentication redirect target.
 *
 * Returns the path when it is a safe same-origin internal destination, otherwise `undefined`.
 * Rejected targets include: non-string / empty, protocol-relative URLs (`//host`), absolute URLs,
 * and any auth-family route (`/auth`, `/auth/callback`, …) which must not be a landing target
 * after sign-in.
 */
export function getSafeRedirectPath(path: string | null | undefined): string | undefined {
  if (typeof path !== "string" || !path) {
    return undefined;
  }

  if (!path.startsWith("/") || path.startsWith("//") || UNSAFE_PATH_CHARACTERS.test(path)) {
    return undefined;
  }

  try {
    const url = new URL(path, REDIRECT_BASE_URL);
    const decodedPath = decodeURIComponent(url.pathname);
    if (url.origin !== REDIRECT_BASE_URL || url.pathname.startsWith("//") || UNSAFE_PATH_CHARACTERS.test(decodedPath)) {
      return undefined;
    }

    // The browser and router both normalize paths. Check decoded path segments
    // too so encoded separators cannot hide an external or auth-family target.
    const normalizedPath = new URL(decodedPath, REDIRECT_BASE_URL);
    if (normalizedPath.origin !== REDIRECT_BASE_URL || normalizedPath.pathname.startsWith("//")) {
      return undefined;
    }
    const pathname = normalizedPath.pathname.toLowerCase();
    if (pathname === ROUTES.AUTH || pathname.startsWith(`${ROUTES.AUTH}/`)) {
      return undefined;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

/**
 * Builds a URL pointing at the auth entry page, optionally embedding a validated
 * `redirect` target and a machine-readable `reason` code.
 */
export function buildAuthRoute(options?: { redirect?: string | null; reason?: string | null }): string {
  const searchParams = new URLSearchParams();
  const redirectPath = getSafeRedirectPath(options?.redirect);

  if (redirectPath) {
    searchParams.set(AUTH_REDIRECT_PARAM, redirectPath);
  }

  if (options?.reason) {
    searchParams.set(AUTH_REASON_PARAM, options.reason);
  }

  const search = searchParams.toString();
  return search ? `${ROUTES.AUTH}?${search}` : ROUTES.AUTH;
}

const PUBLIC_ROUTE_PREFIXES = [
  ROUTES.AUTH, // Authentication pages
  ROUTES.EXPLORE, // Explore page
  `${ROUTES.SHARED_MEMO}/`, // Shared memo pages (share-link viewer)
  "/u/", // User profile pages (dynamic)
  "/memos/", // Individual memo detail pages (dynamic)
] as const;

/**
 * Reports whether a given pathname corresponds to a page that unauthenticated
 * visitors are allowed to view without being bounced to the auth page.
 */
export function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some((route) => path.startsWith(route));
}
