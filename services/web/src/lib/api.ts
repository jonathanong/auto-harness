import { LOCAL_API_HTTP } from "@auto-harness/shared";

/** Resolve control-plane base for server-side fetches. */
function serverApiBase(): string {
  if (process.env.HARNESS_API_HTTP) {
    return process.env.HARNESS_API_HTTP.replace(/\/$/, "");
  }
  if (process.env.HARNESS_API_URL) {
    return process.env.HARNESS_API_URL.replace(/\/$/, "").replace(/\/ws$/, "");
  }
  return LOCAL_API_HTTP;
}

/**
 * Browser: same-origin (Next rewrite proxies to API — avoids CORS).
 * Server (RSC): absolute local API URL.
 */
export function apiBase(): string {
  if (typeof window !== "undefined") {
    return "";
  }
  return serverApiBase();
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}
