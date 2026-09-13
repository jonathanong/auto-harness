import type { SessionArchiveReadResponse } from "@auto-harness/shared";

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Validate the untrusted archive status response before exposing a signed URL to the DOM. */
export function isSessionArchiveReadResponse(value: unknown): value is SessionArchiveReadResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as {
    state?: unknown;
    downloadUrl?: unknown;
    expiresAt?: unknown;
    contentType?: unknown;
    bodyBytes?: unknown;
    reason?: unknown;
  };
  if (
    candidate.state === "dynamodb" ||
    candidate.state === "expired" ||
    candidate.state === "unavailable"
  ) {
    return true;
  }
  if (
    candidate.state === "incomplete" &&
    (candidate.reason === "content-length-mismatch" ||
      candidate.reason === "content-type-mismatch" ||
      candidate.reason === "content-length-and-type-mismatch" ||
      candidate.reason === "version-id-missing" ||
      candidate.reason === "version-id-mismatch")
  ) {
    return true;
  }
  return (
    candidate.state === "archived" &&
    isHttpsUrl(candidate.downloadUrl) &&
    typeof candidate.expiresAt === "string" &&
    typeof candidate.contentType === "string" &&
    typeof candidate.bodyBytes === "number" &&
    Number.isFinite(candidate.bodyBytes) &&
    candidate.bodyBytes >= 0
  );
}
