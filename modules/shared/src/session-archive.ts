/** Public availability contract for a session's durable terminal transcript. */
export type SessionArchiveReadResponse =
  | { state: "dynamodb" }
  | {
      state: "archived";
      downloadUrl: string;
      expiresAt: string;
      contentType: string;
      bodyBytes: number;
    }
  | { state: "unavailable" };
