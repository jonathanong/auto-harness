import type { SessionArchiveReadResponse } from "@auto-harness/shared";

/** Validate the untrusted archive status response before exposing a signed URL to the DOM. */
export function isSessionArchiveReadResponse(value: unknown): value is SessionArchiveReadResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as {
    state?: unknown;
    downloadUrl?: unknown;
    expiresAt?: unknown;
    contentType?: unknown;
    bodyBytes?: unknown;
  };
  if (candidate.state === "dynamodb" || candidate.state === "unavailable") return true;
  return (
    candidate.state === "archived" &&
    typeof candidate.downloadUrl === "string" &&
    typeof candidate.expiresAt === "string" &&
    typeof candidate.contentType === "string" &&
    typeof candidate.bodyBytes === "number" &&
    Number.isFinite(candidate.bodyBytes) &&
    candidate.bodyBytes >= 0
  );
}
