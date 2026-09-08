"use client";

import { collectCursorPages, MAX_CURSOR_PAGES } from "@auto-harness/shared";

import { loginPath } from "./auth-session.ts";

/** Browser API client: same-origin cookies plus a usable expired-session escape hatch. */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { redirectOnUnauthorized?: boolean } = {},
): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: init?.credentials ?? "same-origin" });
  if (
    options.redirectOnUnauthorized !== false &&
    response.status === 401 &&
    typeof window !== "undefined"
  ) {
    window.location.assign(loginPath(`${window.location.pathname}${window.location.search}`));
  }
  return response;
}

type ApiFetchPageResult<T> = { response: Response; items: T[] };

export type ApiFetchItemPageResult<T> = {
  response: Response;
  items: T[];
  nextCursor: string | null;
};

/** Browser-side equivalent of apiGetAllPages that preserves HTTP error responses for callers. */
export async function apiFetchAllPages<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiFetchPageResult<T>> {
  let response!: Response;
  const items = await collectCursorPages<T>(path, async (requestPath) => {
    response = await apiFetch(requestPath, init);
    return response.ok ? response.json() : {};
  });
  return { response, items };
}

/** Load the first non-empty page, retaining its cursor for bounded dashboard displays. */
export async function apiFetchFirstPageWithItems<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiFetchItemPageResult<T>> {
  const seen = new Set<string>();
  let requestPath = path;
  for (let pageCount = 0; pageCount < MAX_CURSOR_PAGES; pageCount += 1) {
    const response = await apiFetch(requestPath, init);
    if (!response.ok) return { response, items: [], nextCursor: null };
    const data = (await response.json()) as { items?: T[]; nextCursor?: string | null };
    const items = data.items ?? [];
    const nextCursor = data.nextCursor ?? null;
    if (items.length > 0 || nextCursor === null) return { response, items, nextCursor };
    if (seen.has(nextCursor)) throw new Error(`repeated pagination cursor for ${path}`);
    seen.add(nextCursor);
    requestPath = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`;
  }
  throw new Error(`pagination exceeded ${MAX_CURSOR_PAGES} pages for ${path}`);
}
