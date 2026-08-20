import { apiErrorMessage } from "@auto-harness/shared";

import type { RequestFunction } from "./request-types.ts";

export async function deleteCatalogResource(
  request: RequestFunction,
  url: string,
): Promise<string | null> {
  try {
    const response = await request(url, { method: "DELETE" });
    if (response.ok) return null;
    return apiErrorMessage(response);
  } catch (cause) {
    return cause instanceof Error && cause.message ? cause.message : "request failed";
  }
}
