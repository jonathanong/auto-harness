/** Public availability contract for a session's durable terminal transcript. */
export type SessionArchiveIncompleteReason =
  | "content-length-mismatch"
  | "content-type-mismatch"
  | "content-length-and-type-mismatch"
  | "version-id-missing"
  | "version-id-mismatch";

export type SessionArchiveReadResponse =
  | { state: "dynamodb" }
  | {
      state: "archived";
      downloadUrl: string;
      expiresAt: string;
      contentType: string;
      bodyBytes: number;
    }
  | { state: "incomplete"; reason: SessionArchiveIncompleteReason }
  | { state: "expired" }
  | { state: "unavailable" };
