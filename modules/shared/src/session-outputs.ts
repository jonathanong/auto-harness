/** Agent-written output is separate from the harness's summary/branch result. */
export const MAX_SESSION_OUTPUT_BYTES = 256 * 1024;
export const MAX_SESSION_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_SESSION_ARTIFACT_SOURCE_BYTES = 1024 * 1024 * 1024;
export const MAX_SESSION_ARTIFACT_FILES = 10_000;
export const SESSION_OUTPUT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS = 60;
export const SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export type SessionOutputError = { code: string; message: string };
export type SessionOutputUnavailable =
  | { state: "unsupported" | "pending" | "none" }
  | { state: "error"; error: SessionOutputError };

export type SessionOutputResponse =
  | SessionOutputUnavailable
  | { state: "ready"; output: unknown; capturedAt: string };

export type SessionArtifactsResponse =
  | SessionOutputUnavailable
  | {
      state: "ready";
      downloadUrl: string;
      expiresAt: string;
      capturedAt: string;
      contentType: "application/gzip";
      filename: "artifacts.tar.gz";
      compressedBytes: number;
      sha256: string;
    };

export type SessionOutputSubmission =
  | { state: "none" }
  | { state: "error"; error: SessionOutputError }
  | { state: "ready"; jsonText: string; sha256: string };

export type SessionArtifactsSubmission =
  | { state: "none" }
  | { state: "error"; error: SessionOutputError }
  | {
      state: "pending";
      compressedBytes: number;
      sourceBytes: number;
      fileCount: number;
      sha256: string;
    };

/** Daemon-only POST /sessions/:id/outputs/prepare. */
export type PrepareSessionOutputsRequest = {
  attemptId: string;
  capturedAt: string;
  output: SessionOutputSubmission;
  artifacts: SessionArtifactsSubmission;
};

export type SessionArtifactUpload =
  | { method: "POST"; url: string; fields: Record<string, string>; expiresAt: string }
  | { method: "PUT"; url: string; headers: Record<string, string>; expiresAt: string };

export type PrepareSessionOutputsResponse = {
  /** No upload is required for absent/error/already-committed artifacts. */
  artifactUpload?: SessionArtifactUpload;
};

/** Daemon-only POST /sessions/:id/outputs/complete. */
export type CompleteSessionOutputsRequest = { attemptId: string };
