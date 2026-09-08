import { headers } from "next/headers";
import {
  apiBase,
  collectCursorPages,
  LOCAL_HOST_ID,
  MAX_CURSOR_PAGES,
  type CursorPage,
} from "@auto-harness/shared";

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
  return collectCursorPages<T>(path, (requestPath) => apiGet(requestPath));
}

/** Skip sparse nonterminal pages, stopping once the first page with items is found. */
export async function apiGetFirstNonEmptyPage<T>(path: string): Promise<T[]> {
  return apiGetFirstMatchingPage(path, () => true);
}

/** Skip pages without a matching item, stopping at the first matching page. */
export async function apiGetFirstMatchingPage<T>(
  path: string,
  matches: (item: T) => boolean,
): Promise<T[]> {
  const seen = new Set<string>();
  let requestPath = path;
  for (let pageCount = 0; pageCount < MAX_CURSOR_PAGES; pageCount += 1) {
    const page = await apiGet<CursorPage<T>>(requestPath);
    const items = page.items ?? [];
    const matchingItems = items.filter(matches);
    const cursor = page.nextCursor ?? null;
    if (matchingItems.length > 0 || !cursor) return matchingItems;
    if (seen.has(cursor)) throw new Error(`repeated pagination cursor for ${path}`);
    seen.add(cursor);
    requestPath = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
  }
  throw new Error(`pagination exceeded ${MAX_CURSOR_PAGES} pages for ${path}`);
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
