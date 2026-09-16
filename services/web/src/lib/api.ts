import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  apiBase,
  CLOUDFRONT_INGRESS_TOKEN_HEADER,
  collectCursorPages,
  MAX_CURSOR_PAGES,
} from "@auto-harness/shared";

export class ApiError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`GET ${path} → ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiGet<T>(
  path: string,
  options?: { redirectOnUnauthorized?: boolean },
): Promise<T> {
  const fetchHeaders = await requestFetchHeaders();
  const res = await fetch(`${apiBase()}${path}`, {
    cache: "no-store",
    ...(fetchHeaders ? { headers: fetchHeaders } : {}),
  });
  if (
    res.status === 401 &&
    process.env.HARNESS_AUTH_MODE === "required" &&
    options?.redirectOnUnauthorized !== false
  ) {
    redirect("/login");
  }
  if (!res.ok) throw new ApiError(path, res.status);
  return (await res.json()) as T;
}

/** Follow an opaque API cursor until the complete catalog has been loaded. */
export async function apiGetAllPages<T>(path: string): Promise<T[]> {
  return collectCursorPages<T>(path, (requestPath) => apiGet(requestPath));
}

/**
 * Load the first page containing items, preserving its continuation cursor.
 *
 * Session queries can return empty pages while a cursor is advancing through sparse
 * partitions. Bounded displays (such as the dashboard) need to advance past those
 * pages without fetching the entire history.
 */
export async function apiGetFirstPageWithItems<T>(
  path: string,
  hasMatchingItem: (item: T) => boolean = () => true,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const seen = new Set<string>();
  let requestPath = path;
  for (let pageCount = 0; pageCount < MAX_CURSOR_PAGES; pageCount += 1) {
    const page = await apiGet<{ items?: T[]; nextCursor?: string | null }>(requestPath);
    const items = page.items ?? [];
    const nextCursor = page.nextCursor ?? null;
    if (items.some(hasMatchingItem) || nextCursor === null) return { items, nextCursor };
    if (seen.has(nextCursor)) throw new Error(`repeated pagination cursor for ${path}`);
    seen.add(nextCursor);
    requestPath = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`;
  }
  throw new Error(`pagination exceeded ${MAX_CURSOR_PAGES} pages for ${path}`);
}

/**
 * Merge forwarded auth with the CloudFront ingress token (mirrors proxy.ts).
 * apiBase() resolves to HARNESS_API_HTTP server-side, the raw API Gateway URL that
 * bypasses CloudFront, so its REQUEST authorizer needs this header to admit the
 * call. Built as one object — rather than spreading `incomingAuthHeaders()` and the
 * token separately onto the fetch init — so the token is still sent when there is
 * no forwarded cookie/authorization (that case previously returned `undefined` and
 * `headers` was omitted from the fetch entirely, dropping the token with it).
 */
async function requestFetchHeaders(): Promise<Record<string, string> | undefined> {
  const forwarded = await incomingAuthHeaders();
  const ingressToken = process.env.HARNESS_CLOUDFRONT_INGRESS_TOKEN;
  const combined = {
    ...forwarded,
    ...(ingressToken ? { [CLOUDFRONT_INGRESS_TOKEN_HEADER]: ingressToken } : {}),
  };
  return Object.keys(combined).length > 0 ? combined : undefined;
}

async function incomingAuthHeaders(): Promise<Record<string, string> | undefined> {
  if (typeof window !== "undefined") return undefined;
  try {
    const requestHeaders = await headers();
    const cookie = requestHeaders.get("cookie");
    const authorization = requestHeaders.get("authorization");
    if (!cookie && !authorization) return undefined;
    return { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) };
  } catch {
    // Static rendering and unit tests do not have a Next request context.
    return undefined;
  }
}
