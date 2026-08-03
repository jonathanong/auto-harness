export function apiBase(): string {
  const raw =
    process.env.HARNESS_API_HTTP ??
    process.env.NEXT_PUBLIC_HARNESS_API_HTTP ??
    process.env.HARNESS_API_URL ??
    process.env.NEXT_PUBLIC_HARNESS_API_URL ??
    "http://127.0.0.1:7420";
  let base = raw.trim();
  if (base.startsWith("ws://")) {
    base = `http://${base.slice(5)}`;
  } else if (base.startsWith("wss://")) {
    base = `https://${base.slice(6)}`;
  }
  return base.replace(/\/ws\/?$/, "").replace(/\/$/, "");
}

export function agentId(): string {
  const id = process.env.HARNESS_AGENT_ID ?? process.env.NEXT_PUBLIC_HARNESS_AGENT_ID ?? "";
  if (!id) {
    throw new Error("HARNESS_AGENT_ID is required for the agent pane");
  }
  return id;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}
