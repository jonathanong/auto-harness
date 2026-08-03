import { LOCAL_AGENT_ID, LOCAL_API_HTTP } from "@auto-harness/shared";

function serverApiBase(): string {
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
 * Browser: same-origin via Next rewrite (no CORS).
 * Server: absolute control-plane URL.
 */
export function apiBase(): string {
  if (typeof window !== "undefined") {
    return "";
  }
  return serverApiBase();
}

export function agentId(): string {
  return (
    process.env.HARNESS_AGENT_ID?.trim() ||
    process.env.NEXT_PUBLIC_HARNESS_AGENT_ID?.trim() ||
    LOCAL_AGENT_ID
  );
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}
