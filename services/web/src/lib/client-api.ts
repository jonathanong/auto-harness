"use client";

import { collectCursorPages } from "@auto-harness/shared";

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
  let response!: Response;
  const items = await collectCursorPages<T>(path, async (requestPath) => {
    response = await apiFetch(requestPath, init);
    return response.ok ? response.json() : {};
  });
  return { response, items };
}
