"use client";

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

/** Browser-side equivalent of apiGetAllPages that preserves HTTP error responses for callers. */
export async function apiFetchAllPages<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiFetchPageResult<T>> {
  const items: T[] = [];
  const seen = new Set<string>();
  let requestPath = path;
  while (true) {
    const response = await apiFetch(requestPath, init);
    if (!response.ok) return { response, items: [] };
    const page = (await response.json()) as { items?: T[]; nextCursor?: string | null };
    items.push(...(page.items ?? []));
    const cursor = page.nextCursor ?? null;
    if (!cursor) return { response, items };
    if (seen.has(cursor)) throw new Error(`repeated pagination cursor for ${path}`);
    seen.add(cursor);
    requestPath = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
  }
}
