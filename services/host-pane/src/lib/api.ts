import { LOCAL_HOST_ID } from "@auto-harness/shared";

import { headers } from "next/headers";
import { apiBase } from "@auto-harness/shared";

type ApiTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const defaultTransport: ApiTransport = (input, init) => fetch(input, init);
let transport = defaultTransport;

/** Inject an in-memory transport for route tests without replacing global fetch. */
export function setApiTransportForTests(next: ApiTransport | undefined): void {
  transport = next ?? defaultTransport;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`GET ${path} → ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isUnauthenticatedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export async function apiGet<T>(path: string): Promise<T> {
  const forwarded = await incomingAuthHeaders();
  const res = await transport(`${apiBase()}${path}`, {
    cache: "no-store",
    ...(forwarded ? { headers: forwarded } : {}),
  });
  if (!res.ok) throw new ApiError(path, res.status);
  return (await res.json()) as T;
}

/** Follow an opaque API cursor until the complete catalog has been loaded. */
export async function apiGetAllPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let requestPath = path;
  while (true) {
    const page = await apiGet<{ items?: T[]; nextCursor?: string | null }>(requestPath);
    items.push(...(page.items ?? []));
    const cursor = page.nextCursor ?? null;
    if (!cursor) return items;
    if (seen.has(cursor)) throw new Error(`repeated pagination cursor for ${path}`);
    seen.add(cursor);
    requestPath = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
  }
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

export function hostId(): string {
  return (
    process.env.HARNESS_HOST_ID?.trim() ||
    process.env.NEXT_PUBLIC_HARNESS_HOST_ID?.trim() ||
    LOCAL_HOST_ID
  );
}
