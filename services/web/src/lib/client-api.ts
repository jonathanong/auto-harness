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
