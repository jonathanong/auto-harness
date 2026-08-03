/** Browser + server client for the local control plane API. */

export function apiBase(): string {
  if (typeof process !== "undefined" && process.env.HARNESS_API_HTTP) {
    return process.env.HARNESS_API_HTTP.replace(/\/$/, "");
  }
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_HARNESS_API_HTTP) {
    return process.env.NEXT_PUBLIC_HARNESS_API_HTTP.replace(/\/$/, "");
  }
  return "http://127.0.0.1:7420";
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}
