import { LOCAL_API_HTTP } from "./constants.ts";

/**
 * Resolve the control-plane base URL from env for server-side (RSC) fetches.
 * Accepts either an http(s) base or the ws(s) URL (LOCAL_API_WS shape) — the
 * websocket scheme/suffix is normalized to a plain http(s) origin.
 */
export function resolveServerApiBase(): string {
  const raw = process.env.HARNESS_API_HTTP ?? process.env.HARNESS_API_URL ?? LOCAL_API_HTTP;
  let base = raw.trim();
  if (base.startsWith("ws://")) {
    base = `http://${base.slice(5)}`;
  } else if (base.startsWith("wss://")) {
    base = `https://${base.slice(6)}`;
  }
  return base.replace(/\/ws\/?$/, "").replace(/\/$/, "");
}

/**
 * Browser: same-origin (Next.js rewrites `/api/*` to the control plane — no CORS).
 * Server (RSC): absolute control-plane URL via HARNESS_API_HTTP / HARNESS_API_URL.
 */
export function apiBase(): string {
  if (typeof window !== "undefined") {
    return "";
  }
  return resolveServerApiBase();
}

/** GET JSON from the control plane, resolving the base for either runtime. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}
