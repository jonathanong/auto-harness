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

export async function apiGet<T>(path: string): Promise<T> {
  const forwarded = await incomingAuthHeaders();
  const res = await transport(`${apiBase()}${path}`, {
    cache: "no-store",
    ...(forwarded ? { headers: forwarded } : {}),
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
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

export function hostId(): string {
  return (
    process.env.HARNESS_HOST_ID?.trim() ||
    process.env.NEXT_PUBLIC_HARNESS_HOST_ID?.trim() ||
    LOCAL_HOST_ID
  );
}
