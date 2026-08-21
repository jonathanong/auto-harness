import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { apiBase } from "@auto-harness/shared";

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
  const forwarded = await incomingAuthHeaders();
  const res = await fetch(`${apiBase()}${path}`, {
    cache: "no-store",
    ...(forwarded ? { headers: forwarded } : {}),
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
