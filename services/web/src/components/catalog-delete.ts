import type { RequestFunction } from "./request-types.ts";

export async function deleteCatalogResource(
  request: RequestFunction,
  url: string,
): Promise<string | null> {
  try {
    const response = await request(url, { method: "DELETE" });
    if (response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return body?.error?.message ?? `request failed (${response.status})`;
  } catch (cause) {
    return cause instanceof Error && cause.message ? cause.message : "request failed";
  }
}
